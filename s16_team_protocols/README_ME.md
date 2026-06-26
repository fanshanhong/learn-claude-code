# s16: Team Protocols 深度解析

## 目录
- [架构设计](#架构设计)
- [整体思想](#整体思想)
- [实现细节](#实现细节)
- [实际应用场景](#实际应用场景)
- [与其他模块的关系](#与其他模块的关系)
- [优缺点分析](#优缺点分析)
- [最佳实践](#最佳实践)

---

## 架构设计

### 1. 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                          Lead Agent                              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Protocol Tools                                            │   │
│  │  - request_shutdown                                       │   │
│  │  - request_plan                                           │   │
│  │  - review_plan                                            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                           ↓                                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Pending Requests (状态追踪)                              │   │
│  │  pending_requests[request_id] → ProtocolState            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                           ↓                                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  consume_lead_inbox (统一消息消费)                       │   │
│  │  - 路由协议消息 (match_response)                         │   │
│  │  - 返回普通消息                                          │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                           ↕ (MessageBus)
┌─────────────────────────────────────────────────────────────────┐
│                        Teammate Agent                            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Idle Loop (等待而不是退出)                               │   │
│  │  - 轮询 inbox                                             │   │
│  │  - 处理 shutdown_request                                 │   │
│  │  - 处理 plan_approval_response                           │   │
│  └──────────────────────────────────────────────────────────┘   │
│                           ↓                                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  dispatch_message (消息路由)                              │   │
│  │  - 按消息类型分发到处理器                                 │   │
│  │  - 返回是否应该停止                                       │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 2. 核心组件关系

| 组件 | 职责 | 数据流 |
|------|------|--------|
| **ProtocolState** | 存储协议请求的状态 | 被创建 → 状态更新 → 最终状态 |
| **pending_requests** | 全局字典，追踪所有进行中的请求 | request_id → ProtocolState |
| **match_response** | 通过 request_id 关联响应与请求 | response → 找到 request → 更新状态 |
| **dispatch_message** | 按消息类型路由到处理器 | inbox message → handler → response |
| **consume_lead_inbox** | Lead 的统一 inbox 消费者 | inbox → 协议路由 + 普通消息 |
| **idle loop** | 队友的等待循环 | LLM 非工具调用 → 等待 → 处理消息 |

### 3. 协议类型

```python
# 两种协议，一套机制
协议类型 = {
    "shutdown": {
        "request": "shutdown_request",
        "response": "shutdown_response",
        "方向": "Lead → 队友",
        "用途": "体面关机握手"
    },
    "plan_approval": {
        "request": "plan_approval_request",
        "response": "plan_approval_response",
        "方向": "队友 → Lead",
        "用途": "计划审批协议"
    }
}
```

---

## 整体思想

### 1. 设计理念

**问题背景**：s15 的团队协作是"松散"的
- Lead 发消息，队友回复，没有结构化协议
- 缺乏明确的握手确认机制
- 关键操作（如关机、高风险操作）没有审批流程

**设计哲学**：
1. **结构化协议**：用明确的请求-响应模式替代松散的文本消息
2. **状态机驱动**：每个请求有明确的生命周期（pending → approved/rejected）
3. **可追溯性**：通过 request_id 关联整个协议流程
4. **类型安全**：响应类型必须匹配请求类型，避免误操作

### 2. 核心概念

#### (1) Request ID 作为关联键

```python
# request_id 贯穿整个协议流程
① 发请求时创建
   req_id = "req_004281"
   pending_requests[req_id] = ProtocolState(status="pending")

② 请求带着它出去
   BUS.send("shutdown_request", metadata={"request_id": req_id})

③ 回复带着它回来
   BUS.send("shutdown_response", metadata={"request_id": req_id})

④ 通过它关联状态
   state = pending_requests[req_id]
   state.status = "approved"
```

**为什么重要**：
- 在异步环境中，请求和响应可能在不同时间点发生
- request_id 是唯一的"信物"，确保响应能找到对应的请求
- 支持多个并发请求，每个都有独立的追踪链路

#### (2) 状态机模型

```python
状态转换图：
    ┌─────────┐
    │ pending │
    └────┬────┘
         │
    ┌────┴────┐
    ↓         ↓
┌─────────┐ ┌──────────┐
│approved │ │ rejected │
└─────────┘ └──────────┘

代码实现：
state.status = "pending"  # 初始状态
# ... 等待响应 ...
state.status = "approved" if approve else "rejected"  # 终态
```

**防重入保护**：
```python
if state.status != "pending":
    return  # 已经 resolved，忽略重复响应
```

#### (3) 类型校验机制

```python
def match_response(response_type, request_id, approve):
    state = pending_requests.get(request_id)

    # 类型校验：确保响应类型匹配请求类型
    if state.type == "shutdown" and response_type != "shutdown_response":
        return  # 类型不匹配，忽略

    if state.type == "plan_approval" and response_type != "plan_approval_response":
        return  # 类型不匹配，忽略

    # 更新状态
    state.status = "approved" if approve else "rejected"
```

**为什么需要类型校验**：
- 一个 shutdown_response 不应该意外 approve 一个 plan_approval 请求
- 防止消息误投递导致的错误状态转换
- 确保协议的语义正确性

### 3. 要解决的问题

#### (1) 关机握手

**问题**：直接杀线程，队友写了一半的文件留在磁盘上

**解决**：
```
Lead 发送 shutdown_request
     ↓
队友收到请求
     ↓
队友完成收尾工作（关闭文件、保存状态）
     ↓
队友发送 shutdown_response (approve=True)
     ↓
Lead 确认关机完成
```

#### (2) 计划审批

**问题**：队友想重构认证模块，属于高风险操作，应该先审批

**解决**：
```
队友发送 plan_approval_request (附带计划内容)
     ↓
Lead 收到请求，查看计划
     ↓
Lead 决定 approve/reject
     ↓
Lead 发送 plan_approval_response
     ↓
队友根据审批结果执行或修改计划
```

---

## 实现细节

### 1. ProtocolState 数据结构

```python
@dataclass
class ProtocolState:
    """协议请求状态记录"""
    request_id: str      # 唯一 ID，如 "req_004281"
    type: str            # "shutdown" | "plan_approval"
    sender: str          # 发起方（"lead" 或队友名）
    target: str          # 接收方（队友名或 "lead"）
    status: str          # "pending" | "approved" | "rejected"
    payload: str         # 计划文本或关机原因
    created_at: float    # 创建时间戳

# 全局存储
pending_requests: dict[str, ProtocolState] = {}
```

**设计要点**：
- `request_id`：唯一标识，支持并发请求
- `type`：协议类型，用于类型校验
- `status`：状态机状态，只允许单向转换
- `payload`：携带业务数据（如计划文本）
- `created_at`：支持超时检测（教学版未实现）

### 2. 四步协议流程（关机示例）

```python
# 步骤 1: Lead 发请求
def run_request_shutdown(teammate: str) -> str:
    req_id = new_request_id()  # 生成唯一 ID

    # 创建状态记录
    pending_requests[req_id] = ProtocolState(
        request_id=req_id,
        type="shutdown",
        sender="lead",
        target=teammate,
        status="pending",
        payload=""
    )

    # 发送协议消息
    BUS.send("lead", teammate, "Please shut down gracefully.",
             "shutdown_request",
             {"request_id": req_id})

    return f"Shutdown request sent to {teammate} (req: {req_id})"

# 步骤 2: 队友收到并路由
def handle_inbox_message(name: str, msg: dict, messages: list) -> bool:
    msg_type = msg.get("type", "message")
    req_id = msg.get("metadata", {}).get("request_id", "")

    # 按类型路由到处理器
    if msg_type == "shutdown_request":
        # 步骤 3: 队友回复
        BUS.send(name, "lead", "Shutting down gracefully.",
                 "shutdown_response",
                 {"request_id": req_id, "approve": True})
        return True  # 停止循环

    return False  # 继续循环

# 步骤 4: Lead 收响应并匹配
def consume_lead_inbox(route_protocol: bool = True) -> list[dict]:
    msgs = BUS.read_inbox("lead")

    if route_protocol:
        for msg in msgs:
            meta = msg.get("metadata", {})
            req_id = meta.get("request_id", "")
            msg_type = msg.get("type", "")

            if req_id and msg_type.endswith("_response"):
                approve = meta.get("approve", False)
                # 更新状态
                match_response(msg_type, req_id, approve)

    return msgs
```

### 3. dispatch_message 消息路由

```python
def handle_inbox_message(name: str, msg: dict, messages: list) -> bool:
    """分发收件箱消息，返回是否应该停止"""
    msg_type = msg.get("type", "message")
    meta = msg.get("metadata", {})
    req_id = meta.get("request_id", "")

    # 协议消息路由
    if msg_type == "shutdown_request":
        # 关机请求 → 回复确认 → 返回 True 停止循环
        BUS.send(name, "lead", "Shutting down gracefully.",
                 "shutdown_response",
                 {"request_id": req_id, "approve": True})
        return True

    if msg_type == "plan_approval_response":
        # 计划审批响应 → 注入消息到对话历史 → 继续 LLM turn
        approve = meta.get("approve", False)
        if approve:
            messages.append({
                "role": "user",
                "content": "[Plan approved] Proceed with the task."
            })
        else:
            messages.append({
                "role": "user",
                "content": f"[Plan rejected] Feedback: {msg['content']}"
            })
        return False

    # 普通消息 → 添加到历史
    return False
```

**设计要点**：
- 单一入口处理所有消息类型
- 返回值决定是否停止队友循环
- 易于扩展新的协议类型

### 4. idle loop 实现

```python
def run():  # 队友线程主循环
    messages = [{"role": "user", "content": prompt}]

    shutdown_requested = False
    while not shutdown_requested:
        # 1. 检查 inbox
        inbox = BUS.read_inbox(name)
        should_stop = False
        non_protocol = []

        for msg in inbox:
            if msg.get("type") in ("shutdown_request", "plan_approval_response"):
                should_stop = handle_inbox_message(name, msg, messages)
                if should_stop:
                    break
            else:
                non_protocol.append(msg)

        if should_stop:
            shutdown_requested = True
            break

        # 2. 将普通消息注入历史
        if non_protocol:
            inbox_json = json.dumps(non_protocol)
            messages.append({
                "role": "user",
                "content": "<inbox>" + inbox_json + "</inbox>"
            })

        # 3. LLM turn
        response = client.messages.create(
            model=MODEL, system=system, messages=messages[-20:],
            tools=sub_tools, max_tokens=8000
        )

        messages.append({"role": "assistant", "content": response.content})

        # 4. 如果 LLM 不调用工具 → 进入 idle
        if response.stop_reason != "tool_use":
            # Idle: 等待 inbox 消息
            while not shutdown_requested:
                time.sleep(1)
                inbox = BUS.read_inbox(name)

                if not inbox:
                    continue

                for msg in inbox:
                    if msg.get("type") in ("shutdown_request", "plan_approval_response"):
                        should_stop = handle_inbox_message(name, msg, messages)
                        if should_stop:
                            shutdown_requested = True
                            break
                    else:
                        non_protocol.append(msg)

                if shutdown_requested:
                    break

                if non_protocol:
                    # 有新消息 → 回到主循环继续 LLM turn
                    inbox_json = json.dumps(non_protocol)
                    messages.append({
                        "role": "user",
                        "content": "<inbox>" + inbox_json + "</inbox>"
                    })
                    break

        # 5. 执行工具调用
        results = []
        for block in response.content:
            if block.type == "tool_use":
                output = handler(**block.input)
                results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": str(output)
                })
        messages.append({"role": "user", "content": results})

    # 6. 发送最终总结
    BUS.send(name, "lead", summary, "result")
    active_teammates.pop(name, None)
```

**关键点**：
- s15 的队友跑完 10 轮就退出
- s16 的队友在 LLM 返回非 tool_use 后进入 idle 等待
- idle 时轮询 inbox，收到消息后继续工作或关机

### 5. 统一 inbox 消费

```python
def consume_lead_inbox(route_protocol: bool = True) -> list[dict]:
    """统一 Lead inbox 消费者

    为什么需要统一？
    - check_inbox 工具会读 inbox
    - 主循环末尾也会读 inbox
    - 如果分别读，协议消息可能被读走但没路由到 match_response
    """
    msgs = BUS.read_inbox("lead")

    if not msgs:
        return []

    if route_protocol:
        for msg in msgs:
            meta = msg.get("metadata", {})
            req_id = meta.get("request_id", "")
            msg_type = msg.get("type", "")

            # 路由协议响应
            if req_id and msg_type.endswith("_response"):
                approve = meta.get("approve", False)
                match_response(msg_type, req_id, approve)

    return msgs

# 两处调用都使用这个函数
def run_check_inbox() -> str:
    msgs = consume_lead_inbox(route_protocol=True)
    # ...

# 主循环末尾
inbox_msgs = consume_lead_inbox(route_protocol=True)
if inbox_msgs:
    history.append({"role": "user", "content": inbox_text})
```

### 6. request_id 生成

```python
def new_request_id() -> str:
    """生成唯一的请求 ID

    格式：req_{6位随机数字}
    示例：req_004281, req_999123
    """
    return f"req_{random.randint(0, 999999):06d}"
```

**生产环境改进**：
```python
# 真实 CC 可能使用 UUID 或更复杂的 ID
import uuid

def new_request_id() -> str:
    return f"req_{uuid.uuid4().hex[:8]}"
```

---

## 实际应用场景

### 场景 1：体面关机

```python
# Lead 想让 Alice 关机，但不能直接杀线程

# 步骤 1: Lead 发送关机请求
response = client.messages.create(
    model=MODEL, messages=[{
        "role": "user",
        "content": "Spawn alice as a backend dev. Ask her to create a file. Then request her shutdown."
    }],
    tools=TOOLS
)

# 步骤 2: LLM 调用工具
# request_shutdown(teammate="alice")
# → 创建 ProtocolState(request_id="req_004281", status="pending")
# → BUS.send("shutdown_request", metadata={"request_id": "req_004281"})

# 步骤 3: Alice 收到消息
# idle loop 轮询到 shutdown_request
# handle_inbox_message() 处理：
#   - 发送 shutdown_response (approve=True)
#   - 返回 True 停止循环
#   - 发送最终总结到 lead

# 步骤 4: Lead 收到确认
# consume_lead_inbox() 读到 shutdown_response
# match_response("shutdown_response", "req_004281", approve=True)
# → pending_requests["req_004281"].status = "approved"
# → inbox 消息注入 history，LLM 看到关机结果
```

**输出示例**：
```
[protocol] shutdown_request → alice (req_004281)
[bus] lead → alice: (shutdown_request) Please shut down gracefully.
[protocol] alice approved shutdown (req_004281)
[bus] alice → lead: (shutdown_response) Shutting down gracefully.
[protocol] shutdown ✓ (req_004281: approved)
[Inbox: 1 messages injected]
```

### 场景 2：计划审批

```python
# Bob 想重构认证模块，先提交计划让 Lead 审批

# 步骤 1: Lead 要求 Bob 提交计划
response = client.messages.create(
    model=MODEL, messages=[{
        "role": "user",
        "content": "Spawn bob with a refactoring task. Have him submit a plan first."
    }],
    tools=TOOLS
)

# 步骤 2: Bob 调用 submit_plan 工具
# _teammate_submit_plan(from_name="bob", plan="重构计划内容...")
# → 创建 ProtocolState(request_id="req_123456", type="plan_approval", status="pending")
# → BUS.send("plan_approval_request", metadata={"request_id": "req_123456"})

# 步骤 3: Lead 收到计划，查看并审批
# check_inbox() 显示 Bob 的计划
# LLM 决定 approve 或 reject
# review_plan(request_id="req_123456", approve=True)

# 步骤 4: Bob 收到审批结果
# idle loop 轮询到 plan_approval_response
# handle_inbox_message() 处理：
#   - 注入 "[Plan approved] Proceed with the task." 到消息历史
#   - 返回 False 继续循环
# - Bob 根据审批结果执行或修改计划
```

**输出示例**：
```
[bus] bob → lead: (plan_approval_request) I'll refactor the auth module...
[protocol] plan_approval_request from bob (req_123456)
[Inbox: 1 messages injected]

# Lead 审批
review_plan(request_id="req_123456", approve=True)
[protocol] plan ✓ (req_123456)
[bus] lead → bob: (plan_approval_response) Approved

# Bob 收到
[protocol] bob received plan_approval_response: approved
[teammate] bob: continuing with task...
```

### 场景 3：并发请求处理

```python
# Lead 同时请求多个队友关机

request_shutdown("alice")  # req_001
request_shutdown("bob")    # req_002
request_shutdown("carol")  # req_003

# pending_requests 状态：
{
    "req_001": ProtocolState(target="alice", status="pending"),
    "req_002": ProtocolState(target="bob", status="pending"),
    "req_003": ProtocolState(target="carol", status="pending"),
}

# 三个队友异步响应
# alice: shutdown_response (req_001, approve=True)
# bob: shutdown_response (req_002, approve=True)
# carol: shutdown_response (req_003, approve=False)  # 拒绝关机

# match_response 分别处理：
match_response("shutdown_response", "req_001", True)   # alice approved
match_response("shutdown_response", "req_002", True)   # bob approved
match_response("shutdown_response", "req_003", False)  # carol rejected

# 最终状态：
pending_requests["req_001"].status  # "approved"
pending_requests["req_002"].status  # "approved"
pending_requests["req_003"].status  # "rejected"
```

---

## 与其他模块的关系

### 1. 相对 s15 的变更

| 组件 | s15 (团队通信) | s16 (团队协议) | 改进 |
|------|--------------|--------------|------|
| **协调方式** | 松散文本消息 | 结构化请求-响应协议 | 明确的握手机制 |
| **请求追踪** | 无 | ProtocolState + pending_requests | 可追溯的请求生命周期 |
| **消息路由** | 全部当文本处理 | dispatch_message 按类型分发 | 清晰的消息处理流程 |
| **关机** | 自然退出或杀线程 | request_id 握手机制 | 体面关机，无资源泄漏 |
| **计划审批** | 无 | 消息流程示例 | 高风险操作的审批机制 |
| **新消息类型** | message, result | + shutdown_request/response, plan_approval_request/response | 语义化的协议消息 |
| **队友生命周期** | 最多 10 轮 | idle loop（等待 inbox 消息） | 按需保持活跃 |
| **Lead inbox** | check_inbox 和主循环分别读 | 统一 consume_lead_inbox | 避免消息消费不一致 |
| **工具数量** | Lead 14 个, 队友 4 个 | Lead 14 个, 队友 5 个 (+submit_plan) | 新增计划提交工具 |

### 2. 模块演进路径

```
s12: 任务系统
  ↓ 任务状态管理
s13: 后台任务
  ↓ 异步执行
s14: Cron 调度器
  ↓ 定时任务
s15: 团队通信
  ↓ 队友间消息传递
s16: 团队协议 ← 当前模块
  ↓ 结构化请求-响应
s17: 自主代理
  ↓ 队友自主认领任务
```

### 3. 与真实 Claude Code 的差异

| 特性 | 教学版 (s16) | 真实 CC |
|------|------------|---------|
| **关机协议** | 二向通信（request → response） | 三向通信（request → approved/rejected → teammate_terminated 通知） |
| **消息格式** | 简单字典 | 结构化 JSON + Zod schema 验证 |
| **字段命名** | 统一 `request_id` | permission 用 `request_id`，其他用 `requestId` |
| **执行门控** | 无（仅消息流程） | 有 permission gating 机制 |
| **idle 通知** | 无 | 有 idle_notification 让 Lead 知道队友空闲 |
| **审批能力** | 简单 approve/reject | 可同时设置 `permissionMode`，可附加 `feedback` |

**真实 CC 的关机协议（三向通信）**：
```typescript
// 1. Lead 发送关机请求
BUS.send("shutdown_request", {requestId: "req_123"})

// 2. 队友回复确认
BUS.send("shutdown_approved", {requestId: "req_123"})

// 3. 系统广播终止通知（通知所有相关方）
BUS.broadcast("teammate_terminated", {
    teammate: "alice",
    reason: "graceful_shutdown"
})

// 4. 系统清理资源
// - 清理 pane (tmux/iTerm2)
// - unassign 任务
// - 从 team config 移除成员
```

---

## 优缺点分析

### 优点

#### 1. 结构化的协调机制
```python
# 之前：松散的文本消息
BUS.send("lead", "alice", "Please shut down")  # 无确认机制

# 之后：结构化的协议
req_id = new_request_id()
pending_requests[req_id] = ProtocolState(status="pending")
BUS.send("shutdown_request", metadata={"request_id": req_id})
# ... 等待确认 ...
# request_id 关联整个流程，可追溯
```

#### 2. 明确的状态管理
```python
# 状态机保证：
# - 只能从 pending → approved/rejected（单向转换）
# - 防止重复处理
# - 支持并发请求

if state.status != "pending":
    return  # 已 resolved，忽略重复
```

#### 3. 类型安全
```python
# 类型校验防止误操作
if state.type == "shutdown" and response_type != "shutdown_response":
    return  # 类型不匹配，拒绝处理
```

#### 4. 易于扩展
```python
# 添加新协议类型只需：
# 1. 定义新的消息类型（如 "data_sync_request"）
# 2. 在 dispatch_message 中添加处理分支
# 3. 复用 pending_requests 和 match_response 机制

if msg_type == "data_sync_request":
    # 处理数据同步请求
    handle_data_sync_request(msg)
    return False
```

#### 5. 支持并发
```python
# 多个请求同时进行，每个有独立的 request_id
request_shutdown("alice")  # req_001
request_shutdown("bob")     # req_002
request_plan("carol", ...)  # req_003

# pending_requests 分别追踪
{
    "req_001": ProtocolState(type="shutdown", status="pending"),
    "req_002": ProtocolState(type="shutdown", status="pending"),
    "req_003": ProtocolState(type="plan_approval", status="pending"),
}
```

### 缺点

#### 1. 缺乏超时机制
```python
# 当前实现：请求可能永远 pending
pending_requests[req_id] = ProtocolState(status="pending")
# 如果队友崩溃，这个请求永远不会 resolved

# 改进方向：
def cleanup_expired_requests():
    now = time.time()
    expired = [rid for rid, state in pending_requests.items()
               if now - state.created_at > TIMEOUT]
    for rid in expired:
        pending_requests[rid].status = "timeout"
```

#### 2. 缺乏执行门控
```python
# 当前实现：计划审批只是消息流程
_teammate_submit_plan(from_name, plan)
# 队友仍然可以调用 bash/write_file（没有拦截）

# 真实 CC：有 permission gating
# 未获批准的高风险操作会被拦截
```

#### 3. 缺乏重试机制
```python
# 当前实现：如果消息丢失，无法恢复
BUS.send("shutdown_request", metadata={"request_id": req_id})
# 如果 alice 的 inbox 丢失，请求就"悬空"了

# 改进方向：
def request_shutdown_with_retry(teammate, max_retries=3):
    for attempt in range(max_retries):
        req_id = new_request_id()
        pending_requests[req_id] = ProtocolState(...)
        BUS.send("shutdown_request", ...)

        # 等待响应
        time.sleep(5)
        if pending_requests[req_id].status != "pending":
            return  # 成功

    # 失败后处理
    handle_shutdown_failure(teammate)
```

#### 4. 缺乏错误处理
```python
# 当前实现：假设队友总是能响应
# 真实场景：队友可能崩溃、网络中断、响应格式错误

# 改进方向：
try:
    response = BUS.read_inbox(teammate, timeout=30)
except TimeoutError:
    pending_requests[req_id].status = "timeout"
    notify_lead(f"Teammate {teammate} not responding")
```

#### 5. 内存泄漏风险
```python
# pending_requests 只增不减（教学版）
# 长期运行会积累大量已 resolved 的请求

# 改进方向：
def cleanup_resolved_requests():
    resolved = [rid for rid, state in pending_requests.items()
                if state.status in ("approved", "rejected", "timeout")]
    for rid in resolved:
        del pending_requests[rid]

# 定期清理
threading.Timer(3600, cleanup_resolved_requests).start()
```

---

## 最佳实践

### 1. 使用类型校验
```python
# 总是校验响应类型匹配请求类型
def match_response(response_type, request_id, approve):
    state = pending_requests.get(request_id)
    if not state:
        return

    # 类型校验
    expected = f"{state.type}_response"
    if response_type != expected:
        print(f"Type mismatch: expected {expected}, got {response_type}")
        return

    # 更新状态
    state.status = "approved" if approve else "rejected"
```

### 2. 防重入保护
```python
# 总是检查状态是否已 resolved
if state.status != "pending":
    print(f"Request {request_id} already {state.status}, ignoring duplicate")
    return
```

### 3. 统一消息消费
```python
# 不要在多个地方读同一个 inbox
# 使用统一的消费者函数

# ❌ 错误做法
def run_check_inbox():
    msgs = BUS.read_inbox("lead")  # 读走消息
    return msgs

def main_loop():
    msgs = BUS.read_inbox("lead")  # 再次读，但消息已被读走
    # 协议消息丢失，状态没更新

# ✅ 正确做法
def consume_lead_inbox():
    msgs = BUS.read_inbox("lead")
    # 先路由协议消息
    for msg in msgs:
        if is_protocol_message(msg):
            handle_protocol_message(msg)
    return msgs

# 两处都调用统一函数
run_check_inbox()  # 内部调用 consume_lead_inbox
main_loop()        # 内部调用 consume_lead_inbox
```

### 4. 清晰的协议定义
```python
# 定义明确的协议规范
PROTOCOLS = {
    "shutdown": {
        "request": "shutdown_request",
        "response": "shutdown_response",
        "direction": "lead_to_teammate",
        "description": "体面关机握手",
        "required_fields": ["request_id"],
        "optional_fields": ["reason"]
    },
    "plan_approval": {
        "request": "plan_approval_request",
        "response": "plan_approval_response",
        "direction": "teammate_to_lead",
        "description": "计划审批协议",
        "required_fields": ["request_id", "plan"],
        "optional_fields": ["feedback"]
    }
}

def validate_protocol_message(msg_type: str, metadata: dict) -> bool:
    """校验协议消息是否符合规范"""
    for proto_name, proto_spec in PROTOCOLS.items():
        if msg_type == proto_spec["request"] or msg_type == proto_spec["response"]:
            # 检查必需字段
            for field in proto_spec["required_fields"]:
                if field not in metadata:
                    return False
            return True
    return False
```

### 5. 监控和日志
```python
# 记录协议请求的完整生命周期
def request_shutdown(teammate: str) -> str:
    req_id = new_request_id()
    pending_requests[req_id] = ProtocolState(
        request_id=req_id,
        type="shutdown",
        sender="lead",
        target=teammate,
        status="pending",
        created_at=time.time()
    )

    # 日志记录
    logger.info(f"[protocol] shutdown_request initiated",
                extra={"request_id": req_id, "target": teammate})

    BUS.send("lead", teammate, "Please shut down gracefully.",
             "shutdown_request", {"request_id": req_id})
    return f"Shutdown request sent to {teammate} (req: {req_id})"

def match_response(response_type, request_id, approve):
    state = pending_requests.get(request_id)
    if not state:
        logger.warning(f"[protocol] unknown request_id: {request_id}")
        return

    # 更新状态
    state.status = "approved" if approve else "rejected"

    # 日志记录
    duration = time.time() - state.created_at
    logger.info(f"[protocol] {state.type} completed",
                extra={
                    "request_id": request_id,
                    "status": state.status,
                    "duration": duration
                })
```

### 6. 优雅的错误处理
```python
# 提供清晰的错误信息
def review_plan(request_id: str, approve: bool, feedback: str = "") -> str:
    state = pending_requests.get(request_id)
    if not state:
        return f"Error: Request {request_id} not found. " \
               f"Valid requests: {list(pending_requests.keys())}"

    if state.status != "pending":
        return f"Error: Request {request_id} already {state.status}. " \
               f"Cannot review twice."

    if state.type != "plan_approval":
        return f"Error: Request {request_id} is a {state.type} request, " \
               f"not plan_approval."

    # 执行审批
    state.status = "approved" if approve else "rejected"
    BUS.send("lead", state.sender, feedback or ("Approved" if approve else "Rejected"),
             "plan_approval_response",
             {"request_id": request_id, "approve": approve})

    return f"Plan {'approved' if approve else 'rejected'} ({request_id})"
```

### 7. 测试覆盖
```python
# 测试协议请求-响应流程
def test_shutdown_protocol():
    # 创建请求
    req_id = run_request_shutdown("alice")
    assert pending_requests[req_id].status == "pending"

    # 模拟队友响应
    match_response("shutdown_response", req_id, approve=True)
    assert pending_requests[req_id].status == "approved"

    # 测试重复响应被忽略
    match_response("shutdown_response", req_id, approve=False)
    assert pending_requests[req_id].status == "approved"  # 状态不变

def test_type_mismatch():
    req_id = run_request_shutdown("alice")

    # 类型不匹配的响应被忽略
    match_response("plan_approval_response", req_id, approve=True)
    assert pending_requests[req_id].status == "pending"  # 状态未变

def test_concurrent_requests():
    id1 = run_request_shutdown("alice")
    id2 = run_request_shutdown("bob")
    id3 = run_request_plan("carol", "task")

    # 各自独立追踪
    match_response("shutdown_response", id1, approve=True)
    match_response("shutdown_response", id2, approve=False)
    match_response("plan_approval_response", id3, approve=True)

    assert pending_requests[id1].status == "approved"
    assert pending_requests[id2].status == "rejected"
    assert pending_requests[id3].status == "approved"
```

---

## 总结

s16_team_protocols 通过引入结构化的请求-响应协议，解决了团队协作中的协调问题：

1. **明确性**：request_id 关联整个协议流程，可追溯、可审计
2. **可靠性**：状态机保证请求的生命周期，防重入、类型安全
3. **扩展性**：统一的协议框架，易于添加新的协议类型
4. **并发性**：支持多个并发请求，每个独立追踪

核心模式：**request_id + 状态机 + 类型校验 + 消息路由**

这是多智能体协作的基础设施，为后续的自主代理（s17）提供了可靠的协调机制。

---

## 参考资料

- [s16 原始 README](README.md)
- [s16 代码实现](code.py)
- [s15 团队通信](../s15_team_messaging/)
- [s17 自主代理](../s17_autonomous_agents/)
- [CC 源码：teammateMailbox.ts](https://github.com/anthropics/claude-code/blob/main/src/teammateMailbox.ts)
# s17 Autonomous Agents 深度解析

## 目录
- [一、架构设计](#一架构设计)
- [二、整体思想](#二整体思想)
- [三、实现细节](#三实现细节)
- [四、实际应用场景](#四实际应用场景)
- [五、与其他模块的关系](#五与其他模块的关系)
- [六、优缺点分析](#六优缺点分析)
- [七、最佳实践](#七最佳实践)

---

## 一、架构设计

### 1.1 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                         Lead Agent                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Task Manager │  │ Message Bus  │  │ Protocol     │      │
│  │              │  │              │  │ Handler      │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
└─────────┼──────────────────┼──────────────────┼──────────────┘
          │                  │                  │
          │ create_task      │ send/receive    │ request_shutdown
          ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────┐
│                     Shared Resources                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ .tasks/      │  │ .mailboxes/  │  │ Protocol     │      │
│  │ task_*.json  │  │ alice.jsonl  │  │ State        │      │
│  └──────────────┘  │ bob.jsonl    │  └──────────────┘      │
└─────────────────────┴──────────────┴────────────────────────┘
          ▲                  ▲                  ▲
          │ scan/claim       │ poll inbox       │ protocol msgs
          │                  │                  │
┌─────────┴────────┬─────────┴────────┬─────────┴─────────────┐
│   Teammate Alice │  Teammate Bob    │  Teammate Charlie    │
│                  │                  │                      │
│  WORK Phase      │  IDLE Phase      │  SHUTDOWN Phase     │
│  ┌────────────┐  │  ┌────────────┐  │  ┌────────────┐     │
│  │ LLM Loop  │  │  │ 5s Poll   │  │  │ Send Summary│     │
│  │ Tools     │  │  │ Scan Tasks│  │  │ Exit       │     │
│  └────────────┘  │  └────────────┘  │  └────────────┘     │
└──────────────────┴──────────────────┴──────────────────────┘
```

### 1.2 核心组件

#### 1.2.1 任务系统（Task System）

```python
# 任务存储在 .tasks/ 目录，每个任务是一个 JSON 文件
@dataclass
class Task:
    id: str                    # 任务唯一标识，如 "task_1234567890_0001"
    subject: str               # 任务主题
    description: str           # 详细描述
    status: str                # pending | in_progress | completed
    owner: str | None          # 认领者，None 表示未认领
    blockedBy: list[str]       # 依赖的任务 ID 列表
```

**关键函数**：

- `create_task()`：创建新任务，生成唯一 ID
- `claim_task()`：认领任务，检查 status、owner、依赖关系
- `complete_task()`：完成任务，更新状态
- `can_start()`：检查所有依赖是否已完成

#### 1.2.2 消息总线（MessageBus）

继承自 s15，负责 Agent 间的通信：

```python
class MessageBus:
    def send(self, from_agent, to_agent, content, msg_type="message", metadata=None):
        """发送消息到目标 Agent 的收件箱"""
        msg = {
            "from": from_agent,
            "to": to_agent,
            "content": content,
            "type": msg_type,           # message | shutdown_request | ...
            "ts": time.time(),
            "metadata": metadata or {}  # request_id, approve, ...
        }
        # 追加写入 .mailboxes/{to_agent}.jsonl
```

**消息类型**：
- `message`：普通消息
- `shutdown_request` / `shutdown_response`：关机协议
- `plan_approval_request` / `plan_approval_response`：计划审批协议
- `result`：任务结果汇报

#### 1.2.3 协议状态管理（Protocol State）

```python
@dataclass
class ProtocolState:
    request_id: str       # 请求唯一标识
    type: str              # shutdown | plan_approval
    sender: str            # 发起者
    target: str            # 目标 Agent
    status: str            # pending | approved | rejected
    payload: str           # 协议内容（如计划文本）
    created_at: float      # 创建时间
```

### 1.3 队友生命周期：三阶段模型

```
┌──────────────────────────────────────────────────────────┐
│                   外层 while True 循环                    │
│  ┌────────────────────────────────────────────────────┐  │
│  │               WORK Phase                            │  │
│  │  ┌──────────────────────────────────────────────┐  │  │
│  │  │  for _ in range(10):                         │  │  │
│  │  │    1. 检查 inbox，分发协议消息               │  │  │
│  │  │    2. 调用 LLM                               │  │  │
│  │  │    3. 执行工具（bash/write/claim/complete）  │  │  │
│  │  │    4. 如果 stop_reason != "tool_use"，退出  │  │  │
│  │  └──────────────────────────────────────────────┘  │  │
│  └────────────────────┬───────────────────────────────┘  │
│                       │ 完成/无工具调用                    │
│                       ▼                                    │
│  ┌────────────────────────────────────────────────────┐  │
│  │               IDLE Phase                            │  │
│  │  idle_poll(60s):                                    │  │
│  │    for _ in range(12):  # 12 * 5s = 60s           │  │
│  │      1. 检查 inbox → shutdown? → 退出              │  │
│  │      2. 扫描任务看板 → 有未认领任务? → claim       │  │
│  │      3. sleep(5s)                                  │  │
│  │    return "timeout"                                │  │
│  └────────────────────┬───────────────────────────────┘  │
│                       │ timeout 或 shutdown               │
│                       ▼                                    │
│  ┌────────────────────────────────────────────────────┐  │
│  │             SHUTDOWN Phase                         │  │
│  │    1. 生成 summary                                │  │
│  │    2. BUS.send(name, "lead", summary, "result")  │  │
│  │    3. 退出线程                                     │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

**关键设计点**：

1. **WORK 阶段最多 10 轮 LLM 调用**：防止无限循环
2. **IDLE 阶段最多 60 秒**：12 次轮询 × 5 秒
3. **shutdown_request 两阶段都能响应**：
   - WORK 阶段：通过 `handle_inbox_message` 分发
   - IDLE 阶段：`idle_poll` 直接检查并回复

---

## 二、整体思想

### 2.1 解决的问题

**s16 的局限性**：
- Lead 必须手动 assign 任务给每个队友
- 任务看板上有 10 个任务，Lead 需要 assign 10 次
- 队友完成任务后立即退出，无法承接新任务
- 无法扩展：任务越多，Lead 负担越重

**s17 的目标**：
```
"自己看板，自己认领" —— 空闲时轮询，有活就干
```

### 2.2 核心设计理念

#### 2.2.1 自治（Autonomy）

队友不再被动等待分配，而是主动寻找工作：

```python
# 传统模式（s16）：被动等待
Lead → "Alice, 请做任务 A" → Alice 执行 → Alice 退出

# 自治模式（s17）：主动认领
Lead → 创建任务 A, B, C → 启动 Alice 和 Bob
Alice IDLE → 扫描看板 → 发现任务 A → 认领 → 执行
Bob IDLE → 扫描看板 → 发现任务 B → 认领 → 执行
Alice 完成 A → IDLE → 扫描看板 → 发现任务 C → 认领 → 执行
```

#### 2.2.2 依赖感知的任务分配

不是简单的"先到先得"，而是考虑任务依赖：

```python
def can_start(task_id: str) -> bool:
    """检查任务是否可以开始执行"""
    task = load_task(task_id)
    for dep_id in task.blockedBy:
        # 依赖任务必须存在且已完成
        if not _task_path(dep_id).exists():
            return False
        if load_task(dep_id).status != "completed":
            return False
    return True

def scan_unclaimed_tasks() -> list[dict]:
    """扫描可认领的任务"""
    unclaimed = []
    for f in sorted(TASKS_DIR.glob("task_*.json")):
        task = json.loads(f.read_text())
        # 三个条件：pending + 无 owner + 依赖已满足
        if (task.get("status") == "pending"
                and not task.get("owner")
                and can_start(task["id"])):
            unclaimed.append(task)
    return unclaimed
```

**示例**：
```
任务 A：无依赖 → 可立即认领
任务 B：blockedBy: [A] → 等待 A 完成后才能认领
任务 C：blockedBy: [A, B] → 等待 A 和 B 都完成后才能认领
```

#### 2.2.3 持续可用性

队友不会因为完成一个任务就退出，而是进入 IDLE 状态继续寻找新任务：

```python
# 外层循环：WORK → IDLE 交替
while True:
    # WORK 阶段
    for _ in range(10):
        # ... 执行任务
        if response.stop_reason != "tool_use":
            break  # WORK 结束，进入 IDLE

    # IDLE 阶段
    idle_result = idle_poll(name, messages, name, role)
    if idle_result == "shutdown":
        break  # 收到关机请求 → SHUTDOWN
    if idle_result == "timeout":
        break  # 60s 无新任务 → SHUTDOWN
```

### 2.3 协议机制：优雅的协调

#### 2.3.1 shutdown 协议

两阶段都能响应关机请求：

```python
# WORK 阶段：通过 handle_inbox_message 分发
def handle_inbox_message(name, msg, messages):
    if msg.get("type") == "shutdown_request":
        req_id = msg.get("metadata", {}).get("request_id", "")
        BUS.send(name, "lead", "Shutting down gracefully.",
                 "shutdown_response",
                 {"request_id": req_id, "approve": True})
        return True  # 触发 shutdown

# IDLE 阶段：直接检查
def idle_poll(agent_name, messages, name, role):
    for _ in range(12):
        inbox = BUS.read_inbox(agent_name)
        if inbox:
            for msg in inbox:
                if msg.get("type") == "shutdown_request":
                    # 立即回复并退出
                    req_id = msg.get("metadata", {}).get("request_id", "")
                    BUS.send(name, "lead", "Shutting down gracefully.",
                             "shutdown_response",
                             {"request_id": req_id, "approve": True})
                    return "shutdown"
```

#### 2.3.2 plan_approval 协议

队友提交计划，Lead 审批后执行：

```
Teammate                Lead
   │                     │
   ├─ plan_approval_request ──→
   │   (request_id, plan)    │
   │                     │
   │   ← plan_approval_response ─┤
   │     (request_id, approve=True/False)
   │                     │
   ├─ 执行计划或修改      │
```

### 2.4 身份保持：应对 Context Compaction

当对话历史被压缩时，需要重新注入身份信息：

```python
# WORK 阶段开始时检查
if len(messages) <= 3:
    # 消息过短说明发生了压缩
    messages.insert(0, {"role": "user",
        "content": f"<identity>You are '{name}', role: {role}. "
                   f"Continue your work.</identity>"})
```

---

## 三、实现细节

### 3.1 idle_poll：空闲轮询机制

这是 s17 的核心创新，实现了"空闲时找活干"：

```python
IDLE_POLL_INTERVAL = 5   # 每 5 秒轮询一次
IDLE_TIMEOUT = 60        # 最多等待 60 秒

def idle_poll(agent_name: str, messages: list,
              name: str, role: str) -> str:
    """
    轮询 60 秒，返回三种状态之一：
    - 'work'：发现新工作（inbox 消息或可认领任务）
    - 'shutdown'：收到关机请求
    - 'timeout'：60 秒无新工作
    """
    for _ in range(IDLE_TIMEOUT // IDLE_POLL_INTERVAL):
        time.sleep(IDLE_POLL_INTERVAL)

        # ① 优先检查 inbox（可能包含协议消息）
        inbox = BUS.read_inbox(agent_name)
        if inbox:
            # 检查 shutdown_request
            for msg in inbox:
                if msg.get("type") == "shutdown_request":
                    req_id = msg.get("metadata", {}).get("request_id", "")
                    BUS.send(name, "lead", "Shutting down gracefully.",
                             "shutdown_response",
                             {"request_id": req_id, "approve": True})
                    return "shutdown"

            # 普通消息注入上下文，回到 WORK
            messages.append({"role": "user",
                "content": "<inbox>" + json.dumps(inbox) + "</inbox>"})
            return "work"

        # ② 扫描任务看板
        unclaimed = scan_unclaimed_tasks()
        if unclaimed:
            task = unclaimed[0]  # 教学版：取第一个
            result = claim_task(task["id"], agent_name)
            if "Claimed" in result:
                # 认领成功，注入上下文，回到 WORK
                messages.append({"role": "user",
                    "content": f"<auto-claimed>Task {task['id']}: "
                               f"{task['subject']}</auto-claimed>"})
                return "work"
            # 认领失败，继续轮询

    return "timeout"
```

**优先级设计**：
1. inbox 消息优先（可能包含 shutdown_request）
2. 任务看板其次

**为什么不是主动推送**？
- 教学版简化实现
- 真实 CC 用文件监听（`fs.watch()`）+ 主动轮询的组合

### 3.2 claim_task：带检查的认领

避免"后写覆盖"问题：

```python
def claim_task(task_id: str, owner: str = "agent") -> str:
    task = load_task(task_id)

    # 检查 1：状态必须是 pending
    if task.status != "pending":
        return f"Task {task_id} is {task.status}, cannot claim"

    # 检查 2：没有 owner
    if task.owner:
        return f"Task {task_id} already owned by {task.owner}"

    # 检查 3：依赖都已满足
    if not can_start(task_id):
        deps = [d for d in task.blockedBy
                if _task_path(d).exists() and load_task(d).status != "completed"]
        missing = [d for d in task.blockedBy if not _task_path(d).exists()]
        parts = []
        if deps: parts.append(f"blocked by: {deps}")
        if missing: parts.append(f"missing deps: {missing}")
        return "Cannot start — " + ", ".join(parts)

    # 通过所有检查，更新任务
    task.owner = owner
    task.status = "in_progress"
    save_task(task)
    return f"Claimed {task.id} ({task.subject})"
```

**并发安全**：
- 教学版：仅检查 `task.owner`，有竞争风险
- 真实 CC：使用 `proper-lockfile` 保护文件读写

### 3.3 队友工具集

相比 s16 的 5 个工具，s17 增加了任务管理工具：

```python
sub_tools = [
    # 基础工具（s15 引入）
    "bash",           # 执行命令
    "read_file",      # 读取文件
    "write_file",     # 写入文件
    "send_message",   # 发送消息
    "submit_plan",    # 提交计划

    # 新增任务工具（s17 引入）
    "list_tasks",     # 列出所有任务
    "claim_task",     # 认领任务
    "complete_task",  # 完成任务
]
```

**工具实现**：

```python
def _run_list_tasks():
    tasks = list_tasks()
    if not tasks:
        return "No tasks."
    return "\n".join(
        f"  {t.id}: {t.subject} [{t.status}]"
        for t in tasks)

def _run_claim_task(task_id: str):
    return claim_task(task_id, owner=name)

def _run_complete_task(task_id: str):
    return complete_task(task_id)
```

### 3.4 consume_lead_inbox：统一消息消费

Lead 的收件箱需要统一处理：

```python
def consume_lead_inbox(route_protocol=True) -> list[dict]:
    """
    读取 Lead 的收件箱：
    1. 路由协议响应（匹配 request_id）
    2. 返回所有消息供 Lead 的 LLM 处理
    """
    msgs = BUS.read_inbox("lead")
    if route_protocol:
        for msg in msgs:
            meta = msg.get("metadata", {})
            req_id = meta.get("request_id", "")
            msg_type = msg.get("type", "")
            # 匹配协议响应
            if req_id and msg_type.endswith("_response"):
                match_response(msg_type, req_id, meta.get("approve", False))
    return msgs
```

**协议匹配**：

```python
def match_response(response_type: str, request_id: str, approve: bool):
    """根据 request_id 关联回原始请求"""
    state = pending_requests.get(request_id)
    if not state:
        print(f"  [protocol] unknown request_id: {request_id}")
        return

    # 类型检查
    if state.type == "shutdown" and response_type != "shutdown_response":
        print(f"  [protocol] type mismatch")
        return
    if state.type == "plan_approval" and response_type != "plan_approval_response":
        print(f"  [protocol] type mismatch")
        return

    # 更新状态
    state.status = "approved" if approve else "rejected"
```

### 3.5 完整工作流程示例

```
时间轴：
T0   Lead 创建 3 个任务（无依赖）
T1   Lead 启动 Alice 和 Bob
T2   Alice 进入 IDLE，扫描看板，认领任务 1
T3   Bob 进入 IDLE，扫描看板，认领任务 2
T4   Alice 完成任务 1，进入 IDLE，扫描看板，认领任务 3
T5   Bob 完成任务 2，进入 IDLE，扫描看板（无任务），等待
T6   Alice 完成任务 3，进入 IDLE，扫描看板（无任务），等待
T60  Alice 超时（60s），发送 summary，退出
T60  Bob 超时（60s），发送 summary，退出
T61  Lead 收到 Alice 和 Bob 的 summary
```

**日志输出**：

```
[create] 创建数据库 schema
[create] 写 API 路由
[create] 写单元测试
[teammate] alice spawned as backend
[teammate] bob spawned as backend

[idle] alice auto-claimed: 创建数据库 schema
[claim] 创建数据库 schema → in_progress
[idle] bob auto-claimed: 写 API 路由
[claim] 写 API 路由 → in_progress

[complete] 创建数据库 schema ✓
[idle] alice auto-claimed: 写单元测试
[claim] 写单元测试 → in_progress

[complete] 写 API 路由 ✓
[complete] 写单元测试 ✓

[idle] alice timeout (60s)
[teammate] alice finished
[idle] bob timeout (60s)
[teammate] bob finished

[bus] alice → lead: (result) Done.
[bus] bob → lead: (result) Done.
```

---

## 四、实际应用场景

### 4.1 并行任务执行

**场景**：搭建后端服务

```python
# Lead 创建多个独立任务
create_task("创建数据库 schema")
create_task("写 API 路由")
create_task("写单元测试")
create_task("配置 Docker")
create_task("设置 CI/CD")

# 启动多个队友
spawn_teammate("alice", "backend", "你是后端开发者")
spawn_teammate("bob", "backend", "你是后端开发者")
spawn_teammate("charlie", "devops", "你是运维工程师")

# 队友自动认领任务，无需 Lead 分配
```

### 4.2 依赖任务链

**场景**：前端功能开发

```python
# 创建有依赖的任务
task1 = create_task("设计组件 API")
task2 = create_task("实现组件", blockedBy=[task1.id])
task3 = create_task("写单元测试", blockedBy=[task2.id])
task4 = create_task("集成到主应用", blockedBy=[task3.id])

# 启动队友
spawn_teammate("dev", "frontend", "你是前端开发者")

# 执行顺序：
# T1: 设计组件 API（无依赖，可立即认领）
# T2: 实现组件（等待 T1 完成）
# T3: 写单元测试（等待 T2 完成）
# T4: 集成到主应用（等待 T3 完成）
```

### 4.3 动态任务添加

**场景**：持续集成中的任务队列

```python
# 初始任务
create_task("运行 lint")
create_task("运行类型检查")

# 启动队友
spawn_teammate("ci1", "ci-runner", "运行 CI 任务")
spawn_teammate("ci2", "ci-runner", "运行 CI 任务")

# 队友开始工作后，Lead 继续添加任务
time.sleep(10)
create_task("运行单元测试")
create_task("构建 Docker 镜像")

# 队友会自动发现并认领新任务
```

### 4.4 优雅关闭

**场景**：测试完成后关闭队友

```python
# Lead 请求关闭特定队友
request_shutdown("alice")

# alice 在 IDLE 或 WORK 阶段都会响应
# 响应后发送 summary 并退出

# Lead 检查收件箱
inbox = check_inbox()
# 看到：[alice] [shutdown_response] Shutting down gracefully.
```

---

## 五、与其他模块的关系

### 5.1 继承链

```
s15_message_bus      → 消息总线基础
     ↓
s16_protocol_tools   → 协议工具（shutdown, plan_approval）
     ↓
s17_autonomous_agents → 自主任务认领 + 三阶段生命周期
     ↓
s18_worktree_isolation → 工作目录隔离
```

### 5.2 新增特性

| 模块 | 核心特性 | s17 新增 |
|------|---------|---------|
| s15 | MessageBus, spawn_teammate | — |
| s16 | shutdown_request, plan_approval | — |
| **s17** | — | **idle_poll, scan_unclaimed, claim_task** |

### 5.3 工具对比

| 工具 | s15 | s16 | s17 |
|------|-----|-----|-----|
| bash | ✓ | ✓ | ✓ |
| read_file | ✓ | ✓ | ✓ |
| write_file | ✓ | ✓ | ✓ |
| send_message | ✓ | ✓ | ✓ |
| submit_plan | ✓ | ✓ | ✓ |
| **list_tasks** | — | — | **✓** |
| **claim_task** | — | — | **✓** |
| **complete_task** | — | — | **✓** |
| create_task | ✓ (Lead) | ✓ (Lead) | ✓ (Lead) |
| get_task | ✓ (Lead) | ✓ (Lead) | ✓ (Lead) |
| spawn_teammate | ✓ (Lead) | ✓ (Lead) | ✓ (Lead) |
| check_inbox | ✓ (Lead) | ✓ (Lead) | ✓ (Lead) |
| request_shutdown | — | ✓ (Lead) | ✓ (Lead) |
| request_plan | — | ✓ (Lead) | ✓ (Lead) |
| review_plan | — | ✓ (Lead) | ✓ (Lead) |

**总结**：
- Lead 工具：14 个（与 s16 相同）
- 队友工具：8 个（s16 的 5 个 + 3 个任务工具）

---

## 六、优缺点分析

### 6.1 优点

#### 6.1.1 自治性
- **减少 Lead 负担**：无需手动分配任务
- **自动负载均衡**：空闲队友自动寻找工作
- **扩展性好**：任务越多，优势越明显

#### 6.1.2 依赖感知
- **智能任务分配**：自动等待依赖完成
- **避免阻塞**：`can_start()` 检查确保执行顺序
- **并行优化**：独立任务可同时被认领

#### 6.1.3 优雅生命周期
- **持续可用**：IDLE 阶段保持活跃
- **优雅关闭**：两阶段都能响应 shutdown_request
- **身份保持**：compaction 后重新注入身份

### 6.2 缺点

#### 6.2.1 并发安全
```python
# 教学版的竞争条件
def claim_task(task_id: str, owner: str = "agent") -> str:
    task = load_task(task_id)        # ① 读
    if task.owner:                    # ② 检查
        return f"Task {task_id} already owned"
    task.owner = owner                # ③ 改
    save_task(task)                   # ④ 写
    # 在 ① 和 ④ 之间，另一个队友可能已经 claim
```

**真实 CC 的解决方案**：
```typescript
// utils/tasks.ts:541-612
async function claimTask(taskId: string): Promise<Task> {
  const lock = await properLockfile.lock(taskPath);
  try {
    const task = await loadTask(taskId);
    if (task.owner) throw new Error("Already owned");
    task.owner = getCurrentAgent();
    await saveTask(task);
    return task;
  } finally {
    await lock.unlock();
  }
}
```

#### 6.2.2 轮询开销

```python
# 每 5 秒轮询一次，持续 60 秒
for _ in range(12):
    time.sleep(5)
    inbox = BUS.read_inbox(agent_name)      # 文件 I/O
    unclaimed = scan_unclaimed_tasks()      # 遍历任务目录
```

**真实 CC 的优化**：
- 文件监听：`fs.watch()` 监听任务目录变化
- 事件驱动：任务创建/完成时触发通知
- 减少轮询：500ms mailbox 轮询 + 事件通知

#### 6.2.3 工作目录冲突

```python
# Alice 和 Bob 在同一目录工作
Alice: write_file("config.py", "alice 的配置")
Bob:   write_file("config.py", "bob 的配置")  # 覆盖 Alice 的修改
```

**s18 的解决方案**：
- 每个任务创建独立的工作树（worktree）
- 隔离文件修改，避免冲突

### 6.3 与真实 CC 的对比

| 维度 | 教学版 (s17) | 真实 CC |
|------|-------------|---------|
| 空闲机制 | idle_poll 统一轮询（5s） | idle_notification + 500ms mailbox 轮询 + task watcher |
| 任务发现 | scan_unclaimed_tasks（轮询） | useTaskListWatcher（文件监听）+ tryClaimNextTask（主动轮询） |
| 依赖判断 | can_start（所有 blockedBy 已完成） | findAvailableTask（同样语义） |
| 并发安全 | owner 检查（无文件锁） | proper-lockfile 任务锁 + task-list 锁 |
| shutdown 处理 | IDLE 直接分发，WORK 通过 handle_inbox_message | 500ms 轮询中优先处理 shutdown_request |
| 超时退出 | 60s 无新任务 | 无固定超时，Lead 手动 shutdown |
| 身份保持 | messages 长度检测 | context compaction 保留 system prompt |

---

## 七、最佳实践

### 7.1 任务设计原则

#### 7.1.1 合理的任务粒度

```python
# ✅ 好的设计：任务独立且明确
create_task("创建数据库 schema")
create_task("写用户注册 API")
create_task("写登录 API")

# ❌ 不好的设计：任务过大或依赖混乱
create_task("构建整个后端系统")
create_task("写 API", blockedBy=["不存在的任务ID"])
```

#### 7.1.2 清晰的依赖关系

```python
# ✅ 正确的依赖链
task1 = create_task("设计 API 接口")
task2 = create_task("实现 API", blockedBy=[task1.id])
task3 = create_task("测试 API", blockedBy=[task2.id])

# ❌ 循环依赖（无法解决）
task1 = create_task("任务 A", blockedBy=[task2.id])
task2 = create_task("任务 B", blockedBy=[task1.id])
```

### 7.2 队友角色分配

```python
# ✅ 根据任务类型分配角色
spawn_teammate("backend_dev", "backend developer",
               "你是后端开发者，擅长 Python 和 FastAPI")
spawn_teammate("frontend_dev", "frontend developer",
               "你是前端开发者，擅长 React 和 TypeScript")
spawn_teammate("devops", "devops engineer",
               "你是运维工程师，擅长 Docker 和 CI/CD")

# ❌ 角色过于模糊
spawn_teammate("dev", "developer", "写代码")
```

### 7.3 监控和调试

#### 7.3.1 查看任务状态

```bash
# 查看所有任务
ls -la .tasks/

# 查看任务详情
cat .tasks/task_1718123456_0001.json
```

输出示例：
```json
{
  "id": "task_1718123456_0001",
  "subject": "创建数据库 schema",
  "description": "",
  "status": "in_progress",
  "owner": "alice",
  "blockedBy": []
}
```

#### 7.3.2 查看消息日志

```bash
# 查看队友发给 Lead 的消息
cat .mailboxes/lead.jsonl
```

输出示例：
```json
{"from": "alice", "to": "lead", "content": "Done.", "type": "result", ...}
{"from": "bob", "to": "lead", "content": "Task completed successfully", "type": "result", ...}
```

#### 7.3.3 优雅关闭所有队友

```python
# Lead 关闭所有活跃队友
for name in ["alice", "bob", "charlie"]:
    if name in active_teammates:
        request_shutdown(name)

# 等待所有队友发送 summary
time.sleep(2)
check_inbox()  # 查看 summary
```

### 7.4 错误处理

#### 7.4.1 处理认领失败

```python
# 队友在 claim_task 后检查返回值
result = claim_task(task_id, owner=name)
if "Claimed" not in result:
    # 认领失败，可能已被其他队友认领或依赖未满足
    print(f"Claim failed: {result}")
    # 继续扫描其他任务
else:
    # 认领成功，开始执行
    print(f"Claimed: {result}")
```

#### 7.4.2 处理依赖缺失

```python
# 创建任务时检查依赖是否存在
def create_task_safe(subject: str, blockedBy: list[str] | None = None):
    # 检查依赖任务是否存在
    if blockedBy:
        for dep_id in blockedBy:
            if not _task_path(dep_id).exists():
                print(f"Warning: dependency {dep_id} does not exist")
    return create_task(subject, blockedBy=blockedBy)
```

### 7.5 性能优化

#### 7.5.1 减少轮询开销

```python
# 如果不需要 IDLE 超时，可以缩短轮询时间
IDLE_POLL_INTERVAL = 2   # 2 秒轮询一次
IDLE_TIMEOUT = 20        # 20 秒超时

# 或者使用事件驱动（真实 CC 的方式）
# 任务创建时触发通知，队友立即响应
```

#### 7.5.2 任务缓存

```python
# 缓存任务列表，减少文件读取
_task_cache = {}
_cache_time = 0
CACHE_TTL = 2  # 2 秒缓存

def list_tasks_cached() -> list[Task]:
    global _task_cache, _cache_time
    now = time.time()
    if now - _cache_time > CACHE_TTL:
        _task_cache = list_tasks()
        _cache_time = now
    return _task_cache
```

---

## 八、总结

### 8.1 核心创新

s17_autonomous_agents 的核心创新是**自治（Autonomy）**：

1. **自主认领**：队友主动寻找任务，无需 Lead 分配
2. **持续可用**：IDLE 阶段保持活跃，随时接受新任务
3. **依赖感知**：自动等待依赖任务完成，智能调度
4. **优雅协调**：协议机制确保可控的生命周期

### 8.2 关键代码路径

```
启动队友
  ↓
spawn_teammate_thread() → 创建线程，进入外层循环
  ↓
WORK Phase (最多 10 轮 LLM 调用)
  ├─ handle_inbox_message() → 处理 shutdown_request
  ├─ LLM + Tools 执行
  └─ stop_reason != "tool_use" → 进入 IDLE
  ↓
IDLE Phase (最多 60 秒轮询)
  ├─ 每 5 秒检查一次
  ├─ inbox 有消息 → 回到 WORK 或 SHUTDOWN
  ├─ scan_unclaimed_tasks() → 认领任务 → 回到 WORK
  └─ 60s 超时 → SHUTDOWN
  ↓
SHUTDOWN Phase
  ├─ 生成 summary
  ├─ BUS.send(name, "lead", summary, "result")
  └─ 退出线程
```

### 8.3 学习建议

1. **运行示例**：
   ```bash
   cd learn-claude-code
   python s17_autonomous_agents/code.py
   ```

2. **观察重点**：
   - 队友如何自动认领任务
   - 依赖任务如何等待前置完成
   - IDLE 超时后如何自动关机
   - shutdown_request 如何被处理

3. **对比 s16**：
   - 队友是否需要 Lead 手动分配任务
   - 完成任务后是否立即退出
   - 如何发现新任务

4. **思考 s18**：
   - 多个队友在同一目录工作会有什么问题？
   - 如何隔离不同队友的工作空间？

---

## 附录：关键函数速查

| 函数 | 作用 | 关键参数 |
|------|------|---------|
| `create_task()` | 创建任务 | subject, description, blockedBy |
| `claim_task()` | 认领任务 | task_id, owner |
| `complete_task()` | 完成任务 | task_id |
| `can_start()` | 检查依赖是否满足 | task_id |
| `scan_unclaimed_tasks()` | 扫描可认领任务 | — |
| `idle_poll()` | 空闲轮询（60s） | agent_name, messages, name, role |
| `consume_lead_inbox()` | 统一消费 Lead 收件箱 | route_protocol |
| `spawn_teammate_thread()` | 启动队友线程 | name, role, prompt |
| `handle_inbox_message()` | 分发协议消息 | name, msg, messages |
| `match_response()` | 匹配协议响应 | response_type, request_id, approve |

---

**参考资料**：
- s15_message_bus：消息总线基础
- s16_protocol_tools：协议工具
- s18_worktree_isolation：工作目录隔离
- 真实 CC 源码：`utils/tasks.ts`, `inProcessRunner.ts`, `hooks/useTaskListWatcher.ts`
# s15 Agent Teams 深度解析

> 本文档从架构设计、整体思想、实现细节三个维度深入分析 Agent Teams 模块

---

## 目录

1. [架构设计](#一架构设计)
2. [整体思想](#二整体思想)
3. [实现细节](#三实现细节)
4. [实际应用场景](#四实际应用场景)
5. [与其他模块的关系](#五与其他模块的关系)
6. [优缺点与最佳实践](#六优缺点与最佳实践)

---

## 一、架构设计

### 1.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                          Lead Agent                              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  主循环 (agent_loop)                                      │   │
│  │  - 用户交互                                               │   │
│  │  - LLM 调用                                               │   │
│  │  - 工具执行 (14个工具)                                    │   │
│  │  - 收件箱注入 (inbox injection)                           │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│              ┌───────────────┼───────────────┐                   │
│              ▼               ▼               ▼                   │
│     spawn_teammate    send_message    check_inbox                 │
└─────────────────────────────────────────────────────────────────┘
                       │
                       │ MessageBus (文件收件箱)
                       ▼
       ┌───────────────┴───────────────┐
       ▼                               ▼
┌──────────────────┐          ┌──────────────────┐
│  Teammate Alice  │          │  Teammate Bob    │
│  (Backend Dev)   │          │  (Frontend Dev)  │
│                  │          │                  │
│  daemon thread   │          │  daemon thread   │
│  - 简化工具集    │          │  - 简化工具集    │
│  - 独立 messages │          │  - 独立 messages │
│  - 最多10轮循环  │          │  - 最多10轮循环  │
│  - send_message  │          │  - send_message  │
└──────────────────┘          └──────────────────┘
```

### 1.2 核心组件说明

#### 1.2.1 Lead Agent (主代理)

Lead Agent 是团队的核心协调者，负责：

- **任务分解**：将复杂任务分解为子任务
- **队友调度**：创建和分配任务给队友
- **结果整合**：收集并整合队友的工作成果
- **用户交互**：与用户进行直接沟通

```python
# Lead Agent 拥有 14 个工具
LEAD_TOOLS = [
    # 基础工具 (3个)
    "bash", "read_file", "write_file",

    # 任务系统工具 (5个)
    "create_task", "list_tasks", "get_task",
    "claim_task", "complete_task",

    # Cron 调度工具 (3个)
    "schedule_cron", "list_crons", "cancel_cron",

    # 团队协作工具 (3个) ← s15 新增
    "spawn_teammate", "send_message", "check_inbox",
]
```

#### 1.2.2 Teammate Agent (队友代理)

Teammate Agent 是独立运行的工作单元：

- **独立线程**：每个队友运行在独立的 daemon 线程中
- **简化工具集**：只有 bash、read_file、write_file、send_message
- **独立上下文**：有自己的 messages 历史，与 Lead 隔离
- **生命周期限制**：教学版最多 10 轮循环（真实 CC 使用 idle loop）

```python
# Teammate Agent 只有 4 个工具
TEAMMATE_TOOLS = [
    "bash",        # 执行命令
    "read_file",   # 读取文件
    "write_file",  # 写入文件
    "send_message", # 发送消息给其他 Agent
]
```

#### 1.2.3 MessageBus (消息总线)

MessageBus 是团队通信的核心基础设施：

```python
class MessageBus:
    """
    文件系统实现的消息总线

    设计特点：
    1. 每个 Agent 有一个独立的 .jsonl 收件箱文件
    2. 发消息 = append 一行 JSON
    3. 读消息 = read + unlink (消费式读取)
    4. 跨线程安全（教学版无锁，真实 CC 使用 proper-lockfile）
    """

    def send(self, from_agent: str, to_agent: str,
             content: str, msg_type: str = "message"):
        """发送消息到目标 Agent 的收件箱"""
        msg = {
            "from": from_agent,
            "to": to_agent,
            "content": content,
            "type": msg_type,
            "ts": time.time()
        }
        inbox = MAILBOX_DIR / f"{to_agent}.jsonl"
        with open(inbox, "a") as f:
            f.write(json.dumps(msg) + "\n")

    def read_inbox(self, agent: str) -> list[dict]:
        """读取并清空收件箱（消费式）"""
        inbox = MAILBOX_DIR / f"{agent}.jsonl"
        if not inbox.exists():
            return []
        msgs = [json.loads(line) for line in inbox.read_text().splitlines()]
        inbox.unlink()  # 删除文件（消费）
        return msgs
```

### 1.3 组件交互流程

```
时间线：
t0: 用户 → Lead: "搭建后端：一个人搞不定，组队吧"
t1: Lead 调用 spawn_teammate("alice", "backend dev", "创建数据库 schema")
t2: Lead 调用 spawn_teammate("bob", "frontend dev", "写 API 客户端")

    ┌─────────────────────────────────────────────────────┐
    │ 并行执行                                            │
    │                                                     │
    │   Alice 线程                Bob 线程                │
    │   ┌──────────┐              ┌──────────┐           │
    │   │ LLM 调用 │              │ LLM 调用 │           │
    │   │ bash     │              │ write_file│           │
    │   │ migrate  │              │ client.ts│           │
    │   └──────────┘              └──────────┘           │
    │        │                          │                 │
    │        ▼                          ▼                 │
    │   BUS.send("alice", "lead", "Schema done")          │
    │   BUS.send("bob", "lead", "Client written")         │
    └─────────────────────────────────────────────────────┘

t3: Lead 主循环结束 → 检查 inbox → 注入 history
t4: Lead LLM 看到 alice 和 bob 的结果 → 整合回复用户
```

---

## 二、整体思想

### 2.1 核心问题：上下文窗口瓶颈

**问题场景**：

假设需要"重构整个后端"，涉及：
- 认证模块（3000 行代码）
- 数据库层（2000 行代码）
- API 路由（1500 行代码）
- 测试套件（1000 行代码）

单个 Agent 的问题：
1. **注意力分散**：修 API 路由时，认证模块的细节已经不在上下文里了
2. **上下文溢出**：总代码量超过上下文窗口限制
3. **任务冲突**：同时修改多个模块容易出错

### 2.2 设计理念：分而治之

**核心思想**：将复杂任务分解为可并行的子任务，分配给专门的队友处理

```
传统子 Agent (s06)          vs        Agent Teams (s15)
    │                                    │
    ▼                                    ▼
┌─────────┐                     ┌─────────────────┐
│ Lead    │                     │ Lead            │
│ Agent   │                     │  ├─ Alice       │
│         │                     │  ├─ Bob         │
│ (临时工) │                     │  └─ Charlie     │
└─────────┘                     └─────────────────┘

特点：                         特点：
- 一次性，用完销毁             - 多轮生命周期
- 只回传结论                   - 异步收件箱，随时通信
- 完全隔离                     - 通过消息共享信息
```

### 2.3 关键概念

#### 2.3.1 文件收件箱 (File-based Inbox)

**为什么选择文件而不是内存队列？**

| 维度 | 文件收件箱 | 内存队列 |
|------|-----------|----------|
| 持久化 | 天然持久化 | 需要额外实现 |
| 可观察性 | 可直接查看 | 需要调试工具 |
| 跨线程 | 简单直接 | 需要同步机制 |
| 适用场景 | 教学、生产 | 仅内存场景 |

**收件箱文件结构**：

```
.mailboxes/
├── lead.jsonl       # Lead 的收件箱
├── alice.jsonl      # Alice 的收件箱
└── bob.jsonl        # Bob 的收件箱

# 每行一个消息：
{"from": "alice", "to": "lead", "content": "Schema done", "type": "result", "ts": 1718751234.56}
{"from": "bob", "to": "lead", "content": "Client written", "type": "result", "ts": 1718751235.78}
```

#### 2.3.2 消费式读取 (Consumptive Read)

```python
# 消费式读取：读即删除
msgs = BUS.read_inbox("lead")  # 读取所有消息
# 此时 lead.jsonl 文件已被删除

# 好处：避免重复处理
# 坏处：消息无法回溯（教学版可接受）
```

#### 2.3.3 收件箱注入 (Inbox Injection)

Lead Agent 在每轮主循环结束后检查收件箱，将队友消息注入到对话历史中：

```python
# 主循环结束后
inbox = BUS.read_inbox("lead")
if inbox:
    inbox_text = "\n".join(
        f"From {m['from']}: {m['content'][:200]}" for m in inbox)
    history.append({"role": "user",
                    "content": f"[Inbox]\n{inbox_text}"})
```

**效果**：LLM 在下一轮调用时能看到队友的工作成果

### 2.4 与真实 Claude Code 的对比

| 特性 | 教学版 (s15) | 真实 CC |
|------|-------------|---------|
| 队友生命周期 | 最多 10 轮 | Idle loop（等待消息后继续） |
| 文件锁 | 无 | proper-lockfile（并发安全） |
| 消息类型 | message, result | 15 种结构化消息 |
| 权限处理 | 无 | 权限冒泡机制 |
| 收件箱路径 | `.mailboxes/*.jsonl` | `~/.claude/teams/{team}/inboxes/` |
| 消息注入时机 | 用户输入循环后 | 每 1 秒轮询（useInboxPoller） |

---

## 三、实现细节

### 3.1 代码结构总览

```python
# s15_agent_teams/code.py 结构

# ── 复用的模块 ──
# s12: Task System (任务系统)
# s10: Prompt Assembly (Prompt 组装)
# s13: Background Tasks (后台任务)
# s14: Cron Scheduler (Cron 调度器)

# ── 新增模块 ──
# MessageBus: 文件收件箱
# spawn_teammate_thread: 队友线程启动器
# active_teammates: 活跃队友追踪
# run_spawn_teammate, run_send_message, run_check_inbox: 团队工具
```

### 3.2 MessageBus 实现

```python
MAILBOX_DIR = WORKDIR / ".mailboxes"
MAILBOX_DIR.mkdir(exist_ok=True)

class MessageBus:
    """文件系统实现的消息总线"""

    def send(self, from_agent: str, to_agent: str,
             content: str, msg_type: str = "message"):
        """
        发送消息

        实现细节：
        1. 构造消息字典（包含 from, to, content, type, ts）
        2. 追加写入目标 Agent 的 .jsonl 文件
        3. 打印日志（黄色）
        """
        msg = {
            "from": from_agent,
            "to": to_agent,
            "content": content,
            "type": msg_type,
            "ts": time.time()
        }
        inbox = MAILBOX_DIR / f"{to_agent}.jsonl"
        with open(inbox, "a") as f:
            f.write(json.dumps(msg) + "\n")
        print(f"  \033[33m[bus] {from_agent} → {to_agent}: "
              f"{content[:50]}\033[0m")

    def read_inbox(self, agent: str) -> list[dict]:
        """
        读取并清空收件箱

        实现细节：
        1. 检查文件是否存在
        2. 读取所有行，解析 JSON
        3. 删除文件（消费式读取）
        """
        inbox = MAILBOX_DIR / f"{agent}.jsonl"
        if not inbox.exists():
            return []
        msgs = [json.loads(line) for line in inbox.read_text().splitlines()
                if line.strip()]
        inbox.unlink()  # 删除文件
        return msgs

# 全局单例
BUS = MessageBus()
```

**潜在问题（教学版可接受）**：

```
线程 A: read_inbox("lead")
  ├─ read_text() ← 此时文件存在
  │
线程 B: read_inbox("lead") ← 也能读取
  ├─ read_text()
  │
线程 A: unlink() ← 删除文件
线程 B: unlink() ← 报错或静默失败
```

真实 CC 的解决方案：使用 `proper-lockfile` 保证原子性

### 3.3 spawn_teammate_thread 实现

```python
active_teammates: dict[str, bool] = {}  # 追踪活跃队友

def spawn_teammate_thread(name: str, role: str, prompt: str) -> str:
    """
    启动队友线程

    参数：
    - name: 队友名称（唯一标识）
    - role: 角色描述（如 "backend developer"）
    - prompt: 初始任务提示

    返回：状态字符串
    """
    if name in active_teammates:
        return f"Teammate '{name}' already exists"

    # 构造队友的 system prompt
    system = (f"You are '{name}', a {role}. "
              f"Use tools to complete tasks. "
              f"Send results via send_message to 'lead'.")

    def run():
        """队友的主循环（运行在 daemon 线程中）"""
        messages = [{"role": "user", "content": prompt}]

        # 队友只有 4 个工具
        sub_tools = [
            {"name": "bash", ...},
            {"name": "read_file", ...},
            {"name": "write_file", ...},
            {"name": "send_message", ...},
        ]

        # 最多 10 轮循环
        for _ in range(10):
            # 1. 检查收件箱
            inbox = BUS.read_inbox(name)
            if inbox:
                messages.append({"role": "user",
                                 "content": f"<inbox>{json.dumps(inbox)}</inbox>"})

            # 2. 调用 LLM
            response = client.messages.create(
                model=MODEL, system=system, messages=messages[-20:],
                tools=sub_tools, max_tokens=8000)

            # 3. 检查是否结束
            messages.append({"role": "assistant", "content": response.content})
            if response.stop_reason != "tool_use":
                break

            # 4. 执行工具
            results = []
            for block in response.content:
                if block.type == "tool_use":
                    handler = sub_handlers.get(block.name)
                    output = handler(**block.input) if handler else "Unknown"
                    results.append({"type": "tool_result",
                                    "tool_use_id": block.id,
                                    "content": str(output)})
            messages.append({"role": "user", "content": results})

        # 5. 完成后发送总结给 Lead
        summary = "Done."
        for msg in reversed(messages):
            if msg["role"] == "assistant" and isinstance(msg["content"], list):
                for b in msg["content"]:
                    if getattr(b, "type", None) == "text":
                        summary = b.text
                        break
                else:
                    continue
                break
        BUS.send(name, "lead", summary, "result")

        # 6. 清理
        active_teammates.pop(name, None)
        print(f"  \033[32m[teammate] {name} finished\033[0m")

    # 启动 daemon 线程
    active_teammates[name] = True
    threading.Thread(target=run, daemon=True).start()
    print(f"  \033[36m[teammate] {name} spawned as {role}\033[0m")
    return f"Teammate '{name}' spawned as {role}"
```

**关键设计点**：

1. **独立 messages**：每个队友有自己的对话历史，不与 Lead 共享
2. **简化工具集**：只有 4 个工具，避免队友 spawn 新队友（防止递归）
3. **上下文窗口管理**：`messages[-20:]` 限制历史长度
4. **Daemon 线程**：主进程退出时自动清理
5. **自动汇报**：完成后自动发送总结给 Lead

### 3.4 Lead Agent 的收件箱注入

```python
if __name__ == "__main__":
    history = []
    context = update_context({}, [])

    while True:
        # 用户输入
        query = input("s15 >> ")
        if query.strip().lower() in ("q", "exit", ""):
            break

        # 主循环
        history.append({"role": "user", "content": query})
        agent_loop(history, context)  # Lead 处理
        context = update_context(context, history)

        # 打印 Lead 的回复
        for block in history[-1]["content"]:
            if getattr(block, "type", None) == "text":
                print(block.text)

        # ★ 关键：收件箱注入 ★
        inbox = BUS.read_inbox("lead")
        if inbox:
            inbox_text = "\n".join(
                f"From {m['from']}: {m['content'][:200]}" for m in inbox)
            history.append({"role": "user",
                            "content": f"[Inbox]\n{inbox_text}"})
            print(f"\n\033[33m[Inbox: {len(inbox)} messages injected]\033[0m")
```

**注入时机选择**：

- **教学版**：用户输入循环后（简化）
- **真实 CC**：每 1 秒轮询一次（useInboxPoller），有消息就提交为新的 turn

### 3.5 工具定义对比

```python
# Lead Agent 的工具 (14个)
TOOLS = [
    # 基础操作 (3个)
    {"name": "bash", ...},
    {"name": "read_file", ...},
    {"name": "write_file", ...},

    # 任务系统 (5个)
    {"name": "create_task", ...},
    {"name": "list_tasks", ...},
    {"name": "get_task", ...},
    {"name": "claim_task", ...},
    {"name": "complete_task", ...},

    # Cron 调度 (3个)
    {"name": "schedule_cron", ...},
    {"name": "list_crons", ...},
    {"name": "cancel_cron", ...},

    # ★ 团队协作 (3个) ★
    {"name": "spawn_teammate", ...},
    {"name": "send_message", ...},
    {"name": "check_inbox", ...},
]

# Teammate Agent 的工具 (4个)
TEAMMATE_TOOLS = [
    {"name": "bash", ...},
    {"name": "read_file", ...},
    {"name": "write_file", ...},
    {"name": "send_message", ...},
]
```

**为什么队友没有 spawn_teammate？**

防止递归创建队友。真实 CC 在 `AgentTool.tsx:273` 明确禁止：
```
"teammates spawning other teammates"
```

### 3.6 真实 CC 的 15 种消息类型

教学版只有 `message` 和 `result` 两种类型。真实 CC 有 15 种结构化消息：

| 类型 | 方向 | 用途 | 示例场景 |
|------|------|------|---------|
| `plain text` | 双向 | 普通通信 | 队友间协作 |
| `idle_notification` | 队友→Lead | 完成一轮工作 | 进入空闲等待 |
| `permission_request` | 队友→Lead | 请求操作审批 | 删除文件需要确认 |
| `permission_response` | Lead→队友 | 审批结果 | 允许/拒绝 |
| `plan_approval_request` | 队友→Lead | 提交计划审阅 | 复杂任务前规划 |
| `plan_approval_response` | Lead→队友 | 审批计划 | 同意执行 |
| `shutdown_request` | Lead→队友 | 请求关机 | 任务结束 |
| `shutdown_approved` | 队友→Lead | 确认关机 | 准备就绪 |
| `shutdown_rejected` | 队友→Lead | 拒绝关机 | 还有未完成工作 |
| `task_assignment` | Lead→队友 | 分配任务 | 明确任务边界 |
| `team_permission_update` | Lead→队友 | 广播权限变更 | 新增工具权限 |
| `mode_set_request` | Lead→队友 | 修改权限模式 | 切换自动/手动 |
| `sandbox_permission_*` | 双向 | 网络权限 | 访问外网 |

---

## 四、实际应用场景

### 4.1 场景一：并行开发多个模块

**任务**：重构后端，涉及数据库、API、测试

```python
# 用户输入
"重构后端：更新数据库 schema、修改 API 路由、更新测试"

# Lead Agent 的处理
1. spawn_teammate("alice", "database engineer",
   "Update the user table schema in schema.sql")

2. spawn_teammate("bob", "api developer",
   "Refactor the user API endpoints in routes.py")

3. spawn_teammate("charlie", "test engineer",
   "Update tests for user module in test_user.py")

# 三个队友并行工作
# Alice: bash "psql -f schema.sql"
# Bob: write_file("routes.py", ...)
# Charlie: bash "pytest test_user.py"

# 结果注入
Lead inbox:
  - From alice: "Schema updated successfully"
  - From bob: "API routes refactored"
  - From charlie: "All tests passing"

# Lead 整合并汇报
"重构完成！数据库 schema 已更新，API 已重构，所有测试通过。"
```

### 4.2 场景二：前后端协作

**任务**：开发用户注册功能

```python
# 用户输入
"实现用户注册功能：后端 API + 前端表单"

# Lead Agent 的处理
1. spawn_teammate("backend", "backend developer",
   "Create POST /api/register endpoint with validation")

2. spawn_teammate("frontend", "frontend developer",
   "Create registration form in Register.tsx")

# 后端完成，发送中间结果
BUS.send("backend", "frontend",
         "API ready at POST /api/register. Expects {email, password, name}")

# 前端收到消息，调整代码
inbox = BUS.read_inbox("frontend")
# 前端根据后端的 API 规范编写表单提交逻辑

# 最终汇报
Lead inbox:
  - From backend: "POST /api/register created with validation"
  - From frontend: "Registration form created, integrated with backend API"
```

### 4.3 场景三：代码审查与修复

**任务**：修复代码并请队友审查

```python
# 用户输入
"修复 login.py 的 bug 并让队友审查"

# Lead Agent 的处理
1. read_file("login.py") → 发现问题
2. write_file("login.py", fixed_code)
3. spawn_teammate("reviewer", "code reviewer",
   "Review login.py for potential issues and improvements")

# 审查队友的工作
reviewer 发现问题 → BUS.send("reviewer", "lead", "Found 3 issues: ...")

# Lead 看到审查结果后再次修复
inbox = BUS.read_inbox("lead")
# 处理审查意见
```

### 4.4 场景四：长时间任务监控

**任务**：运行测试套件并监控

```python
# 用户输入
"运行完整测试套件，如果有失败让队友调查"

# Lead Agent 的处理
1. bash("pytest --tb=short", run_in_background=True)

# 后台任务完成，发现失败
<task_notification>
  <task_id>bg_0001</task_id>
  <status>completed</status>
  <command>pytest</command>
  <summary>Failed: test_login, test_register</summary>
</task_notification>

# Lead 启动调查队友
spawn_teammate("investigator", "test debugger",
               "Investigate why test_login and test_register failed")

# 调查队友的工作
investigator:
  1. read_file("test_auth.py")
  2. bash("pytest test_auth.py::test_login -v")
  3. BUS.send("investigator", "lead", "Root cause: missing fixture")

# Lead 汇报
"测试失败，原因已定位：缺少 fixture。详细信息请查看收件箱。"
```

---

## 五、与其他模块的关系

### 5.1 继承关系

```
s01 (基础架构)
  ↓
s04 (错误处理)
  ↓
s05 (Todo Write → 记忆)
  ↓
s06 (子 Agent)
  ↓
s10 (Prompt 组装)
  ↓
s12 (任务系统)
  ↓
s13 (后台任务)
  ↓
s14 (Cron 调度)
  ↓
s15 (Agent Teams) ← 当前
  ↓
s16 (Team Protocols)
```

### 5.2 代码复用

```python
# s15 复用了以下模块的代码

# ── s12: Task System ──
Task dataclass
create_task(), save_task(), load_task()
claim_task(), complete_task()
get_task(), list_tasks()

# ── s10: Prompt Assembly ──
PROMPT_SECTIONS
assemble_system_prompt()
get_system_prompt()

# ── s13: Background Tasks ──
is_slow_operation()
should_run_background()
start_background_task()
collect_background_results()
background_tasks, background_results, background_lock

# ── s14: Cron Scheduler ──
CronJob dataclass
cron_matches(), validate_cron()
schedule_job(), cancel_job()
cron_scheduler_loop()
consume_cron_queue()
```

### 5.3 与 s06 子 Agent 的对比

| 维度 | s06 子 Agent | s15 队友 |
|------|-------------|---------|
| 创建方式 | `Agent` 工具 | `spawn_teammate_thread` |
| 生命周期 | 一次性任务 | 多轮循环（教学版限 10 轮） |
| 通信方式 | 只回传结论 | MessageBus 异步通信 |
| 上下文 | 完全隔离 | 通过消息共享信息 |
| 数量 | 主 Agent + 偶尔子 Agent | 1 Lead + N 队友 |
| 工具集 | 继承主 Agent 工具 | 简化工具集（4 个） |
| 并发性 | 顺序执行 | 并行执行（daemon 线程） |

### 5.4 为 s16 铺路

s15 解决了队友创建和通信问题，但留下了一个问题：

**如何优雅地关闭队友？**

- 直接杀线程 → 可能留下写到一半的文件
- 需要协议 → Lead 发 `shutdown_request`，队友收尾后回复 `shutdown_approved`

这正是 s16 Team Protocols 要解决的问题。

---

## 六、优缺点与最佳实践

### 6.1 优点

#### 6.1.1 真正的并行处理

```python
# 顺序执行（传统方式）
execute_task("database")  # 30s
execute_task("api")       # 20s
execute_task("test")      # 15s
# 总耗时：65s

# 并行执行（Agent Teams）
spawn_teammate("alice", "db", "database task")
spawn_teammate("bob", "api", "api task")
spawn_teammate("charlie", "test", "test task")
# 总耗时：max(30, 20, 15) = 30s
```

#### 6.1.2 上下文隔离

```python
# 每个 Agent 有独立的上下文
# Alice 看不到 Bob 的代码细节
# Bob 看不到 Charlie 的测试细节

# 避免上下文污染和注意力分散
```

#### 6.1.3 专业分工

```python
# 可以根据任务性质创建专业队友
spawn_teammate("alice", "security expert", "Audit auth.py for vulnerabilities")
spawn_teammate("bob", "performance engineer", "Profile the API endpoints")
spawn_teammate("charlie", "documentation writer", "Update README.md")
```

#### 6.1.4 可观察性

```bash
# 直接查看收件箱文件
$ cat .mailboxes/lead.jsonl
{"from": "alice", "to": "lead", "content": "Task done", ...}

# 便于调试和审计
```

### 6.2 缺点

#### 6.2.1 消费式读取的消息丢失风险

```python
# 教学版的实现
msgs = BUS.read_inbox("lead")  # 读取 + 删除
# 如果程序在处理 msgs 之前崩溃，消息永久丢失

# 真实 CC 的解决方案
# 1. 使用 proper-lockfile 保证原子性
# 2. 消息持久化到磁盘
# 3. 处理完成后才删除
```

#### 6.2.2 无消息确认机制

```python
# 当前实现：发后即忘
BUS.send("alice", "bob", "Please review my code")

# 问题：
# 1. Alice 不知道 Bob 是否收到
# 2. Bob 可能正在忙其他事
# 3. 消息优先级无法区分

# 改进方向：
# - 引入消息状态（sent, delivered, read, acked）
# - 引入优先级队列
```

#### 6.2.3 生命周期管理不完整

```python
# 教学版：最多 10 轮后自动结束
for _ in range(10):
    ...

# 问题：
# 1. 如果队友在第 9 轮才开始重要任务？
# 2. 无法优雅地取消正在执行的任务
# 3. 无法暂停和恢复队友

# s16 会解决这些问题
```

#### 6.2.4 资源消耗

```python
# 每个队友是一个 LLM 调用循环
# 3 个队友 = 3 倍 LLM API 调用
# 3 倍 token 消耗

# 建议：
# - 只在真正需要并行时使用
# - 设置合理的队友数量上限
```

### 6.3 最佳实践

#### 6.3.1 明确队友职责

```python
# 好的做法
spawn_teammate("alice", "database expert",
               "Create user table with columns: id, email, password_hash, created_at")

# 不好的做法
spawn_teammate("alice", "developer", "Do something with the database")
```

#### 6.3.2 设置合理的消息内容长度限制

```python
# Lead 收件箱注入时截断
inbox_text = "\n".join(
    f"From {m['from']}: {m['content'][:200]}" for m in inbox)
    #                           ^^^^^^^^ 限制 200 字符

# 防止上下文窗口溢出
```

#### 6.3.3 避免队友嵌套

```python
# 禁止：队友创建队友
# 防止无限递归和资源耗尽

# Teammate 工具集不包含 spawn_teammate
TEAMMATE_TOOLS = ["bash", "read_file", "write_file", "send_message"]
```

#### 6.3.4 使用结构化消息类型

```python
# 教学版
BUS.send("alice", "lead", "Task done", "message")

# 真实 CC 的最佳实践
BUS.send("alice", "lead", {
    "type": "task_completed",
    "task_id": "task_123",
    "result": {"status": "success", "files_created": ["schema.sql"]},
    "summary": "Database schema created successfully"
}, "result")
```

#### 6.3.5 实现消息超时和重试

```python
# 当前实现无超时机制
# 建议：为每个消息添加时间戳，定期清理过期消息

def cleanup_stale_messages(agent: str, max_age_seconds: int = 3600):
    """清理超过 1 小时的旧消息"""
    inbox = MAILBOX_DIR / f"{agent}.jsonl"
    if not inbox.exists():
        return
    msgs = [json.loads(line) for line in inbox.read_text().splitlines()]
    now = time.time()
    fresh_msgs = [m for m in msgs if now - m["ts"] < max_age_seconds]
    inbox.write_text("\n".join(json.dumps(m) for m in fresh_msgs))
```

### 6.4 性能优化建议

#### 6.4.1 批量消息处理

```python
# 当前：每次读一条消息
inbox = BUS.read_inbox("lead")
for m in inbox:
    process_message(m)

# 优化：批量处理
inbox = BUS.read_inbox("lead")
batch_process(inbox)  # 一次性处理所有消息
```

#### 6.4.2 消息优先级

```python
# 当前：FIFO 处理
# 优化：按类型优先级排序

def process_inbox(inbox):
    priority_order = {
        "shutdown_request": 0,    # 最高优先级
        "permission_request": 1,
        "result": 2,
        "message": 3,            # 最低优先级
    }
    sorted_inbox = sorted(inbox,
                          key=lambda m: priority_order.get(m["type"], 99))
    for msg in sorted_inbox:
        process_message(msg)
```

#### 6.4.3 消息压缩

```python
# 对于大型结果（如完整文件内容），使用压缩

import zlib
import base64

def send_large_result(from_agent, to_agent, content):
    """发送大型消息时压缩"""
    compressed = zlib.compress(content.encode())
    encoded = base64.b64encode(compressed).decode()
    BUS.send(from_agent, to_agent, encoded, "compressed_result")
```

---

## 七、总结

### 7.1 核心贡献

s15 Agent Teams 模块引入了多 Agent 协作能力，解决了单 Agent 的上下文窗口瓶颈问题：

1. **MessageBus**：基于文件系统的异步消息总线
2. **spawn_teammate_thread**：轻量级队友线程创建机制
3. **收件箱注入**：Lead Agent 看到队友工作成果的机制

### 7.2 设计亮点

1. **文件收件箱**：直观、可观察、跨线程安全
2. **简化工具集**：队友只有必要工具，避免递归
3. **独立上下文**：每个队友有自己的对话历史
4. **消费式读取**：避免重复处理，简化逻辑

### 7.3 改进方向

1. **消息持久化和确认机制**
2. **优雅的队友关闭协议**（s16 解决）
3. **权限冒泡机制**
4. **资源管理和限流**
5. **消息优先级和超时**

### 7.4 适用场景

- 需要并行处理多个独立任务
- 任务涉及多个专业领域
- 单个 Agent 的上下文窗口不足
- 需要隔离不同模块的修改

### 7.5 不适用场景

- 任务依赖复杂，需要频繁同步
- 消息量巨大，需要高性能队列
- 需要严格的事务保证
- 资源受限，无法承担多 Agent 开销

---

## 附录：完整代码示例

### A. 启动队友并处理结果

```python
# 1. Lead Agent 启动队友
spawn_teammate("alice", "backend developer",
               "Create a REST API for user management in api.py")

spawn_teammate("bob", "frontend developer",
               "Create a React component for user list in UserList.tsx")

# 2. 队友并行工作
# Alice: write_file("api.py", "...")
# Bob: write_file("UserList.tsx", "...")

# 3. 队友完成后发送结果
# BUS.send("alice", "lead", "API created with GET/POST/PUT/DELETE endpoints", "result")
# BUS.send("bob", "lead", "UserList component created with pagination", "result")

# 4. Lead 检查收件箱
inbox = BUS.read_inbox("lead")
# [
#   {"from": "alice", "to": "lead", "content": "API created...", "type": "result"},
#   {"from": "bob", "to": "lead", "content": "UserList component...", "type": "result"}
# ]

# 5. Lead 整合结果
history.append({"role": "user", "content": f"[Inbox]\n{inbox_text}"})
# LLM 下一轮调用时会看到两个队友的工作成果
```

### B. 队友之间的通信

```python
# 场景：后端 API 完成后，前端需要知道 API 规范

# 1. Alice 完成后端 API
BUS.send("alice", "lead", "POST /api/users created", "result")

# 2. Alice 直接通知 Bob（通过 Lead 转发）
BUS.send("alice", "lead",
         "@bob API ready: POST /api/users expects {name, email, password}",
         "message")

# 3. Lead 转发给 Bob
BUS.send("lead", "bob", "From alice: API ready...")

# 4. Bob 收到消息后调整前端代码
inbox = BUS.read_inbox("bob")
# [{"from": "lead", "content": "From alice: API ready..."}]

# 5. Bob 更新前端表单字段
write_file("UserForm.tsx", "...")
```

---

## 参考资料

- [s06 子 Agent 深度解析](../s06_subagent/README_ME.md)
- [s12 任务系统深度解析](../s12_task_system/README_ME.md)
- [s13 后台任务深度解析](../s13_background_tasks/README_ME.md)
- [s14 Cron 调度器深度解析](../s14_cron_scheduler/README_ME.md)
- [Claude Code 官方文档](https://claude.ai/docs)
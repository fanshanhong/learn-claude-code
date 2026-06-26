# s20_comprehensive 深度解析

## 目录

1. [架构设计](#架构设计)
2. [整体思想](#整体思想)
3. [实现细节](#实现细节)
4. [与其他模块的关系](#与其他模块的关系)
5. [实际应用场景](#实际应用场景)
6. [优缺点分析](#优缺点分析)
7. [最佳实践](#最佳实践)

---

## 架构设计

### 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户输入 (CLI)                             │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    UserPromptSubmit Hooks                        │
│                  (日志记录、审计、注入)                           │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Pre-LLM 准备阶段                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ Cron Queue  │  │ Background  │  │   Context Compaction    │  │
│  │   注入      │  │ Notification│  │ (tool_result_budget →  │  │
│  │             │  │   注入      │  │  snip_compact →        │  │
│  │             │  │             │  │  micro_compact →       │  │
│  │             │  │             │  │  compact_history)      │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │         System Prompt Assembly                          │    │
│  │  (identity + tools + workspace + skills + memory + MCP) │    │
│  └─────────────────────────────────────────────────────────┘    │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                      LLM API 调用                                 │
│              (with_retry 错误恢复包装)                           │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │  has tool_use block? │
                    └──────────┬──────────┘
                               │
              ┌────────────────┴────────────────┐
              │ No                              │ Yes
              ▼                                 ▼
┌──────────────────────┐         ┌─────────────────────────────────┐
│    Stop Hooks        │         │    Tool Execution Phase         │
│  (统计、清理、审计)   │         │                                 │
└──────────────────────┘         │  ┌───────────────────────────┐  │
                                 │  │    PreToolUse Hooks       │  │
                                 │  │  (权限检查、日志、审计)     │  │
                                 │  └─────────────┬─────────────┘  │
                                 │                │                │
                                 │                ▼                │
                                 │  ┌───────────────────────────┐  │
                                 │  │    Tool Dispatch          │  │
                                 │  │  ┌─────────────────────┐  │  │
                                 │  │  │ BUILTIN_HANDLERS    │  │  │
                                 │  │  │  - bash, read_file  │  │  │
                                 │  │  │  - write_file, etc. │  │  │
                                 │  │  └─────────────────────┘  │  │
                                 │  │  ┌─────────────────────┐  │  │
                                 │  │  │ MCP Handlers        │  │  │
                                 │  │  │  - mcp__server__tool│  │  │
                                 │  │  └─────────────────────┘  │  │
                                 │  │  ┌─────────────────────┐  │  │
                                 │  │  │ Background Dispatch │  │  │
                                 │  │  │  - 异步执行慢操作    │  │  │
                                 │  │  └─────────────────────┘  │  │
                                 │  └─────────────┬─────────────┘  │
                                 │                │                │
                                 │                ▼                │
                                 │  ┌───────────────────────────┐  │
                                 │  │    PostToolUse Hooks      │  │
                                 │  │  (大输出告警、日志后处理)   │  │  │
                                 │  └─────────────┬─────────────┘  │
                                 └────────────────┼────────────────┘
                                                  │
                                                  ▼
                                  ┌───────────────────────────┐
                                  │    Append tool_result    │
                                  │      to messages[]       │
                                  └─────────────┬─────────────┘
                                                │
                                                │ (循环继续)
                                                │
                                                └─────────────────────┐
                                                                      │
                                                                      ▼
                                                        返回 Pre-LLM 准备阶段
```

### 组件分层架构

```
┌────────────────────────────────────────────────────────────────────┐
│                           应用层 (Application)                      │
│  CLI入口、Cron自动运行循环、用户交互处理                              │
└─────────────────────────────────────────────────────────────────────┘
                                  │
┌─────────────────────────────────────────────────────────────────────┐
│                         Agent 核心层 (Core)                          │
│  agent_loop()、context 管理、message 历史、LLM 调用                  │
└─────────────────────────────────────────────────────────────────────┘
                                  │
┌─────────────────────────────────────────────────────────────────────┐
│                         工具层 (Tools)                               │
│  内置工具 (bash/read/write/edit/glob/todo/task...)                  │
│  MCP 动态工具 (mcp__server__tool)                                   │
│  后台任务工具 (background dispatch)                                  │
└─────────────────────────────────────────────────────────────────────┘
                                  │
┌─────────────────────────────────────────────────────────────────────┐
│                         基础设施层 (Infrastructure)                   │
│  Hooks 系统、权限检查、压缩管线、错误恢复、                            │
│  Cron 调度器、MessageBus、Worktree 管理                               │
└─────────────────────────────────────────────────────────────────────┘
                                  │
┌─────────────────────────────────────────────────────────────────────┐
│                         存储层 (Storage)                             │
│  文件系统 (tasks/.json, worktrees/, mailboxes/, transcripts/)       │
│  内存状态 (CURRENT_TODOS, scheduled_jobs, background_tasks)         │
└─────────────────────────────────────────────────────────────────────┘
```

### 核心数据流

```python
# 主循环的数据流向
messages: list[dict]  # 对话历史
    │
    ├── [注入阶段] ── cron_queue 注入 + background notifications 注入
    │
    ├── [压缩阶段] ── tool_result_budget → snip_compact → micro_compact → compact_history
    │
    ├── [Prompt 组装] ── system_prompt = identity + tools + workspace + skills + memory + MCP
    │
    ├── [LLM 调用] ── response = LLM(system_prompt, messages, tools)
    │
    ├── [响应处理]
    │   ├── 无 tool_use → Stop Hooks → 返回用户
    │   └── 有 tool_use → 执行工具 → tool_result → 追加到 messages → 循环
    │
    └── [工具执行]
        ├── PreToolUse hooks (权限检查)
        ├── Tool Handler 执行
        └── PostToolUse hooks (后处理)
```

---

## 整体思想

### 设计理念：机制很多，循环一个

S20 是整个学习系列的终点章，其核心哲学可以概括为：

> **"机制很多，循环一个"** — 工具、权限、记忆、任务、团队、插件都挂在同一个 `while True` 上。

这个设计理念的深层含义是：

1. **Harness 层复杂性**：Claude Code 的复杂性不是"另一个 agent 大脑"，而是一个成熟 harness（工具框架）的复杂性。模型负责判断和行动选择；harness 负责组织环境、工具、权限、记忆、团队和外部能力。

2. **单循环驱动**：所有机制都通过同一个 agent loop 驱动，保证了：
   - 状态一致性
   - 可预测的执行流程
   - 统一的错误处理和恢复

3. **扩展点设计**：通过 hooks、MCP、skill 等机制，在不修改核心循环的前提下扩展能力。

### 核心概念

#### 1. Agent Loop（代理循环）

```python
# 核心循环结构（简化版）
while True:
    response = LLM(messages, tools)
    if not has_tool_use(response.content):
        return  # 没有工具调用，结束循环
    results = execute_tools(response.content)
    messages.append(tool_results)
```

这是 Claude Code 的心脏。不管添加多少功能，这个基本结构不变。

#### 2. Context Window Management（上下文窗口管理）

上下文是有限资源，S20 实现了四层压缩策略：

```
tool_result_budget  →  压缩大输出到文件
snip_compact        →  裁剪中间消息
micro_compact       →  压缩旧的 tool_result
compact_history     →  用 LLM 生成摘要
```

#### 3. Hooks（钩子系统）

Hooks 是在不修改核心代码的情况下插入自定义逻辑的机制：

```python
HOOKS = {
    "UserPromptSubmit": [],  # 用户提交时触发
    "PreToolUse": [],        # 工具执行前触发（权限检查）
    "PostToolUse": [],       # 工具执行后触发（日志、告警）
    "Stop": []               # 循环结束时触发
}
```

#### 4. Protocol-Based Teamwork（协议驱动团队协作）

通过消息传递和协议状态实现多 Agent 协作：

- **MessageBus**：JSONL 格式的邮箱系统
- **Protocol State**：管理 shutdown、plan approval 等协议状态
- **Autonomous Teammate**：能独立轮询任务板并认领任务的持久化线程

#### 5. Worktree Isolation（工作树隔离）

每个任务可以绑定独立的 git worktree，实现文件系统级别的隔离：

```python
# Worktree 绑定任务
task.worktree = "feature-xyz"  # 绑定到 .worktrees/feature-xyz
# 队友认领后，所有文件操作自动在隔离目录下执行
```

#### 6. MCP (Model Context Protocol)

动态工具发现和连接机制：

```python
# 连接 MCP 服务器后，工具池动态扩展
connect_mcp("docs")  # 发现 mcp__docs__search, mcp__docs__get_version
connect_mcp("deploy")  # 发现 mcp__deploy__trigger, mcp__deploy__status
```

### 要解决的问题

S20 试图解决一个生产级 Coding Agent 面临的所有核心问题：

| 问题 | 解决方案 |
|------|----------|
| 如何管理工具执行？ | 工具分发器 + hooks + permission |
| 如何防止越权操作？ | PreToolUse hook + deny list + 用户确认 |
| 如何保持长期记忆？ | MEMORY.md + 技能目录 + system prompt 组装 |
| 如何处理上下文溢出？ | 四层压缩管线 + reactive compact |
| 如何恢复错误？ | 429/529 重试 + max_tokens 升级 + fallback model |
| 如何执行耗时操作？ | background dispatch + task notification |
| 如何定时触发任务？ | cron scheduler + durable jobs |
| 如何并行处理任务？ | spawn_teammate + MessageBus + worktree |
| 如何扩展外部能力？ | MCP 连接 + 动态工具池组装 |

---

## 实现细节

### 1. Agent Loop 核心实现

```python
def agent_loop(messages: list, context: dict):
    """
    核心代理循环 - 所有机制的入口点
    """
    tools, handlers = assemble_tool_pool()  # 组装工具池
    state = RecoveryState()  # 错误恢复状态
    max_tokens = DEFAULT_MAX_TOKENS

    while True:
        # 阶段1: 注入 cron 触发的任务
        fired = consume_cron_queue()
        for job in fired:
            messages.append({"role": "user",
                           "content": f"[Scheduled] {job.prompt}"})

        # 阶段2: 注入后台任务完成通知
        inject_background_notifications(messages)

        # 阶段3: Todo 提醒机制
        if rounds_since_todo >= 3:
            messages.append({"role": "user",
                           "content": "<reminder>Update your todos.</reminder>"})

        # 阶段4: 上下文压缩
        prepare_context(messages)

        # 阶段5: 调用 LLM（带错误恢复）
        try:
            response = call_llm(messages, context, tools, state, max_tokens)
        except Exception as e:
            # prompt too long 时触发 reactive compact
            if is_prompt_too_long_error(e) and not state.has_attempted_reactive_compact:
                messages[:] = reactive_compact(messages)
                continue
            raise

        # 阶段6: 处理 max_tokens 截断
        if response.stop_reason == "max_tokens":
            if not state.has_escalated:
                max_tokens = ESCALATED_MAX_TOKENS  # 升级到 16000
                state.has_escalated = True
                continue
            # 要求 continuation
            messages.append({"role": "user",
                           "content": CONTINUATION_PROMPT})
            continue

        # 阶段7: 追加响应到历史
        messages.append({"role": "assistant", "content": response.content})

        # 阶段8: 检查是否有工具调用
        if not has_tool_use(response.content):
            trigger_hooks("Stop", messages)  # 触发停止钩子
            return

        # 阶段9: 执行工具
        results = []
        for block in response.content:
            if block.type != "tool_use":
                continue

            # compact 是特殊工具，直接执行压缩
            if block.name == "compact":
                messages[:] = compact_history(messages)
                break

            # PreToolUse hooks（包括权限检查）
            blocked = trigger_hooks("PreToolUse", block)
            if blocked:
                results.append({"type": "tool_result",
                              "tool_use_id": block.id,
                              "content": str(blocked)})
                continue

            # 判断是否需要后台执行
            if should_run_background(block.name, block.input):
                bg_id = start_background_task(block, handlers)
                output = f"[Background task {bg_id} started]"
            else:
                # 同步执行工具
                handler = handlers.get(block.name)
                output = call_tool_handler(handler, block.input, block.name)
                trigger_hooks("PostToolUse", block, output)

            results.append({"type": "tool_result",
                          "tool_use_id": block.id,
                          "content": output})

        # 阶段10: 追加工具结果，继续循环
        messages.append({"role": "user", "content": build_user_content(results)})
```

### 2. Hooks 系统实现

```python
# Hooks 注册表
HOOKS = {"UserPromptSubmit": [], "PreToolUse": [],
         "PostToolUse": [], "Stop": []}

def register_hook(event: str, callback):
    """注册钩子函数"""
    HOOKS[event].append(callback)

def trigger_hooks(event: str, *args):
    """触发钩子，返回第一个非 None 结果"""
    for callback in HOOKS[event]:
        result = callback(*args)
        if result is not None:
            return result
    return None

# 权限检查钩子
def permission_hook(block):
    """
    PreToolUse 钩子 - 在工具执行前检查权限
    返回非 None 值会阻止工具执行
    """
    if block.name == "bash":
        command = block.input.get("command", "")
        # 检查黑名单命令
        for pattern in DENY_LIST:
            if pattern in command:
                return f"Permission denied: '{pattern}' is on the deny list"
        # 检查破坏性命令，需要用户确认
        if any(token in command for token in DESTRUCTIVE):
            print(f"\n[permission] destructive command")
            choice = input("  Allow? [y/N] ").strip().lower()
            if choice not in ("y", "yes"):
                return "Permission denied by user"
    return None  # 允许执行

# 注册钩子
register_hook("PreToolUse", permission_hook)
register_hook("PreToolUse", log_hook)  # 日志记录
register_hook("PostToolUse", large_output_hook)  # 大输出告警
register_hook("Stop", stop_hook)  # 统计
```

### 3. 上下文压缩管线

```python
def prepare_context(messages: list) -> list:
    """
    四层压缩管线 - 在调用 LLM 前执行
    """
    # 第一层: 处理大输出
    messages[:] = tool_result_budget(messages)

    # 第二层: 裁剪中间消息
    messages[:] = snip_compact(messages)

    # 第三层: 压缩旧的 tool_result
    messages[:] = micro_compact(messages)

    # 第四层: 如果还是太大，用 LLM 生成摘要
    if estimate_size(messages) > CONTEXT_LIMIT:
        messages[:] = compact_history(messages)

    return messages

def tool_result_budget(messages: list, max_bytes: int = 200_000) -> list:
    """
    第一层压缩：将超大输出持久化到文件，只在消息中保留预览
    """
    # 找到最后一条消息中的 tool_result blocks
    last = messages[-1]
    content = last.get("content")
    if last.get("role") != "user" or not isinstance(content, list):
        return messages

    blocks = [(i, b) for i, b in enumerate(content)
              if isinstance(b, dict) and b.get("type") == "tool_result"]

    total = sum(len(str(b.get("content", ""))) for _, b in blocks)
    if total <= max_bytes:
        return messages

    # 从大到小持久化
    for _, block in sorted(blocks, key=lambda p: len(str(p[1].get("content", ""))), reverse=True):
        if total <= max_bytes:
            break
        text = str(block.get("content", ""))
        block["content"] = persist_large_output(
            block.get("tool_use_id", "unknown"), text)
        total = sum(len(str(b.get("content", ""))) for _, b in blocks)

    return messages

def compact_history(messages: list) -> list:
    """
    第四层压缩：用 LLM 生成摘要，保存完整历史到 transcript
    """
    transcript = write_transcript(messages)  # 保存完整历史
    summary = summarize_history(messages)    # LLM 生成摘要
    return [{"role": "user", "content": f"[Compacted]\n\n{summary}"}]
```

### 4. 错误恢复机制

```python
class RecoveryState:
    """错误恢复状态追踪"""
    def __init__(self):
        self.has_escalated = False           # 是否已升级 max_tokens
        self.recovery_count = 0              # continuation 恢复计数
        self.consecutive_529 = 0             # 连续 529 错误计数
        self.has_attempted_reactive_compact = False  # 是否已尝试 reactive compact
        self.current_model = PRIMARY_MODEL   # 当前使用的模型

def with_retry(fn, state: RecoveryState):
    """
    带重试的 LLM 调用包装器
    处理 429 (rate limit) 和 529 (overloaded) 错误
    """
    for attempt in range(MAX_RETRIES):
        try:
            result = fn()
            state.consecutive_529 = 0  # 重置 529 计数
            return result
        except Exception as e:
            name = type(e).__name__.lower()
            msg = str(e).lower()

            # 处理 rate limit (429)
            if "ratelimit" in name or "429" in msg:
                delay = retry_delay(attempt)  # 指数退避
                print(f"[429] retry {attempt + 1}/{MAX_RETRIES} after {delay:.1f}s")
                time.sleep(delay)
                continue

            # 处理 server overloaded (529)
            if "overloaded" in name or "529" in msg or "overloaded" in msg:
                state.consecutive_529 += 1
                # 连续多次 529 时切换到 fallback model
                if state.consecutive_529 >= MAX_CONSECUTIVE_529 and FALLBACK_MODEL:
                    state.current_model = FALLBACK_MODEL
                    state.consecutive_529 = 0
                    print(f"[529] switching to {FALLBACK_MODEL}")
                delay = retry_delay(attempt)
                print(f"[529] retry {attempt + 1}/{MAX_RETRIES} after {delay:.1f}s")
                time.sleep(delay)
                continue
            raise
    raise RuntimeError(f"Max retries ({MAX_RETRIES}) exceeded")
```

### 5. 后台任务系统

```python
# 后台任务状态
background_tasks: dict[str, dict] = {}
background_results: dict[str, str] = {}
background_lock = threading.Lock()

def should_run_background(tool_name: str, tool_input: dict) -> bool:
    """
    判断是否需要后台执行
    - 明确指定 run_in_background=True
    - 或检测到慢操作关键词 (install, build, test, deploy...)
    """
    if tool_name != "bash":
        return False
    command = tool_input.get("command", "").lower()
    slow_keywords = ["install", "build", "test", "deploy", "compile",
                    "docker build", "pip install", "npm install",
                    "cargo build", "pytest", "make"]
    return bool(tool_input.get("run_in_background")) or is_slow_operation(tool_name, tool_input)

def start_background_task(block, handlers: dict) -> str:
    """
    启动后台任务，立即返回占位结果
    """
    bg_id = f"bg_{_bg_counter:04d}"
    _bg_counter += 1

    def worker():
        # 在后台线程中执行
        handler = handlers.get(block.name)
        result = call_tool_handler(handler, block.input, block.name)
        trigger_hooks("PostToolUse", block, result)
        with background_lock:
            background_tasks[bg_id]["status"] = "completed"
            background_results[bg_id] = str(result)

    with background_lock:
        background_tasks[bg_id] = {
            "tool_use_id": block.id,
            "command": command,
            "status": "running",
        }
    threading.Thread(target=worker, daemon=True).start()
    return bg_id

def collect_background_results() -> list[str]:
    """
    收集已完成的后台任务，生成 task_notification
    """
    with background_lock:
        ready = [bg_id for bg_id, task in background_tasks.items()
                 if task["status"] == "completed"]

    notifications = []
    for bg_id in ready:
        with background_lock:
            task = background_tasks.pop(bg_id)
            output = background_results.pop(bg_id, "")
        notifications.append(
            f"<task_notification>\n"
            f"  <task_id>{bg_id}</task_id>\n"
            f"  <status>completed</status>\n"
            f"  <summary>{output[:200]}</summary>\n"
            f"</task_notification>")
    return notifications
```

### 6. Cron 调度器

```python
@dataclass
class CronJob:
    id: str
    cron: str           # 5 字段 cron 表达式
    prompt: str         # 触发时注入的 prompt
    recurring: bool     # 是否重复
    durable: bool       # 是否持久化

scheduled_jobs: dict[str, CronJob] = {}
cron_queue: list[CronJob] = []  # 待触发的任务队列

def cron_scheduler_loop():
    """
    Cron 调度器 - 独立 daemon 线程
    每秒检查一次是否有任务需要触发
    """
    while True:
        time.sleep(1)
        now = datetime.now()
        marker = now.strftime("%Y-%m-%d %H:%M")  # 防止同一分钟内重复触发
        with cron_lock:
            for job in list(scheduled_jobs.values()):
                try:
                    if cron_matches(job.cron, now) and _last_fired.get(job.id) != marker:
                        cron_queue.append(job)  # 加入触发队列
                        _last_fired[job.id] = marker
                        if not job.recurring:
                            scheduled_jobs.pop(job.id, None)
                except Exception as e:
                    print(f"[cron error] {job.id}: {e}")

def cron_matches(cron_expr: str, dt: datetime) -> bool:
    """
    解析 cron 表达式并匹配当前时间
    支持: *, */n, n-m, n,m
    """
    fields = cron_expr.strip().split()  # minute hour dom month dow
    if len(fields) != 5:
        return False
    minute, hour, dom, month, dow = fields
    dow_val = (dt.weekday() + 1) % 7  # 0=Sunday
    # ... 各字段匹配逻辑
```

### 7. 团队协作系统

```python
class MessageBus:
    """
    消息总线 - 基于 JSONL 文件的邮箱系统
    支持跨线程、跨进程通信
    """
    def send(self, from_agent: str, to_agent: str, content: str,
             msg_type: str = "message", metadata: dict = None):
        msg = {"from": from_agent, "to": to_agent,
               "content": content, "type": msg_type,
               "ts": time.time(), "metadata": metadata or {}}
        inbox = MAILBOX_DIR / f"{to_agent}.jsonl"
        with open(inbox, "a") as f:
            f.write(json.dumps(msg) + "\n")

    def read_inbox(self, agent: str) -> list[dict]:
        """读取并清空邮箱"""
        inbox = MAILBOX_DIR / f"{to_agent}.jsonl"
        if not inbox.exists():
            return []
        msgs = [json.loads(line) for line in inbox.read_text().splitlines()
                if line.strip()]
        inbox.unlink()  # 读取后删除
        return msgs

# 协议状态管理
pending_requests: dict[str, ProtocolState] = {}

@dataclass
class ProtocolState:
    request_id: str
    type: str          # "shutdown" 或 "plan_approval"
    sender: str
    target: str
    status: str        # "pending", "approved", "rejected"
    payload: str
    created_at: float = field(default_factory=time.time)

def spawn_teammate_thread(name: str, role: str, prompt: str) -> str:
    """
    启动一个持久化的队友线程
    - 有独立的 messages 历史
    - 可以认领任务、绑定 worktree
    - 支持协议交互（shutdown request、plan approval）
    """
    def run():
        wt_ctx = {"path": None}  # worktree 上下文

        def _wt_cwd():
            # 如果绑定了 worktree，文件操作在隔离目录下执行
            p = wt_ctx["path"]
            return Path(p) if p else None

        messages = [{"role": "user", "content": prompt}]

        while True:
            # 检查邮箱
            inbox = BUS.read_inbox(name)
            for msg in inbox:
                if handle_inbox_message(name, msg, messages):
                    return  # shutdown

            # 调用模型
            response = client.messages.create(
                model=MODEL, system=system, messages=messages[-20:],
                tools=sub_tools, max_tokens=8000)
            messages.append({"role": "assistant", "content": response.content})

            # 执行工具...

            # 如果等待 plan approval，暂停并轮询
            if protocol_ctx["waiting_plan"]:
                idle_poll(name, messages, ...)
                continue

            # 空闲时轮询任务板
            idle_result = idle_poll(name, messages, name, role, wt_ctx)
            if idle_result in ("shutdown", "timeout"):
                break

        # 完成后发送结果
        BUS.send(name, "lead", summary, "result")
        active_teammates.pop(name, None)

    threading.Thread(target=run, daemon=True).start()
    return f"Teammate '{name}' spawned as {role}"
```

### 8. MCP 集成

```python
class MCPClient:
    """MCP 客户端 - 模拟 MCP 协议"""
    def __init__(self, name: str):
        self.name = name
        self.tools: list[dict] = []
        self._handlers: dict[str, callable] = {}

    def register(self, tool_defs: list[dict], handlers: dict[str, callable]):
        """注册工具定义和处理器"""
        self.tools = tool_defs
        self._handlers = handlers

    def call_tool(self, tool_name: str, args: dict) -> str:
        """调用工具"""
        handler = self._handlers.get(tool_name)
        if not handler:
            return f"MCP error: unknown tool '{tool_name}'"
        return handler(**args)

def connect_mcp(name: str) -> str:
    """连接 MCP 服务器"""
    if name in mcp_clients:
        return f"MCP server '{name}' already connected"
    factory = MOCK_SERVERS.get(name)
    mcp_client = factory()
    mcp_clients[name] = mcp_client
    return f"Connected to MCP server '{name}'"

def assemble_tool_pool() -> tuple[list[dict], dict]:
    """
    组装工具池 - 合并内置工具和 MCP 工具
    MCP 工具命名规范: mcp__{server}__{tool}
    """
    tools = list(BUILTIN_TOOLS)
    handlers = dict(BUILTIN_HANDLERS)

    for server_name, mcp_client in mcp_clients.items():
        safe_server = normalize_mcp_name(server_name)
        for tool_def in mcp_client.tools:
            safe_tool = normalize_mcp_name(tool_def["name"])
            prefixed = f"mcp__{safe_server}__{safe_tool}"
            tools.append({
                "name": prefixed,
                "description": tool_def.get("description", ""),
                "input_schema": tool_def.get("inputSchema", {}),
            })
            handlers[prefixed] = lambda *, c=mcp_client, t=tool_def["name"], **kw: c.call_tool(t, kw)

    return tools, handlers
```

### 9. Worktree 隔离

```python
def create_worktree(name: str, task_id: str = "") -> str:
    """
    创建隔离的 git worktree
    - 验证名称合法性
    - 检查是否已存在
    - 创建独立分支 wt/{name}
    - 可选绑定到任务
    """
    err = validate_worktree_name(name)
    if err:
        return f"Error: {err}"

    if task_id:
        try:
            load_task(task_id)
        except FileNotFoundError:
            return f"Error: task {task_id} not found"

    path = WORKTREES_DIR / name
    if path.exists():
        return f"Worktree '{name}' already exists at {path}"

    # 创建 git worktree
    ok, result = run_git(["worktree", "add", str(path), "-b", f"wt/{name}", "HEAD"])
    if not ok:
        return f"Git error: {result}"

    # 绑定到任务
    if task_id:
        bind_task_to_worktree(task_id, name)

    return f"Worktree '{name}' created at {path}"

def remove_worktree(name: str, discard_changes: bool = False) -> str:
    """
    移除 worktree
    - 默认拒绝有未提交更改的 worktree
    - 需要 discard_changes=True 强制移除
    """
    path = WORKTREES_DIR / name
    if not path.exists():
        return f"Worktree '{name}' not found"

    if not discard_changes:
        files, commits = _count_worktree_changes(path)
        if files > 0 or commits > 0:
            return f"Worktree '{name}' has {files} file(s), {commits} commit(s). Use discard_changes=true"

    run_git(["worktree", "remove", str(path), "--force"])
    run_git(["branch", "-D", f"wt/{name}"])
    return f"Worktree '{name}' removed"
```

---

## 与其他模块的关系

### 前置章节依赖关系

```
s01_dispatch        → 工具分发机制（BUILTIN_TOOLS + BUILTIN_HANDLERS）
s02_permission      → PreToolUse hooks + permission_hook
s03_hooks           → HOOKS 字典 + trigger_hooks
s04_todo            → todo_write + CURRENT_TODOS
s05_subagent        → spawn_subagent + SUB_TOOLS
s06_skill           → scan_skills + load_skill
s07_compact         → 四层压缩管线
s08_memory          → MEMORY.md + assemble_system_prompt
s09_error_recovery  → with_retry + RecoveryState
s10_prompt          → assemble_system_prompt
s11_task_system     → Task dataclass + 任务持久化
s12_background      → background_tasks + start_background_task
s13_cron            → CronJob + cron_scheduler_loop
s14_team            → MessageBus + spawn_teammate_thread
s15_protocol        → ProtocolState + plan approval
s16_autonomous      → idle_poll + scan_unclaimed_tasks
s17_worktree        → create/remove/keep_worktree
s18_mcp             → MCPClient + assemble_tool_pool
s19_final           → 整合测试
s20_comprehensive   → 全部机制的最终合成
```

### 组件对应表

| 章节 | S20 中对应的实现 |
|------|-----------------|
| s01 | `BUILTIN_TOOLS`, `BUILTIN_HANDLERS`, `call_tool_handler()` |
| s02 | `permission_hook()`, `DENY_LIST`, `DESTRUCTIVE` |
| s03 | `HOOKS`, `register_hook()`, `trigger_hooks()` |
| s04 | `run_todo_write()`, `CURRENT_TODOS`, `rounds_since_todo` |
| s05 | `spawn_subagent()`, `SUB_TOOLS`, `SUB_HANDLERS` |
| s06 | `scan_skills()`, `load_skill()`, `SKILL_REGISTRY` |
| s07 | `prepare_context()`, `tool_result_budget()` ... `compact_history()` |
| s08 | `MEMORY_DIR`, `MEMORY_INDEX`, context 更新 |
| s09 | `with_retry()`, `RecoveryState`, `is_prompt_too_long_error()` |
| s10 | `assemble_system_prompt()`, `PROMPT_SECTIONS` |
| s11 | `Task` dataclass, `create_task()` ... `complete_task()` |
| s12 | `start_background_task()`, `collect_background_results()` |
| s13 | `CronJob`, `cron_scheduler_loop()`, `schedule_job()` |
| s14 | `MessageBus`, `spawn_teammate_thread()` |
| s15 | `ProtocolState`, `pending_requests`, `run_request_plan()` |
| s16 | `idle_poll()`, `scan_unclaimed_tasks()` |
| s17 | `create_worktree()`, `remove_worktree()`, `keep_worktree()` |
| s18 | `MCPClient`, `connect_mcp()`, `assemble_tool_pool()` |

---

## 实际应用场景

### 场景1：长时间运行的构建任务

```python
# 用户请求
"Run npm install and then analyze the package.json"

# Agent 自动检测到这是一个慢操作
# 返回后台占位结果
[Background task bg_0001 started]

# 用户继续其他工作
# 构建完成后自动注入通知
<task_notification>
  <task_id>bg_0001</task_id>
  <status>completed</status>
  <summary>added 125 packages...</</task_notification>
```

### 场景2：定时提醒

```python
# 用户请求
"Remind me about the meeting in 3 minutes"

# Agent 创建 cron job
schedule_cron("45 14 * * *", "Meeting reminder: standup", recurring=False)

# 3 分钟后自动触发
[Scheduled] Meeting reminder: standup
```

### 场景3：多 Agent 协作

```python
# Lead Agent
spawn_teammate("alice", "frontend engineer", "Work on the UI components")
spawn_teammate("bob", "backend engineer", "Work on the API endpoints")

# 创建任务并绑定 worktree
create_task("Implement login UI", blockedBy=[])
create_task("Implement auth API", blockedBy=[])
create_worktree("login-ui", task_id="task_001")
create_worktree("auth-api", task_id="task_002")

# Alice 和 Bob 自动认领任务
# Alice 在 .worktrees/login-ui/ 下工作
# Bob 在 .worktrees/auth-api/ 下工作

# Lead 审批 Alice 的计划
request_plan("alice", "Login UI implementation")
review_plan("req_123456", approve=True)
```

### 场景4：MCP 工具使用

```python
# 连接文档服务器
connect_mcp("docs")

# 下一轮工具池自动包含 MCP 工具
# mcp__docs__search
# mcp__docs__get_version

# 使用 MCP 工具
mcp__docs__search(query="agent loop")
# -> "[docs] Found 3 results for 'agent loop'"
```

### 场景5：上下文压缩

```python
# 当对话历史过长时
# 第一层：大输出持久化
<persisted-output>
Full output: .task_outputs/tool-results/toolu_xxx.txt
Preview: first 2000 chars...
</persisted-output>

# 第二层：裁剪中间消息
[snipped 15 messages]

# 第三层：压缩旧 tool_result
[Earlier tool result compacted. Re-run if needed.]

# 第四层：LLM 摘要
[Compacted]
Summary of earlier conversation...
```

---

## 优缺点分析

### 优点

1. **架构清晰**：单循环驱动所有机制，易于理解和维护

2. **模块化设计**：各组件职责明确，可以独立测试和修改

3. **扩展性好**：
   - Hooks 系统支持无侵入扩展
   - MCP 支持动态工具发现
   - Skills 支持按需加载

4. **健壮性强**：
   - 多层错误恢复（重试、fallback model、reactive compact）
   - 上下文管理防止溢出
   - 权限检查防止越权

5. **协作能力**：
   - Worktree 隔离支持并行工作
   - MessageBus 支持异步通信
   - 协议支持审批流程

6. **生产就绪**：
   - Cron 支持持久化任务
   - 后台任务不阻塞主循环
   - 完整的日志和审计

### 缺点

1. **资源消耗**：每个 teammate 独立 LLM 调用，成本较高

2. **调试复杂**：多线程协作时，状态追踪困难

3. **文件 IO 频繁**：任务、邮箱、transcript 都使用文件存储，可能有性能瓶颈

4. **MCP 模拟**：当前是 mock 实现，真实 MCP 协议更复杂

5. **错误处理粒度**：某些错误场景处理不够细致（如 worktree 冲突）

6. **测试覆盖**：代码缺少单元测试，依赖手动验证

---

## 最佳实践

### 1. Hooks 设计

```python
# 推荐：Hooks 应该是纯函数或无副作用操作
def log_hook(block):
    print(f"[HOOK] {block.name}")
    return None  # 不阻断执行

# 推荐：权限检查应该明确返回原因
def permission_hook(block):
    if is_dangerous(block):
        return f"Permission denied: {reason}"
    return None  # 允许执行

# 不推荐：在 Hooks 中修改全局状态
def bad_hook(block):
    global_some_state = modified  # 避免
    return None
```

### 2. 上下文管理

```python
# 推荐：定期主动压缩
if estimate_size(messages) > CONTEXT_LIMIT * 0.8:
    messages = compact_history(messages)

# 推荐：大输出立即持久化
if len(output) > PERSIST_THRESHOLD:
    output = persist_large_output(tool_use_id, output)

# 不推荐：等到 overflow 才处理
# reactive compact 是最后的补救措施
```

### 3. 任务设计

```python
# 推荐：任务粒度适中
create_task("Implement user authentication", blockedBy=[])
create_task("Add login page", blockedBy=["task_auth"])

# 不推荐：任务过大或过小
create_task("Build entire system")  # 太大
create_task("Add one line")  # 太小
```

### 4. 协作模式

```python
# 推荐：使用 worktree 隔离
create_worktree("feature-x", task_id="task_001")
spawn_teammate("dev", "developer", "Work on feature-x")

# 推荐：使用协议进行审批
request_plan("dev", "Plan for feature-x")
# 等待 dev 提交计划
# Lead 审批
review_plan(request_id, approve=True)

# 不推荐：无隔离并行
# 多个 agent 在同一目录工作会导致冲突
```

### 5. 错误处理

```python
# 推荐：区分可恢复和不可恢复错误
try:
    result = call_tool(handler, input)
except RateLimitError:
    # 可恢复：重试
    time.sleep(retry_delay)
    continue
except PermissionError:
    # 不可恢复：返回给用户
    return f"Error: {e}"

# 推荐：记录完整的 recovery state
state = RecoveryState()
state.has_escalated = True  # 跟踪是否已升级 max_tokens
```

### 6. MCP 集成

```python
# 推荐：按需连接
if need_docs:
    connect_mcp("docs")

# 推荐：检查工具可用性
tools, handlers = assemble_tool_pool()
if "mcp__deploy__trigger" in [t["name"] for t in tools]:
    # 可以使用部署工具

# 不推荐：连接不使用的服务器
# 会增加 tool choice 的复杂性
```

---

## 总结

S20_comprehensive 是整个学习系列的集大成者，展示了如何将 19 个独立章节的机制整合到一个统一的 Agent 循环中。它的核心价值在于：

1. **架构示范**：展示了生产级 Agent 的完整架构
2. **机制整合**：演示了如何让多种机制和谐共存
3. **扩展模式**：提供了添加新功能的参考模式

最重要的是理解这个设计哲学：

> 模型负责判断和行动选择，Harness 负责组织环境、工具、权限、记忆、团队和外部能力。

这就是 Claude Code 的本质 — 一个精心设计的 Harness，让模型的能力得以最大化发挥。
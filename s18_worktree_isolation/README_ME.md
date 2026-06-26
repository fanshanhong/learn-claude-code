# s18_worktree_isolation 深度解析

> 本文档从架构设计、整体思想、实现细节三个维度深入解析 Worktree Isolation 模块

---

## 目录

1. [架构设计](#架构设计)
2. [整体思想](#整体思想)
3. [实现细节](#实现细节)
4. [实际应用场景](#实际应用场景)
5. [与其他模块的关系](#与其他模块的关系)
6. [优缺点分析](#优缺点分析)
7. [最佳实践](#最佳实践)

---

## 架构设计

### 1. 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                         Lead Agent                               │
│  (主控 Agent，负责任务创建、worktree 管理、协议协调)               │
└──────────────┬──────────────────────────────────────────────────┘
               │
               ├──────────────┬──────────────┬──────────────┐
               │              │              │              │
               ▼              ▼              ▼              ▼
        ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
        │Task System│   │Worktree  │   │MessageBus│   │Protocol  │
        │          │   │ System   │   │          │   │ State    │
        └──────────┘   └──────────┘   └──────────┘   └──────────┘
               │              │              │              │
               │              │              │              │
               ▼              ▼              ▼              ▼
        ┌─────────────────────────────────────────────────────────┐
        │                    Teammate Agents                       │
        │  (自治 Agent，自动认领任务，在独立 worktree 中工作)        │
        └─────────────────────────────────────────────────────────┘

文件系统结构:
├── .tasks/                    # 任务存储
│   ├── task_xxx.json          # 任务文件(含 worktree 字段)
│   └── ...
├── .worktrees/                # worktree 根目录
│   ├── auth/                  # worktree 目录(分支: wt/auth)
│   │   └── (任务#1 工作空间)
│   ├── ui/                    # worktree 目录(分支: wt/ui)
│   │   └── (任务#2 工作空间)
│   └── events.jsonl           # 生命周期事件日志
├── .mailboxes/                # 消息邮箱
│   ├── alice.jsonl
│   ├── bob.jsonl
│   └── lead.jsonl
└── (主仓库)
```

### 2. 核心组件

#### 2.1 Task System (任务系统)

**继承自 s12，新增 worktree 字段**

```python
@dataclass
class Task:
    id: str                      # 任务唯一标识
    subject: str                 # 任务主题
    description: str             # 详细描述
    status: str                  # pending | in_progress | completed
    owner: str | None            # 认领者
    blockedBy: list[str]         # 依赖任务列表
    worktree: str | None = None  # 【s18 新增】绑定的 worktree 名称
```

**关键方法**:
- `create_task()`: 创建任务(状态 pending)
- `claim_task()`: 认领任务(pending → in_progress)
- `complete_task()`: 完成任务(in_progress → completed)
- `can_start()`: 检查依赖是否全部完成

#### 2.2 Worktree System (工作树系统)

**s18 全新引入，实现目录隔离**

```python
# 核心函数
validate_worktree_name(name)        # 校验名称安全性
create_worktree(name, task_id)      # 创建并可选绑定任务
bind_task_to_worktree(task_id, name) # 绑定任务(不改状态)
remove_worktree(name, discard)      # 删除(有改动时需确认)
keep_worktree(name)                 # 保留供人工 review
```

**设计要点**:
1. **名称校验**: 只允许 `[A-Za-z0-9._-]{1,64}`，防止路径穿越
2. **分支命名**: `wt/{name}`，与 worktree 目录对应
3. **任务绑定**: 只写 worktree 字段，状态保持 pending
4. **安全删除**: 有未提交改动时默认拒绝

#### 2.3 MessageBus (消息总线)

**继承自 s15，实现 Agent 间通信**

```python
class MessageBus:
    def send(from_agent, to_agent, content, msg_type, metadata)
    def read_inbox(agent) -> list[dict]
```

支持消息类型:
- `message`: 普通消息
- `shutdown_request`: 关闭请求
- `shutdown_response`: 关闭响应
- `plan_approval_request`: 计划审批请求
- `plan_approval_response`: 计划审批响应

#### 2.4 Protocol State (协议状态)

**继承自 s16，实现协议式协作**

```python
@dataclass
class ProtocolState:
    request_id: str      # 请求唯一标识
    type: str            # shutdown | plan_approval
    sender: str          # 发送者
    target: str          # 接收者
    status: str          # pending | approved | rejected
    payload: str         # 内容(如计划文本)
```

协议流程:
```
Lead                    Teammate
  │                          │
  ├──── shutdown_request ────▶
  │                          │
  ◀──── shutdown_response ───┤
  │                          │
  ├──── plan_approval ───────▶
  │                          │
  ◀──── plan_response ───────┤
```

#### 2.5 Autonomous Agent (自治 Agent)

**继承自 s17，增强 worktree cwd 支持**

核心机制:
1. **WORK-IDLE 循环**: 工作 → 空闲轮询 → 工作
2. **自动认领**: 空闲时扫描可认领任务
3. **目录切换**: 认领带 worktree 的任务时自动切换 cwd

```python
# 队友线程内部
wt_ctx = {"path": None}  # 当前 worktree 路径

def _run_bash(command):
    return run_bash(command, cwd=wt_ctx["path"])  # 在 worktree 下执行

def _run_claim_task(task_id):
    result = claim_task(task_id, owner=name)
    if "Claimed" in result:
        task = load_task(task_id)
        if task.worktree:
            wt_ctx["path"] = str(WORKTREES_DIR / task.worktree)  # 切换目录
    return result
```

### 3. 组件间交互流程

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Lead 创建任务和 worktree                                      │
│    create_task("重构认证模块")                                   │
│    create_worktree("auth", task_id="task_xxx")                  │
│    → task_xxx.worktree = "auth"                                 │
│    → .worktrees/auth/ 创建(分支 wt/auth)                        │
└─────────────────────────────────────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. Teammate 空闲轮询，自动认领                                   │
│    idle_poll() → scan_unclaimed_tasks()                        │
│    → 发现 task_xxx (pending, 无 owner, 依赖已满足)               │
│    → claim_task(task_xxx)                                       │
│    → task_xxx.status = "in_progress"                            │
│    → task_xxx.owner = "alice"                                  │
│    → wt_ctx["path"] = ".worktrees/auth"                         │
└─────────────────────────────────────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. Teammate 在隔离目录工作                                       │
│    bash("vim config.py")  → 在 .worktrees/auth/config.py        │
│    write_file("app.py", ...) → 写入 .worktrees/auth/app.py      │
│    (不影响其他 worktree 和主仓库)                                │
└─────────────────────────────────────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. Teammate 完成任务                                             │
│    complete_task(task_xxx)                                      │
│    → task_xxx.status = "completed"                             │
│    → wt_ctx["path"] = None                                      │
└─────────────────────────────────────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. Lead 清理或保留 worktree                                      │
│    remove_worktree("auth", discard_changes=True)                │
│    → 删除 .worktrees/auth/ 和分支 wt/auth                       │
│                                                                 │
│    或 keep_worktree("auth")                                     │
│    → 保留供人工 review，之后手动合并到主分支                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## 整体思想

### 1. 核心问题

**s17 及之前的问题**:
- 所有 Agent 共享同一个工作目录 `WORKDIR`
- 多个 Agent 同时修改同一文件 → **互相覆盖**
- 无法区分改动归属 → **无法干净回滚**
- 并行任务冲突 → **协调成本高**

**示例场景**:
```python
# Lead 创建两个任务
create_task("重构认证模块", blockedBy=[])
create_task("重构 UI 登录页", blockedBy=[])

# Alice 和 Bob 认领后都在 WORKDIR 工作
# Alice: write_file("config.py", new_auth_config)
# Bob:   write_file("config.py", new_ui_config)
# 结果: 后写入的覆盖先写入的，Alice 的工作丢失！
```

### 2. 解决方案理念

**核心思想: "各干各的目录，互不干扰"**

```
任务管目标 → 我要做什么
worktree 管目录 → 我在哪做
按 ID 绑定 → 任务与工作空间映射
```

**Git Worktree 机制**:
- Git 2.5+ 引入，允许同一仓库有多个工作目录
- 每个 worktree 有独立的分支和工作区状态
- 共享 `.git` 目录，但文件系统完全隔离

```
主仓库 (/)
  ├── .git/
  │   └── worktrees/
  │       ├── auth/  → 指向 .worktrees/auth/
  │       └── ui/    → 指向 .worktrees/ui/
  ├── .worktrees/
  │   ├── auth/      (分支: wt/auth) ← 独立工作区
  │   └── ui/        (分支: wt/ui)   ← 独立工作区
  └── (主分支文件)
```

### 3. 设计原则

#### 原则 1: 绑定不改状态

```python
def bind_task_to_worktree(task_id: str, worktree_name: str):
    task = load_task(task_id)
    task.worktree = worktree_name  # 只写 worktree 字段
    save_task(task)                # 状态保持 pending
```

**原因**:
- Lead 提前创建任务和 worktree
- 队友自动认领时才推进到 `in_progress`
- 职责清晰: Lead 管准备，Teammate 管执行

#### 原则 2: 自动目录切换

```python
# 队友认领时自动切换工作目录
def _run_claim_task(task_id):
    result = claim_task(task_id, owner=name)
    if "Claimed" in result:
        task = load_task(task_id)
        if task.worktree:
            wt_ctx["path"] = str(WORKTREES_DIR / task.worktree)
    return result
```

**对队友透明**:
- 队友无需关心 worktree 细节
- 所有文件操作自动在正确目录执行
- 认领任务 → 自动进入隔离环境

#### 原则 3: 安全删除优先

```python
def remove_worktree(name: str, discard_changes: bool = False):
    if not discard_changes:
        files, commits = _count_worktree_changes(path)
        if files > 0 or commits > 0:
            return "有未提交改动，使用 discard_changes=true 强制删除"
    # ... 执行删除
```

**防止误删**:
- 默认拒绝删除有改动的 worktree
- 强制需要显式 `discard_changes=true`
- 提供 `keep_worktree()` 保留选项

#### 原则 4: 生命周期可审计

```python
def log_event(event_type: str, worktree_name: str, task_id: str = ""):
    event = {"type": event_type, "worktree": worktree_name,
             "task_id": task_id, "ts": time.time()}
    # 写入 .worktrees/events.jsonl
```

事件类型:
- `create`: 创建
- `remove`: 删除
- `keep`: 保留

**用途**:
- 排查问题: 哪个 worktree 何时创建/删除
- 恢复状态: 结合 `git worktree list` 重建

### 4. 与其他模块的关系

```
s12 (Task System)
  ↓ 继承
s15 (MessageBus)
  ↓ 继承
s16 (Protocol State)
  ↓ 继承
s17 (Autonomous Agent)
  ↓ 增强
s18 (Worktree Isolation) ← 当前
  ↓ 解决"在哪干"的问题
s19 (MCP Plugin) → 外部工具扩展
```

**演进路线**:
- s12-s14: 任务系统、基础工具
- s15: Agent 间通信
- s16: 协议式协作
- s17: 自治 Agent
- **s18: 目录隔离**
- s19+: 外部能力扩展

---

## 实现细节

### 1. Worktree 名称校验

**目标**: 防止路径穿越和非法字符

```python
VALID_WT_NAME = re.compile(r'^[A-Za-z0-9._-]{1,64}$')

def validate_worktree_name(name: str) -> str | None:
    if not name:
        return "Worktree name cannot be empty"
    if name == "." or name == "..":
        return f"'{name}' is not a valid worktree name"
    if not VALID_WT_NAME.match(name):
        return (f"Invalid worktree name '{name}': "
                "only letters, digits, dots, underscores, dashes (1-64 chars)")
    return None  # None 表示有效
```

**校验规则**:
- 拒绝空字符串
- 拒绝 `.` 和 `..`(路径穿越)
- 只允许: 字母、数字、点、下划线、短横线
- 长度限制: 1-64 字符

**示例**:
```python
validate_worktree_name("auth-refactor")  # None (有效)
validate_worktree_name("../../etc/passwd")  # Error (非法字符)
validate_worktree_name("..")  # Error (路径穿越)
```

### 2. Git 命令执行

```python
def run_git(args: list[str]) -> tuple[bool, str]:
    """执行 git 命令，返回 (成功?, 输出)"""
    try:
        r = subprocess.run(
            ["git"] + args,
            cwd=WORKDIR,               # 在主仓库根目录执行
            capture_output=True,
            text=True,
            timeout=30
        )
        out = (r.stdout + r.stderr).strip()
        out = out[:5000] if out else "(no output)"
        return r.returncode == 0, out
    except subprocess.TimeoutExpired:
        return False, "Error: git timeout"
```

**设计要点**:
- 返回 `(bool, str)` 元组，方便错误处理
- 输出截断 5000 字符，防止过长
- 超时保护(30 秒)

### 3. Worktree 创建流程

```python
def create_worktree(name: str, task_id: str = "") -> str:
    # 步骤 1: 校验名称
    err = validate_worktree_name(name)
    if err:
        return f"Error: {err}"

    # 步骤 2: 检查是否已存在
    path = WORKTREES_DIR / name
    if path.exists():
        return f"Worktree '{name}' already exists at {path}"

    # 步骤 3: 执行 git worktree add
    # git worktree add <path> -b <branch> HEAD
    ok, result = run_git([
        "worktree", "add",
        str(path),
        "-b", f"wt/{name}",  # 分支名: wt/auth, wt/ui
        "HEAD"               # 基于当前 HEAD
    ])
    if not ok:
        return f"Git error: {result}"

    # 步骤 4: 可选绑定任务
    if task_id:
        bind_task_to_worktree(task_id, name)

    # 步骤 5: 记录事件日志
    log_event("create", name, task_id)

    return f"Worktree '{name}' created at {path}"
```

**Git 命令详解**:
```bash
git worktree add .worktrees/auth -b wt/auth HEAD
```
- `.worktrees/auth`: 工作目录路径
- `-b wt/auth`: 创建新分支 `wt/auth`
- `HEAD`: 基于 HEAD 创建(空工作区)

**结果**:
```
.worktrees/
└── auth/
    ├── .git (文件，指向主仓库)
    └── (工作区文件，初始为空)
```

### 4. 任务绑定机制

```python
def bind_task_to_worktree(task_id: str, worktree_name: str):
    """绑定任务到 worktree，不改任务状态"""
    task = load_task(task_id)
    task.worktree = worktree_name
    save_task(task)
    print(f"  [bind] {task.subject} → worktree:{worktree_name}")
```

**关键点**:
- 只写 `task.worktree` 字段
- 不改变 `task.status`(保持 `pending`)
- 不设置 `task.owner`

**数据示例**:
```json
// .tasks/task_123.json
{
  "id": "task_123",
  "subject": "重构认证模块",
  "status": "pending",       // 仍是 pending
  "owner": null,             // 无 owner
  "worktree": "auth"         // 已绑定 worktree
}
```

**为何不自动改为 in_progress?**
- Lead 可能批量创建任务和 worktree
- 自动认领机制负责推进状态
- 职责分离: Lead 准备 → Teammate 执行

### 5. Teammate 的目录切换

```python
def spawn_teammate_thread(name: str, role: str, prompt: str):
    def run():
        # 跟踪当前 worktree 路径
        wt_ctx = {"path": None}

        def _wt_cwd() -> Path | None:
            p = wt_ctx["path"]
            return Path(p) if p else None

        def _run_bash(command: str) -> str:
            return run_bash(command, cwd=_wt_cwd())

        def _run_read(path: str) -> str:
            return run_read(path, cwd=_wt_cwd())

        def _run_write(path: str, content: str) -> str:
            return run_write(path, content, cwd=_wt_cwd())

        def _run_claim_task(task_id: str):
            result = claim_task(task_id, owner=name)
            if "Claimed" in result:
                task = load_task(task_id)
                if task.worktree:
                    wt_ctx["path"] = str(WORKTREES_DIR / task.worktree)
                else:
                    wt_ctx["path"] = None  # 无 worktree 的任务在主目录工作
            return result

        def _run_complete_task(task_id: str):
            result = complete_task(task_id)
            wt_ctx["path"] = None  # 完成后清空
            return result

        # ... Agent 循环
```

**工作流程**:
1. 初始 `wt_ctx["path"] = None`，在主目录工作
2. 认领带 worktree 的任务 → 自动切换
3. 所有文件操作透明地在 worktree 目录执行
4. 完成任务 → 清空，回主目录

**实际效果**:
```python
# Alice 认领 task_123 (worktree: "auth")
_claim_task("task_123")  → wt_ctx["path"] = ".worktrees/auth"

_bash("ls")              → 在 .worktrees/auth 执行
_read("config.py")       → 读取 .worktrees/auth/config.py
_write("app.py", "...")  → 写入 .worktrees/auth/app.py

_complete_task("task_123") → wt_ctx["path"] = None
```

### 6. 安全删除机制

```python
def _count_worktree_changes(path: Path) -> tuple[int, int]:
    """统计未提交文件数和未推送提交数"""
    try:
        # 未提交文件
        r1 = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=path,
            capture_output=True,
            text=True,
            timeout=10
        )
        files = len([l for l in r1.stdout.strip().splitlines() if l.strip()])

        # 未推送提交
        r2 = subprocess.run(
            ["git", "log", "@{push}..HEAD", "--oneline"],
            cwd=path,
            capture_output=True,
            text=True,
            timeout=10
        )
        commits = len([l for l in r2.stdout.strip().splitlines() if l.strip()])

        return files, commits
    except Exception:
        return -1, -1  # 错误时返回 -1

def remove_worktree(name: str, discard_changes: bool = False) -> str:
    err = validate_worktree_name(name)
    if err:
        return err

    path = WORKTREES_DIR / name
    if not path.exists():
        return f"Worktree '{name}' not found"

    # 安全检查
    if not discard_changes:
        files, commits = _count_worktree_changes(path)
        if files < 0:
            return (f"Cannot verify worktree '{name}' status. "
                    "Use discard_changes=true to force removal.")
        if files > 0 or commits > 0:
            return (f"Worktree '{name}' has {files} uncommitted file(s) "
                    f"and {commits} unpushed commit(s). "
                    "Use discard_changes=true to force removal, "
                    "or keep_worktree to preserve for review.")

    # 删除 worktree 目录
    ok1, _ = run_git(["worktree", "remove", str(path), "--force"])
    if not ok1:
        return f"Failed to remove worktree directory for '{name}'"

    # 删除分支
    run_git(["branch", "-D", f"wt/{name}"])

    log_event("remove", name)
    return f"Worktree '{name}' removed"
```

**安全机制**:
1. **默认拒绝**: 有改动时直接返回错误
2. **明确确认**: 需要 `discard_changes=true` 才删除
3. **保留选项**: 提供 `keep_worktree()` 供 review

**删除流程**:
```bash
# Git 命令
git worktree remove .worktrees/auth --force  # 删除目录
git branch -D wt/auth                         # 删除分支
```

### 7. 事件日志系统

```python
def log_event(event_type: str, worktree_name: str, task_id: str = ""):
    """记录生命周期事件"""
    event = {
        "type": event_type,        # create | remove | keep
        "worktree": worktree_name,
        "task_id": task_id,
        "ts": time.time()
    }
    events_file = WORKTREES_DIR / "events.jsonl"
    with open(events_file, "a") as f:
        f.write(json.dumps(event) + "\n")
```

**日志示例**:
```jsonl
{"type": "create", "worktree": "auth", "task_id": "task_123", "ts": 1718700000.123}
{"type": "create", "worktree": "ui", "task_id": "task_456", "ts": 1718700001.456}
{"type": "keep", "worktree": "auth", "task_id": "", "ts": 1718701234.789}
{"type": "remove", "worktree": "ui", "task_id": "", "ts": 1718705678.012}
```

**用途**:
- 审计: 谁在何时创建/删除 worktree
- 排查: worktree 状态不一致时追溯
- 统计: 分析 worktree 使用模式

### 8. 自动认领机制

```python
def scan_unclaimed_tasks() -> list[dict]:
    """扫描可认领的任务"""
    unclaimed = []
    for f in sorted(TASKS_DIR.glob("task_*.json")):
        task = json.loads(f.read_text())
        # 条件: pending + 无 owner + 依赖已满足
        if (task.get("status") == "pending"
                and not task.get("owner")
                and can_start(task["id"])):
            unclaimed.append(task)
    return unclaimed

def can_start(task_id: str) -> bool:
    """检查依赖是否全部完成"""
    task = load_task(task_id)
    for dep_id in task.blockedBy:
        if not _task_path(dep_id).exists():
            return False  # 依赖任务不存在
        if load_task(dep_id).status != "completed":
            return False  # 依赖未完成
    return True

def idle_poll(agent_name: str, messages: list,
              name: str, role: str) -> str:
    """空闲轮询，返回 'work' | 'shutdown' | 'timeout'"""
    for _ in range(IDLE_TIMEOUT // IDLE_POLL_INTERVAL):
        time.sleep(IDLE_POLL_INTERVAL)

        # 1. 检查收件箱
        inbox = BUS.read_inbox(agent_name)
        if inbox:
            for msg in inbox:
                if msg.get("type") == "shutdown_request":
                    # 响应关闭请求
                    req_id = msg.get("metadata", {}).get("request_id", "")
                    BUS.send(name, "lead", "Shutting down gracefully.",
                             "shutdown_response",
                             {"request_id": req_id, "approve": True})
                    return "shutdown"
            # 其他消息注入对话
            messages.append({"role": "user",
                "content": "<inbox>" + json.dumps(inbox) + "</inbox>"})
            return "work"

        # 2. 自动认领任务
        unclaimed = scan_unclaimed_tasks()
        if unclaimed:
            task_data = unclaimed[0]
            result = claim_task(task_data["id"], agent_name)
            if "Claimed" in result:
                wt_info = ""
                if task_data.get("worktree"):
                    wt_path = WORKTREES_DIR / task_data["worktree"]
                    wt_info = f"\nWork directory: {wt_path}"
                messages.append({"role": "user",
                    "content": f"<auto-claimed>Task {task_data['id']}: "
                               f"{task_data['subject']}{wt_info}</auto-claimed>"})
                return "work"

    return "timeout"
```

**轮询流程**:
```
每 5 秒:
  ├─ 检查收件箱
  │   ├─ shutdown_request → 响应并退出
  │   └─ 其他消息 → 注入对话
  └─ 扫描可认领任务
      ├─ 发现任务 → 认领并注入 worktree 路径
      └─ 无任务 → 继续轮询

60 秒后 → timeout
```

---

## 实际应用场景

### 场景 1: 多任务并行开发

**需求**: 同时重构认证模块和 UI 登录页

**操作流程**:
```python
# Step 1: Lead 创建任务
task1 = create_task("重构认证模块")
task2 = create_task("重构 UI 登录页")

# Step 2: 创建独立 worktree
create_worktree("auth", task1.id)  # 绑定 task1
create_worktree("ui", task2.id)    # 绑定 task2

# Step 3: 启动队友
spawn_teammate("alice", "后端工程师", "专注于认证模块重构")
spawn_teammate("bob", "前端工程师", "专注于 UI 重构")

# Step 4: 自动认领
# Alice 认领 task1 → 自动在 .worktrees/auth/ 工作
# Bob 认领 task2 → 自动在 .worktrees/ui/ 工作

# Step 5: 并行工作，互不干扰
# Alice: write_file("auth.py", ...)  → .worktrees/auth/auth.py
# Bob:   write_file("login.vue", ...) → .worktrees/ui/login.vue

# Step 6: 清理
remove_worktree("auth")  # 或 keep_worktree("auth")
remove_worktree("ui")
```

**优势**:
- 完全隔离的工作空间
- 独立的 git 分支
- 无文件冲突风险

### 场景 2: 依赖任务串行执行

**需求**: 先完成 API 设计，再实现客户端

```python
# Step 1: 创建依赖任务
task1 = create_task("设计 API 接口")
task2 = create_task("实现客户端", blockedBy=[task1.id])

# Step 2: 创建 worktree
create_worktree("api-design", task1.id)

# Step 3: Alice 认领 task1
# Alice 在 .worktrees/api-design/ 工作
# Bob 阻塞，无法认领 task2

# Step 4: Alice 完成 task1
# Bob 的 idle_poll 扫描到 task2 可认领

# Step 5: Bob 认领 task2
# 可选择复用 worktree 或创建新的
```

**依赖检查**:
```python
can_start(task2.id)
# → 检查 task1.status == "completed"
# → True: 可以认领
# → False: 继续阻塞
```

### 场景 3: Review 后合并

**需求**: 保留 worktree 供人工审查

```python
# Alice 完成任务
complete_task("task_123")

# Lead 查看改动
# Option 1: 保留 worktree
keep_worktree("auth")
# → 分支 wt/auth 保留
# → 人工 git diff wt/auth main
# → 审查后 git merge wt/auth

# Option 2: 强制删除(有改动)
remove_worktree("auth", discard_changes=True)
# → 所有改动丢失
```

**Review 流程**:
```bash
# 查看改动
cd .worktrees/auth
git diff main

# 合并到主分支
git checkout main
git merge wt/auth

# 删除 worktree
git worktree remove .worktrees/auth
git branch -d wt/auth
```

### 场景 4: 恢复中断的任务

**情况**: 进程崩溃，需要恢复状态

```python
# Step 1: 读取事件日志
events = [json.loads(line) for line in
          open(".worktrees/events.jsonl").readlines()]

# Step 2: 扫描 git worktree list
# $ git worktree list
# /path/to/main
# /path/to/.worktrees/auth  wt/auth
# /path/to/.worktrees/ui    wt/ui

# Step 3: 对比日志和实际状态
# 找出未清理的 worktree

# Step 4: 检查任务状态
# task_123: in_progress, worktree: "auth"
# → 恢复 wt_ctx["path"] = ".worktrees/auth"
```

### 场景 5: 错误处理

**情况 1**: 创建同名 worktree
```python
create_worktree("auth")
create_worktree("auth")  # Error: Worktree 'auth' already exists
```

**情况 2**: 删除有改动的 worktree
```python
# Alice 在 auth 中创建了文件
remove_worktree("auth")
# Error: Worktree 'auth' has 3 uncommitted file(s) and 0 unpushed commit(s).
# Use discard_changes=true to force removal, or keep_worktree to preserve for review.

remove_worktree("auth", discard_changes=True)
# Success: Worktree 'auth' removed
```

**情况 3**: 路径穿越攻击
```python
create_worktree("../../etc/passwd")
# Error: Invalid worktree name '../../etc/passwd': only letters, digits, dots, underscores, dashes
```

---

## 与其他模块的关系

### 依赖关系图

```
┌─────────────────────────────────────────────────────────┐
│                    s18 Worktree Isolation               │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Task System  │  │ Worktree Sys │  │ Autonomous   │  │
│  │ (s12 基础)    │  │ (s18 新增)   │  │ Agent (s17)  │  │
│  │ + worktree   │  │              │  │ + wt_cwd     │  │
│  │   字段       │  │              │  │              │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│         ▲                  ▲                  ▲         │
│         │                  │                  │         │
└─────────┼──────────────────┼──────────────────┼─────────┘
          │                  │                  │
          ├──────────────────┼──────────────────┤
          │                  │                  │
┌─────────▼─────────┐ ┌─────▼────────┐ ┌───────▼────────┐
│   s12 Task System │ │ s15 MessageBus│ │ s16 Protocol   │
│   基础任务模型     │ │ Agent 间通信  │ │ 状态协议       │
└───────────────────┘ └──────────────┘ └────────────────┘
          ▲                  ▲                  ▲
          │                  │                  │
┌─────────┴──────────────────┴──────────────────┴─────────┐
│                      s17 Autonomous Agent                │
│              WORK-IDLE 循环、自动认领                    │
└─────────────────────────────────────────────────────────┘
```

### s12 (Task System) - 继承与扩展

**继承**:
- Task 数据结构(id, subject, status, owner, blockedBy)
- create_task, claim_task, complete_task
- 依赖检查 can_start

**扩展**:
```python
# s12 Task
@dataclass
class Task:
    id: str
    subject: str
    status: str
    owner: str | None
    blockedBy: list[str]

# s18 Task
@dataclass
class Task:
    id: str
    subject: str
    status: str
    owner: str | None
    blockedBy: list[str]
    worktree: str | None = None  # 新增字段
```

### s15 (MessageBus) - 直接复用

**无修改**:
- MessageBus 类完全继承
- send(), read_inbox() 方法
- 消息类型定义

### s16 (Protocol State) - 直接复用

**无修改**:
- ProtocolState 数据结构
- shutdown_request/response
- plan_approval_request/response

### s17 (Autonomous Agent) - 增强

**继承**:
- spawn_teammate_thread
- WORK-IDLE 循环
- 自动认领机制

**增强**:
```python
# s17: 固定在 WORKDIR 工作
def run():
    messages = [...]
    while True:
        # ... Agent 循环
        # bash/read/write 始终在 WORKDIR

# s18: 根据 worktree 动态切换
def run():
    wt_ctx = {"path": None}  # 新增

    def _run_bash(command):
        return run_bash(command, cwd=wt_ctx["path"])  # 动态 cwd

    def _run_claim_task(task_id):
        result = claim_task(task_id, owner=name)
        if "Claimed" in result:
            task = load_task(task_id)
            if task.worktree:
                wt_ctx["path"] = str(WORKTREES_DIR / task.worktree)
        return result
```

### s19 (MCP Plugin) - 后续扩展

**关系**: 正交，独立扩展

- s18 解决"在哪干"(目录隔离)
- s19 解决"用什么干"(外部工具)

```
s18 Worktree Isolation  →  隔离的工作空间
         +
s19 MCP Plugin          →  外部工具能力
         =
更强大的自治 Agent
```

---

## 优缺点分析

### 优点

#### 1. 完全隔离的工作空间

**优点**:
- 文件级别隔离，无冲突风险
- 独立 git 分支，版本控制清晰
- 可并行执行多个任务

**示例**:
```python
# Alice 和 Bob 同时工作
Alice: .worktrees/auth/config.py
Bob:   .worktrees/ui/config.py
# 两个文件互不影响
```

#### 2. 自动化的目录管理

**优点**:
- Teammate 无需关心 worktree 细节
- 认领任务时自动切换目录
- 完成任务后自动清理

**示例**:
```python
# Teammate 视角
claim_task("task_123")  # 自动切换到 .worktrees/auth
write_file("config.py", ...)  # 自动在正确位置
complete_task("task_123")  # 自动清理 wt_ctx
```

#### 3. 安全防护机制

**优点**:
- 名称校验防止路径穿越
- 有改动时默认拒绝删除
- 事件日志可审计

**示例**:
```python
create_worktree("../../etc")  # 拒绝非法名称
remove_worktree("auth")  # 拒绝删除有改动的
remove_worktree("auth", discard_changes=True)  # 需显式确认
```

#### 4. 灵活的清理策略

**优点**:
- `remove_worktree`: 直接删除
- `keep_worktree`: 保留供 review
- 根据场景选择

**示例**:
```python
# 小改动，直接删除
remove_worktree("typo-fix")

# 大改动，保留 review
keep_worktree("refactor-auth")
# 人工审查后 git merge wt/refactor-auth
```

### 缺点

#### 1. 增加存储开销

**缺点**:
- 每个 worktree 是独立的工作目录
- 文件数量翻倍
- 磁盘占用增加

**示例**:
```bash
# 单仓库 100MB
# 创建 5 个 worktree → 500MB+
```

**缓解**:
- 及时清理不需要的 worktree
- 使用 `git worktree prune` 清理无效引用

#### 2. 增加复杂度

**缺点**:
- 需要理解 git worktree 机制
- 任务与 worktree 的绑定关系需要维护
- 状态恢复更复杂

**示例**:
```python
# 崩溃后恢复
# 需要对比:
# - .worktrees/events.jsonl (日志)
# - git worktree list (实际状态)
# - .tasks/*.json (任务状态)
```

#### 3. 网络操作开销

**缺点**:
- 每个分支独立推送
- 多个 worktree 可能重复推送相同提交

**示例**:
```bash
# 每个分支独立 push
git -C .worktrees/auth push origin wt/auth
git -C .worktrees/ui push origin wt/ui
```

#### 4. 教学版局限

**缺点**:
- `wt_ctx` 是线程局部变量，真实 CC 用 `process.chdir()`
- 缺少完整的状态恢复机制
- 没有实现 CC 的 EnterWorktree/ExitWorktree

**对比**:
```python
# 教学版: 线程局部变量
wt_ctx = {"path": None}

# 真实 CC: 进程级目录切换
process.chdir(worktreePath)
setCwd(worktreePath)
setOriginalCwd(originalCwd)
saveWorktreeState(...)
```

---

## 最佳实践

### 1. Worktree 命名规范

**推荐**:
```python
# 任务相关命名
create_worktree(f"task-{task_id}")
create_worktree(f"auth-refactor-{date}")
create_worktree(f"feature-{feature_name}")

# 避免
create_worktree("test")  # 太泛化
create_worktree("t1")    # 不够描述性
create_worktree("../../etc")  # 非法
```

**模式**:
- `feature-xxx`: 新功能
- `bugfix-xxx`: 错误修复
- `refactor-xxx`: 重构
- `task-{id}`: 任务绑定

### 2. 任务与 Worktree 绑定策略

**推荐**:
```python
# 立即绑定
task = create_task("重构认证")
create_worktree("auth-refactor", task.id)

# 批量创建
tasks = [
    create_task("任务1"),
    create_task("任务2"),
]
for task in tasks:
    create_worktree(f"task-{task.id}", task.id)
```

**不推荐**:
```python
# 先创建 worktree，后创建任务
# 问题: worktree 悬空，无任务关联
create_worktree("orphan")
# later...
task = create_task("...")
bind_task_to_worktree(task.id, "orphan")  # 容易遗忘
```

### 3. 清理策略

**推荐**:
```python
# 小改动: 直接删除
if is_small_change(task):
    remove_worktree(name, discard_changes=True)

# 大改动: 保留 review
if is_big_change(task):
    keep_worktree(name)
    # 等待人工审查
    # 审查后手动清理
```

**定期清理**:
```python
# 定期扫描悬空 worktree
for wt in list_worktrees():
    if not has_bound_task(wt):
        remove_worktree(wt.name)
```

### 4. 错误处理

**推荐**:
```python
def safe_create_worktree(name: str, task_id: str = "") -> str:
    try:
        return create_worktree(name, task_id)
    except Exception as e:
        # 清理半创建的 worktree
        path = WORKTREES_DIR / name
        if path.exists():
            run_git(["worktree", "remove", str(path), "--force"])
        return f"Error: {e}"
```

### 5. 状态恢复

**推荐**:
```python
def recover_worktrees():
    """从事件日志恢复 worktree 状态"""
    events = load_events()
    current = set(get_git_worktrees())

    for event in events:
        if event["type"] == "create":
            wt_name = event["worktree"]
            if wt_name not in current:
                # worktree 丢失
                task_id = event["task_id"]
                if task_id:
                    task = load_task(task_id)
                    if task.status == "in_progress":
                        # 重新创建
                        create_worktree(wt_name, task_id)
                        print(f"Recovered: {wt_name}")
```

### 6. 并发控制

**推荐**:
```python
# 限制同时存在的 worktree 数量
MAX_WORKTREES = 10

def create_worktree_safe(name: str, task_id: str = "") -> str:
    current = count_worktrees()
    if current >= MAX_WORKTREES:
        return f"Error: Max worktrees ({MAX_WORKTREES}) reached"
    return create_worktree(name, task_id)
```

### 7. 日志与监控

**推荐**:
```python
# 增强事件日志
def log_event(event_type: str, worktree_name: str,
              task_id: str = "", metadata: dict = None):
    event = {
        "type": event_type,
        "worktree": worktree_name,
        "task_id": task_id,
        "ts": time.time(),
        "metadata": metadata or {},  # 额外信息
        "pid": os.getpid(),           # 进程 ID
        "agent": get_current_agent(), # Agent 名称
    }
    # ...

# 监控指标
def get_worktree_metrics():
    return {
        "total": count_worktrees(),
        "active": count_active_worktrees(),
        "orphaned": count_orphaned_worktrees(),
        "disk_usage": get_disk_usage(),
    }
```

---

## 总结

s18_worktree_isolation 通过引入 Git Worktree 机制，优雅地解决了多 Agent 并行工作时的目录冲突问题。其核心价值在于:

1. **隔离性**: 每个 worktree 是独立工作空间，完全隔离文件冲突
2. **自动化**: 任务认领时自动切换目录，对 Agent 透明
3. **安全性**: 名称校验、删除保护、事件日志多重保障
4. **灵活性**: 支持删除或保留，满足不同场景

这个模块展示了如何在 Agent 系统中集成 Git Worktree 机制，为后续更复杂的多 Agent 协作场景提供了坚实的隔离基础。虽然教学版有些简化(如线程局部变量 vs 进程级切换)，但核心思想与真实 Claude Code 一致，是学习 Agent 隔离机制的优秀范例。

---

## 附录: 关键代码片段

### A. 完整的 Worktree 生命周期

```python
# 1. 创建任务
task = create_task("重构认证模块")
# .tasks/task_xxx.json: {status: "pending", owner: null, worktree: null}

# 2. 创建 worktree 并绑定
create_worktree("auth", task.id)
# .worktrees/auth/ 创建
# .tasks/task_xxx.json: {worktree: "auth"}

# 3. Teammate 自动认领
claim_task(task.id, "alice")
# .tasks/task_xxx.json: {status: "in_progress", owner: "alice"}
# wt_ctx["path"] = ".worktrees/auth"

# 4. Teammate 工作
bash("ls")  # 在 .worktrees/auth 执行
write_file("config.py", "...")  # 写入 .worktrees/auth/config.py

# 5. 完成任务
complete_task(task.id)
# .tasks/task_xxx.json: {status: "completed"}
# wt_ctx["path"] = None

# 6a. 直接删除
remove_worktree("auth", discard_changes=True)
# .worktrees/auth/ 删除
# 分支 wt/auth 删除

# 6b. 或保留 review
keep_worktree("auth")
# 分支 wt/auth 保留
# 人工 git merge wt/auth
```

### B. 目录结构示例

```
project/
├── .git/
│   └── worktrees/
│       ├── auth  → 指向 .worktrees/auth
│       └── ui    → 指向 .worktrees/ui
├── .tasks/
│   ├── task_123.json
│   └── task_456.json
├── .worktrees/
│   ├── auth/
│   │   ├── .git (文件)
│   │   ├── config.py
│   │   └── auth.py
│   ├── ui/
│   │   ├── .git (文件)
│   │   └── login.vue
│   └── events.jsonl
├── .mailboxes/
│   ├── alice.jsonl
│   ├── bob.jsonl
│   └── lead.jsonl
└── (主仓库文件)
```

### C. 事件日志示例

```jsonl
{"type": "create", "worktree": "auth", "task_id": "task_123", "ts": 1718700000.123}
{"type": "create", "worktree": "ui", "task_id": "task_456", "ts": 1718700001.456}
{"type": "keep", "worktree": "auth", "task_id": "", "ts": 1718701234.789}
{"type": "remove", "worktree": "ui", "task_id": "", "ts": 1718705678.012}
```

---

## 参考资料

- [Git Worktree 官方文档](https://git-scm.com/docs/git-worktree)
- s12_task_system/README_ME.md - 任务系统基础
- s15_message_bus/README_ME.md - 消息总线
- s16_protocol_state/README_ME.md - 协议状态
- s17_autonomous_agent/README_ME.md - 自治 Agent
- Claude Code 源码: `EnterWorktreeTool.ts`, `AgentTool.tsx`, `worktree.ts`
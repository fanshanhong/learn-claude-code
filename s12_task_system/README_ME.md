# s12: Task System — 大目标拆成小任务，排好序，持久化

## 目录

- [一、整体思想：大目标拆成小任务，排好序，持久化](#一整体思想大目标拆成小任务排好序持久化)
- [二、架构设计：文件持久化的任务图](#二架构设计文件持久化的任务图)
- [三、实现细节](#三实现细节)
- [四、LLM 的角色：构建者、管理者、决策者](#四llm-的角色构建者管理者决策者)
- [五、不会卡死的机制](#五不会卡死的机制)
- [六、CC 的真实实现（教学版 vs 生产级）](#六cc-的真实实现教学版-vs-生产级)
- [七、完整流程示例](#七完整流程示例)
- [八、总结](#八总结)

---

## 一、整体思想：大目标拆成小任务，排好序，持久化

### 核心理念

```
"大目标拆成小任务，排好序，持久化"

设计原则：
1. 拆分：把大目标拆成可管理的小任务
2. 依赖：任务之间有先后顺序（DAG）
3. 持久化：跨会话保留（文件存储）
4. 认领：多 agent 协作（owner字段）

结果：
- 不一次性处理大任务（避免混乱）
- 保证先后顺序（依赖检查）
- 跨会话恢复（文件持久化）
- 多 agent 协作（防止重复认领）
```

### TodoWrite vs Task System

| | TodoWrite (s05) | Task System (s12) |
|---|---|---|
| **定位** | 当前任务的执行清单 | 可恢复的任务系统 |
| **存储** | 进程内 / 会话状态 | `.tasks/{id}.json` |
| **依赖** | 无 | `blockedBy` / `blocks` 依赖图 |
| **生命周期** | 当前会话 / 当前任务 | 跨会话保留 |
| **分工** | 不负责任务认领 | `owner` / claim |
| **状态** | pending / in_progress / completed | pending / in_progress / completed |
| **粒度** | Agent 自己的步骤 | 可被认领、追踪、解锁的任务 |

### 为什么需要 Task System？

```
问题场景：

Agent 接到一个项目：搭数据库、写 API、加测试。

使用 TodoWrite：
  ├─> 列清单：搭数据库、写 API、加测试
  ├─> 开始写 API
  ├─> 写到一半发现没数据库表
  ├─> 回头补数据库
  ├─> 加测试时发现 API接口签名变了
  └─> 混乱、效率低

盖房子不能先盖屋顶再打地基。任务之间有先后。

使用 Task System：
  ├─> 创建任务：schema（数据库）→ endpoints（API）→ tests（测试）
  ├─> 设置依赖：endpoints blockedBy schema
  ├─> tests blockedBy endpoints
  ├─> 先做 schema（无依赖）
  ├─> schema完成后，endpoints 自动解锁
  ├─> endpoints 完成后，tests 自动解锁
  └─> 保证顺序、不混乱
```

---

## 二、架构设计：文件持久化的任务图

### 架构图

```
┌─────────────────────────────────────────────────────────┐
│                      agent_loop                          │
│  ├─> LLM 调用                                           │
│  ├─> tool_use → 执行工具                               │
│  └─> 工具包括：                                         │
│       ├─> create_task（创建任务）                      │
│       ├─> list_tasks（列出任务）                       │
│       ├─> get_task（获取任务详情）                     │
│       ├─> claim_task（认领任务）                       │
│       └─> complete_task（完成任务）                    │
└─────────────────────────────────────────────────────────┘
                        │
                        │ 持久化到文件
                        ▼
┌─────────────────────────────────────────────────────────┐
│                  .tasks/ 目录                             │
│  ├─> task_1234567890_0001.json                          │
│  ├─> task_1234567891_0002.json                          │
│  ├─> task_1234567892_0003.json                          │
│  │                                                     │
│  │  每个文件包含：                                     │
│  │  {                                                  │
│  │    "id": "task_1234567890_0001",                    │
│  │    "subject": "setup database schema",              │
│  │    "description": "...",                            │
│  │    "status": "pending",                             │
│  │    "owner": null,                                   │
│  │    "blockedBy": []                                  │
│  │  }                                                  │
│  │                                                     │
│  │  依赖关系：                                         │
│  │  - blockedBy: ["task_1234567890_0001"]             │
│  │  - 意思：依赖 task_1234567890_0001                  │
│  │  - 只有依赖完成后才能 claim                        │
└─────────────────────────────────────────────────────────┘

数据结构（Task）：
  ├─> id: 任务ID（timestamp + random）
  ├─> subject: 任务标题
  ├─> description: 任务描述
  ├─> status: pending | in_progress | completed
  ├─> owner: Agent 名（多 Agent 场景）
  └─> blockedBy: 依赖的任务ID列表
```

### 核心组件详解

#### 1. Task dataclass（数据结构）

```python
# 第52-60 行
@dataclass
class Task:
    id: str
    subject: str
    description: str
    status: str          # pending | in_progress | completed
    owner: str | None    # Agent 名（多 Agent 场景）
    blockedBy: list[str] # 依赖任务 ID列表
```

**字段详解：**

| 字段 | 类型 | 用途 | 示例 |
|------|------|------|------|
| **id** | `str` | 任务唯一标识 | `task_1234567890_0001` |
| **subject** | `str` | 任务标题 | `setup database schema` |
| **description** | `str` | 任务详细描述 | `Create tables for users...` |
| **status** | `str` | 任务状态 | `pending` / `in_progress` / `completed` |
| **owner** | `str | None` | 认领的 Agent | `agent` / `null` |
| **blockedBy** | `list[str]` | 依赖的任务 ID | `["task_1234567890_0001"]` |

#### 2. .tasks/ 目录（持久化存储）

```python
# 第48-49 行
TASKS_DIR = WORKDIR / ".tasks"
TASKS_DIR.mkdir(exist_ok=True)
```

**设计理念：**
- 每个任务一个 JSON 文件
- 文件名：`task_{timestamp}_{random}.json`
- 跨会话保留（重启后仍然存在）
- 简单、直观、易于调试

#### 3. 5 个工具（LLM 可调用）

```python
# 第255-298 行
TOOLS = [
    {"name": "create_task", ...},
    {"name": "list_tasks", ...},
    {"name": "get_task", ...},
    {"name": "claim_task", ...},
    {"name": "complete_task", ...},
]
```

**工具详解：**

| 工具 | 功能 | 参数 | 返回 |
|------|------|------|------|
| **create_task** | 创建任务 | subject, description, blockedBy | 任务ID |
| **list_tasks** | 列出任务 | 无 | 任务列表 |
| **get_task** | 获取详情 | task_id | 任务JSON |
| **claim_task** | 认领任务 | task_id | 成功/失败消息 |
| **complete_task** | 完成任务 | task_id | 成功 + 解锁消息 |

---

## 三、实现细节

### 细节 1：依赖关系维护（blockedBy）

#### 依赖关系的存储方式

```python
# 每个任务文件中
{
    "id": "task_1234567891_0002",
    "subject": "create API endpoints",
    "blockedBy": ["task_1234567890_0001"]  # ← 依赖存储在这里
}
```

**关键理解：**
- 依赖关系存储在每个任务的 `blockedBy` 字段中
- **不是**显式的 DAG 数据结构（没有全局图）
- 分散式存储（每个任务记录自己的上游依赖）

#### can_start：依赖检查

```python
# 第99-108 行
def can_start(task_id: str) -> bool:
    """Check if all blockedBy dependencies are completed."""
    task = load_task(task_id)
    for dep_id in task.blockedBy:
        # 检查依赖任务是否存在
        if not _task_path(dep_id).exists():
            return False  # missing dependency = blocked
        # 检查依赖任务是否完成
        if load_task(dep_id).status != "completed":
            return False
    return True
```

**检查逻辑：**
1. 加载当前任务
2. 遍历所有 `blockedBy` 依赖
3. 检查依赖任务是否存在（文件存在）
4. 检查依赖任务是否完成（status == "completed")
5. 所有依赖都完成 → 可以开始

### 细节 2：claim_task（认领任务）

```python
# 第111-123 行
def claim_task(task_id: str, owner: str = "agent") -> str:
    task = load_task(task_id)
    # 检查 1：任务状态必须是 pending
    if task.status != "pending":
        return f"Task {task_id} is {task.status}, cannot claim"
    # 检查 2：依赖检查（can_start）
    if not can_start(task_id):
        deps = [d for d in task.blockedBy
                if not _task_path(d).exists() or load_task(d).status != "completed"]
        return f"Blocked by: {deps}"
    # 设置 owner + 状态变更
    task.owner = owner
    task.status = "in_progress"
    save_task(task)
    print(f"  [claim] {task.subject} → in_progress (owner: {owner})")
    return f"Claimed {task.id} ({task.subject})"
```

**流程：**
1. 加载任务
2. 检查状态（必须 pending）
3. 检查依赖（can_start）
4. 设置 owner（防止重复认领）
5. 状态变更：pending → in_progress
6. 保存到文件

### 细节 3：complete_task（完成任务 + 解锁下游）

```python
# 第126-139 行
def complete_task(task_id: str) -> str:
    task = load_task(task_id)
    # 检查状态（必须 in_progress）
    if task.status != "in_progress":
        return f"Task {task_id} is {task.status}, cannot complete"
    # 状态变更
    task.status = "completed"
    save_task(task)
    # 找出被解锁的下游任务
    unblocked = [t.subject for t in list_tasks()
                 if t.status == "pending" and t.blockedBy
                 and can_start(t.id)]
    print(f"  [complete] {task.subject} ✓")
    msg = f"Completed {task.id} ({task.subject})"
    if unblocked:
        msg += f"\nUnblocked: {', '.join(unblocked)}"
        print(f"  [unblocked] {', '.join(unblocked)}")
    return msg
```

**流程：**
1. 加载任务
2. 检查状态（必须 in_progress）
3. 状态变更：in_progress → completed
4. 保存到文件
5. **扫描所有任务**，找出刚刚被解锁的下游任务
6. 返回消息（包含解锁信息）

**关键理解：**
- 完成任务后，**扫描所有任务**
- 找出 status == "pending" 且 blockedBy不为空的任务
- 对每个任务调用 can_start（检查依赖）
- 如果 can_start返回True，说明刚刚被解锁
- 返回解锁信息（告诉 LLM）

### 细节 4：状态机

```
状态机：两个动作，三个状态

pending ──claim──→ in_progress ──complete──→ completed

- **claim_task**: pending → in_progress。设置 owner，开始工作。
- **complete_task**: in_progress → completed。把任务标记为完成，并解锁下游。

注意：
- 没有 release 回退路径（in_progress → pending）
- CC 有 release 机制（shutdown 时清除 owner，重置为pending）
- 教学版简化了这一恢复路径
```

---

## 四、LLM 的角色：构建者、管理者、决策者

### LLM 的三重角色

```
LLM 的三重角色：

1. 构建者（创建任务图）
   ├─> 理解用户需求
   ├─> 拆分成任务
   ├─> 决策依赖关系
   ├─> 调用 create_task构建图
   └─> LLM 主动构建整个任务系统

2. 管理者（管理任务执行）
   ├─> 调用 list_tasks 查看状态
   ├─> 调用 claim_task 认领任务
   ├─> 执行任务内容（其他工具）
   ├─> 调用 complete_task 完成任务
   └─> LLM 主动管理整个执行流程

3. 决策者（判断下一步）
   ├─> 根据 list_tasks 分析依赖关系
   ├─> 根据 Unblocked 信息判断解锁情况
   ├─> 决策下一步做哪个任务
   ├─> 决策任务优先级
   └─> LLM 主动决策，系统不自动执行

系统的角色：
- 提供工具（create、list、claim、complete）
- 提供检查（can_start）
- 提供信息（Unblocked）
- 执行具体逻辑（保存、加载、状态变更）
- 不做决策（不自动执行任务）
```

### LLM 如何构建任务图

```
用户输入："搭数据库、写 API、加测试、写文档。API依赖数据库，测试依赖API，文档依赖数据库。"

第 1 步：LLM 分析理解
  ├─> LLM 分析用户需求
  ├─> LLM 理解：需要拆分成 4 个任务
  ├─> LLM 理解依赖关系：
  │     ├─> API依赖数据库
  │     ├─> 测试依赖 API
  │     ├─> 文档依赖数据库
  │     └─> 数据库无依赖（最初始）
  └─> LLM 决策：调用 create_task 创建任务

第 2 步：LLM 调用 create_task
  ├─> tool_use 1：create_task("setup schema")
  │     └─> 返回：task_001（blockedBy=[]）
  │
  ├─> tool_use 2：create_task("write API", blockedBy=["task_001"])
  │     └─> 返回：task_002（blockedBy=[task_001]）
  │
  ├─> tool_use 3：create_task("write tests", blockedBy=["task_002"])
  │     └─> 返回：task_003（blockedBy=[task_002]）
  │
  ├─> tool_use 4：create_task("write docs", blockedBy=["task_001"])
  │     └─> 返回：task_004（blockedBy=[task_001]）
  │
  └─> LLM 构建 DAG：
        task_001 (schema) ──┬──> task_002 (API) ──> task_003 (tests)
                            │
                            └──> task_004 (docs)

关键理解：
- LLM 自己理解用户需求
- LLM 自己决策如何拆分任务
- LLM 自己决策依赖关系（通过 blockedBy参数）
- LLM 通过多次 create_task 调用构建整个任务图
- 系统只提供工具（create_task），LLM 做决策
```

### LLM 如何管理任务执行

```
LLM 管理任务的完整流程：

第 1 步：获取任务列表
  ├─> tool_use: list_tasks()
  ├─> tool_result:
  │     ○ task_001: setup schema [pending]
  │     ○ task_002: write API [pending] (blockedBy: 001)
  │     ○ task_003: write tests [pending] (blockedBy: 002)
  │     ○ task_004: write docs [pending] (blockedBy: 001)
  └─> LLM 分析：
        ├─> task_001：blockedBy=[] → 可以开始
        ├─> task_002：blockedBy=[001] → 被阻塞
        ├─> task_003：blockedBy=[002] → 被阻塞
        └─> task_004：blockedBy=[001] → 被阻塞

第 2 步：认领任务
  ├─> LLM 决策：先做 task_001
  ├─> tool_use: claim_task("task_001")
  ├─> tool_result: "Claimed task_001 (setup schema)"
  └─> task_001.status = in_progress

第 3 步：执行任务
  ├─> LLM 使用其他工具执行任务内容
  ├─> tool_use: write_file("schema.sql", ...)
  ├─> tool_use: bash("psql -f schema.sql")
  └─> 执行实际工作

第 4 步：完成任务
  ├─> LLM 决策：task_001 完成
  ├─> tool_use: complete_task("task_001")
  ├─> tool_result:
  │     "Completed task_001 (setup schema)"
  │     "Unblocked: task_002, task_004"
  ├─> task_001.status = completed
  └─> LLM 看到：task_002 和 task_004 解锁了

第 5 步：继续执行
  ├─> LLM 决策：下一步做哪个？
  │     ├─> 做 task_002（API）？
  │     ├─> 做 task_004（docs）？
  │     ├─> LLM 自己判断优先级
  ├─> tool_use: claim_task("task_002")
  ├─> 执行任务...
  ├─> complete_task("task_002")
  ├─> tool_result:
  │     "Completed task_002"
  │     "Unblocked: task_003"
  └─> LLM 看到：task_003 解锁了
```

---

## 五、不会卡死的机制

### 关键机制 1：LLM 可以随时查看任务列表

```
如果 LLM 不确定下一步：

LLM 可以调用 list_tasks()：
  ├─> 返回：
  │     ✓ task_001: setup schema [completed]
  │     ● task_002: write API [in_progress] [agent]
  │     ○ task_003: write tests [pending] (blockedBy: task_002)
  │     ○ task_004: write docs [pending] (blockedBy: task_001)
  └─> LLM 分析：
        ├─> task_004: blockedBy=[001], 001完成 → 可以开始
        ├─> task_003: blockedBy=[002], 002未完成 → 被阻塞
        └─> 决策：先做 task_004（解锁）

关键理解：
- list_tasks 显示每个任务的 blockedBy
- LLM 可以看到依赖关系
- LLM 自己判断哪些任务可以开始
- LLM 不会被卡死（可以主动查看）
```

### 关键机制 2：complete_task 的 Unblocked 信息

```
complete_task(B) 的返回：
  "Completed B"
  （没有 "Unblocked: ..."）

LLM 看到这个返回：
  ├─> 理解：B完成，但没有任务解锁
  ├─> 推理：为什么没有解锁？
  │     ├─> 可能没有下游任务
  │     ├─> 或者下游任务仍被其他依赖阻塞
  ├─> LLM 会主动思考：哪些任务还被阻塞？
  └─> 决策：去做那些任务（解锁下游）

关键理解：
- Unblocked 信息告诉 LLM 哪些任务解锁了
- 没有 Unblocked 信息 → LLM 知道下游仍被阻塞
- LLM 会主动找出阻塞原因
- LLM 决策：去做阻塞任务
```

### 关键机制 3：LLM 的主动决策能力

```
场景：D依赖 B、C，B完成，C未完成

LLM 的推理流程：

第 1 步：B完成后
  ├─> tool_result: "Completed B"（没有 Unblocked）
  ├─> LLM 分析：
  │     ├─> 为什么没有 Unblocked？
  │     ├─> D依赖 B、C
  │     ├─> B完成，C未完成
  │     ├─> D仍被阻塞
  ├─> LLM 推理：要解锁 D，需要完成 C
  ├─> LLM 决策：去做 C

第 2 步：调用 list_tasks 确认
  ├─> LLM 调用 list_tasks()
  ├─> 看到：
  │     ✓ A [completed]
  │     ✓ B [completed]
  │     ○ C [pending] (blockedBy: A) → A完成 → 可以开始
  │     ○ D [pending] (blockedBy: B, C) → B完成、C未完成 → 被阻塞
  ├─> LLM 确认：C 可以开始，D被阻塞

第 3 步：执行 C
  ├─> claim_task(C) → 执行 → complete_task(C)
  ├─> tool_result: "Completed C\nUnblocked: D"
  ├─> D 解锁

关键理解：
- LLM 有推理能力
- LLM 会分析为什么没有 Unblocked
- LLM 会主动查看任务列表
- LLM 会主动去做阻塞任务
- 不会被动等待
```

### 真正的卡死场景（教学版缺少环检测）

```
真正的卡死：有环依赖

场景：LLM 构建了有环的依赖图

LLM 调用：
  ├─> create_task("A", blockedBy=["C"])  # A依赖 C
  ├─> create_task("B", blockedBy=["A"])  # B依赖 A
  ├─> create_task("C", blockedBy=["B"])  # C依赖 B
  └─> 形成环：A → B → C → A

执行：
  ├─> list_tasks():
  │     ○ A [pending] (blockedBy: C)
  │     ○ B [pending] (blockedBy: A)
  │     ○ C [pending] (blockedBy: B)
  ├─> LLM 尝试 claim任何任务：
  │     ├─> claim_task(A) → "Blocked by: C"（C未完成）
  │     ├─> claim_task(B) → "Blocked by: A"（A未完成）
  │     ├─> claim_task(C) → "Blocked by: B"（B未完成）
  ├─> 所有任务都被阻塞
  ├─> 没有任何任务可以开始
  └─> 真正的卡死！

这是教学版的缺陷：
- 没有环检测（DAG 保证）
- LLM 可能构建有环的依赖图
- 导致真正的死锁

CC 的真实实现：
- 有环检测算法
- 在 create_task 时检查依赖图
- 如果形成环，拒绝创建
- 保证 DAG 结构
```

---

## 六、CC 的真实实现（教学版 vs 生产级）

### CC 的 Task 有更多字段

| 字段 | 教学版 | CC |
|------|-------|---|
| id | timestamp + random | 递增整数 + highwatermark |
| subject | ✓ | ✓ |
| description | ✓ | ✓ |
| activeForm | 无 | 进行时态（spinner 显示） |
| status | ✓ | ✓ |
| owner | ✓ | ✓ |
| blockedBy | ✓ | ✓ |
| blocks | 无 | 下游任务（反向指针） |
| metadata | 无 | 任意扩展键值对 |

### CC 有并发锁机制

```
CC 的 claimTask() 用双重锁：

1. 任务文件锁
   ├─> proper-lockfile 锁住 {taskId}.json
   ├─> 最多重试 30 次，指数退避 5-100ms
   ├─> 锁内：
   │     ├─> 重新读取任务（防 TOCTOU）
   │     ├─> 检查已被他人认领 → already_claimed
   │     ├─> 检查已完成 → already_resolved
   │     ├─> 检查上游未完成 → blocked
   │     └─> 设置 owner

2. 列表级锁
   ├─> .lock 文件
   ├─> 原子性扫描所有任务
   └─> 检查该 agent 是否已有其他 open task

教学版简化：
- 没有锁机制（单进程）
- 直接检查状态
- 直接设置 owner
```

### CC 有环检测

```
CC 在 create_task 时检查依赖图：
- 检查新任务的 blockedBy 是否形成环
- 如果形成环，拒绝创建
- 保证 DAG 结构

教学版缺少环检测：
- LLM 可能构建有环的依赖图
- 导致真正的死锁
```

---

## 七、完整流程示例

### 时间线详解

```
时间点 1：用户输入
User: "搭数据库、写 API、加测试、写文档。API依赖数据库，测试依赖API，文档依赖数据库。"

时间点 2：LLM 分析并创建任务
LLM:
  ├─> 分析需求，理解依赖
  ├─> tool_use: create_task("setup schema")
  │     └─> tool_result: "Created task_001"
  ├─> tool_use: create_task("write API", blockedBy=["task_001"])
  │     └─> tool_result: "Created task_002 (blockedBy: task_001)"
  ├─> tool_use: create_task("write tests", blockedBy=["task_002"])
  │     └─> tool_result: "Created task_003 (blockedBy: task_002)"
  ├─> tool_use: create_task("write docs", blockedBy=["task_001"])
  │     └─> tool_result: "Created task_004 (blockedBy: task_001)"
  └─> LLM 构建了任务图

时间点 3：LLM 查看任务列表
LLM:
  ├─> tool_use: list_tasks()
  ├─> tool_result:
  │     ○ task_001: setup schema [pending]
  │     ○ task_002: write API [pending] (blockedBy: task_001)
  │     ○ task_003: write tests [pending] (blockedBy: task_002)
  │     ○ task_004: write docs [pending] (blockedBy: task_001)
  └─> LLM 分析：task_001 可以开始（无依赖）

时间点 4：LLM 认领第一个任务
LLM:
  ├─> tool_use: claim_task("task_001")
  ├─> tool_result: "Claimed task_001 (setup schema)"
  └─> task_001.status = in_progress

时间点 5：LLM 执行任务内容
LLM:
  ├─> tool_use: write_file("schema.sql", "CREATE TABLE users...")
  ├─> tool_use: bash("psql -f schema.sql")
  └─> 执行实际工作

时间点 6：LLM 完成任务
LLM:
  ├─> tool_use: complete_task("task_001")
  ├─> tool_result:
  │     "Completed task_001 (setup schema)"
  │     "Unblocked: task_002, task_004"
  └─> LLM 看到：task_002 和 task_004 解锁了

时间点 7：LLM 决策下一步
LLM:
  ├─> 分析 Unblocked 信息
  ├─> 决策：先做 task_002（API更重要）
  ├─> tool_use: claim_task("task_002")
  ├─> tool_result: "Claimed task_002"
  ├─> 执行任务...
  ├─> tool_use: complete_task("task_002")
  ├─> tool_result:
  │     "Completed task_002"
  │     "Unblocked: task_003"
  └─> LLM 看到：task_003 解锁了

时间点 8：LLM 继续执行
LLM:
  ├─> tool_use: claim_task("task_003")
  ├─> 执行测试...
  ├─> complete_task("task_003")
  ├─> tool_use: claim_task("task_004")
  ├─> 写文档...
  ├─> complete_task("task_004")
  └─> 所有任务完成
```

---

## 八、总结

### 设计理念

```
"大目标拆成小任务，排好序，持久化"

三层设计：
1. 拆分（Task dataclass）
2. 依赖（blockedBy + can_start）
3. 持久化（.tasks/ 目录）
```

### 核心机制

```
核心机制：

1. 依赖关系维护
   ├─> 分散式存储（每个 Task 的 blockedBy）
   ├─> 没有显式 DAG（教学版简化）
   └─> CC 有 blocks + blockedBy 双向指针

2. 工具调用
   ├─> LLM 通过 tool_use 调用
   ├─> create_task、claim_task、complete_task
   └─> LLM 主动决策何时调用

3. LLM 构建+管理图
   ├─> LLM 创建任务（通过 blockedBy 构建依赖）
   ├─> LLM 执行任务（通过 list_tasks 看状态）
   ├─> LLM 决策下一步（根据 Unblocked 信息）
   └─> 系统提供工具和信息，LLM 做决策

4. 通知机制
   ├─> complete_task 返回 Unblocked 信息
   ├─> 通过 tool_result 返回给 LLM
   ├─> LLM 看到信息，自己判断下一步
   └─> 不自动执行（LLM 需要决策优先级）

5. 不会卡死的机制
   ├─> LLM 可以随时查看任务列表
   ├─> LLM 有推理能力（分析阻塞原因）
   ├─> LLM 会主动去做阻塞任务
   └─> 教学版缺少环检测（可能真正卡死）
```

### LLM 的角色

```
LLM 的三重角色：

1. 构建者
   ├─> 理解用户需求
   ├─> 拆分任务
   ├─> 设置依赖关系
   └─> 构建任务图

2. 管理者
   ├─> 查看任务状态
   ├─> 认领任务
   ├─> 执行任务内容
   └─> 完成任务

3. 决策者
   ├─> 分析依赖关系
   ├─> 判断解锁情况
   ├─> 决策下一步
   └─> 决策优先级

关键理解：
- 系统提供工具和信息
- LLM 做所有决策
- 系统不自动执行
- LLM 有主动思考能力
```
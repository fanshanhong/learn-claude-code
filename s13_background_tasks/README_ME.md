# s13 Background Tasks 深度解析

## 一、核心问题与解决思路

### 1.1 问题场景

想象你在洗衣服：
- ❌ **错误做法**：把衣服放进洗衣机，然后站在机器前等30分钟什么都不做
- ✅ **正确做法**：按下启动后去干别的（做饭、回消息、看论文），等洗衣机"滴滴滴"提醒你

Claude Code 的 Agent 也面临同样的问题：
```
传统同步模式：
Turn 1: Agent → bash "npm install" (等待 3 分钟...)
        ↓ [Agent 在这里干等，LLM 按 token 计费中...]
Turn 2: Agent → 收到结果，继续工作

后台异步模式：
Turn 1: Agent → bash "npm install" (后台运行)
        → tool_result: "已启动后台任务 bg_0001"
        Agent → "好，我先去看配置文件"
        → read_file "package.json" (同步快速返回)
Turn 2: Agent 收到：配置内容 + <task_notification> npm install 完成
```

### 1.2 设计哲学

**核心原则**：
1. **不阻塞主循环** - 慢操作丢后台，Agent 继续工作
2. **通知驱动** - 后台完成后主动通知，不需要轮询
3. **生命周期管理** - 每个后台任务有唯一 ID 和完整状态追踪

---

## 二、架构设计

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                      Agent Loop                              │
│                                                               │
│  ┌──────────┐    ┌──────────────────────┐                   │
│  │  LLM     │───→│  Tool Use Decision   │                   │
│  │ Response │    │  (should_run_bg?)    │                   │
│  └──────────┘    └──────────────────────┘                   │
│                           │                                   │
│                 ┌─────────┴─────────┐                         │
│                 │                   │                         │
│          ┌──────▼──────┐    ┌─────▼──────┐                  │
│          │ Fast Op     │    │ Slow Op    │                  │
│          │ (Sync)      │    │ (Background)│                  │
│          └──────┬──────┘    └─────┬──────┘                  │
│                 │                   │                         │
│                 │            ┌──────▼─────────┐               │
│                 │            │ Background     │               │
│                 │            │ Thread Pool    │               │
│                 │            │                │               │
│                 │            │  bg_0001: npm  │               │
│                 │            │  bg_0002: test │               │
│                 │            └──────┬─────────┘               │
│                 │                   │                         │
│          ┌──────▼───────────────────▼──────┐                 │
│          │   Collect Results + Notify      │                 │
│          │   - Sync results (tool_result)  │                 │
│          │   - BG notifications (<task_..) │                 │
│          └─────────────┬───────────────────┘                 │
│                        │                                      │
│                 ┌──────▼──────┐                               │
│                 │ Next Turn   │                               │
│                 │ User Msg    │                               │
│                 │ (results +  │                               │
│                 │  notifs)    │                               │
│                 └─────────────┘                               │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 三大核心组件

#### A. 决策器：should_run_background

```python
def should_run_background(tool_name: str, tool_input: dict) -> bool:
    """决策逻辑：显式请求优先，启发式兜底"""
    
    # 优先级 1: 模型显式请求
    if tool_input.get("run_in_background"):
        return True
    
    # 优先级 2: 启发式判断（教学版兜底）
    return is_slow_operation(tool_name, tool_input)

def is_slow_operation(tool_name: str, tool_input: dict) -> bool:
    """关键词启发式：判断命令是否可能耗时 > 30s"""
    if tool_name != "bash":
        return False
    cmd = tool_input.get("command", "").lower()
    slow_keywords = [
        "install", "build", "test", "deploy", "compile",
        "docker build", "pip install", "npm install",
        "cargo build", "pytest", "make"
    ]
    return any(kw in cmd for kw in slow_keywords)
```

**关键设计点**：
- **显式 > 隐式**：模型通过 `run_in_background` 参数明确表达意图
- **启发式兜底**：教学版提供关键词匹配，生产环境完全依赖模型判断
- **工具范围**：只对 bash 工具生效（读文件等操作天然快）

#### B. 执行器：后台任务生命周期

```python
# 全局状态管理
_bg_counter = 0
background_tasks: dict[str, dict] = {}   # bg_id → task metadata
background_results: dict[str, str] = {}  # bg_id → output
background_lock = threading.Lock()        # 线程安全

def start_background_task(block) -> str:
    """启动后台任务，返回 bg_id"""
    global _bg_counter
    _bg_counter += 1
    bg_id = f"bg_{_bg_counter:04d}"  # 唯一 ID
    
    def worker():
        """后台线程的工作函数"""
        result = execute_tool(block)  # 执行工具
        with background_lock:
            background_tasks[bg_id]["status"] = "completed"
            background_results[bg_id] = result
    
    # 注册任务
    with background_lock:
        background_tasks[bg_id] = {
            "tool_use_id": block.id,
            "command": block.input.get("command", ""),
            "status": "running",
        }
    
    # 启动守护线程
    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    return bg_id
```

**生命周期状态机**：
```
┌─────────┐   start_background_task()   ┌──────────┐
│ Created │ ────────────────────────→   │ Running  │
└─────────┘                             └────┬─────┘
                                             │
                                      worker() 完成
                                             │
                                             ▼
                                       ┌───────────┐
                                       │ Completed │
                                       └───────────┘
                                             │
                                      collect_background_results()
                                             │
                                             ▼
                                        被消费，从字典中删除
```

#### C. 通知器：结果收集与注入

```python
def collect_background_results() -> list[str]:
    """收集完成的后台任务，格式化为通知"""
    with background_lock:
        # 找出所有已完成的任务
        ready_ids = [bid for bid, task in background_tasks.items()
                     if task["status"] == "completed"]
    
    notifications = []
    for bg_id in ready_ids:
        with background_lock:
            task = background_tasks.pop(bg_id)  # 删除任务元数据
            output = background_results.pop(bg_id, "")  # 删除结果
        
        summary = output[:200] if len(output) > 200 else output
        notifications.append(
            f"<task_notification>\n"
            f"  <task_id>{bg_id}</task_id>\n"
            f"  <status>completed</status>\n"
            f"  <command>{task['command']}</command>\n"
            f"  <summary>{summary}</summary>\n"
            f"</task_notification>"
        )
        print(f"[background done] {bg_id}: {task['command'][:40]}")
    
    return notifications
```

**通知格式设计**：
```xml
<task_notification>
  <task_id>bg_0001</task_id>
  <status>completed</status>
  <command>npm install</command>
  <summary>added 1423 packages in 45s...</summary>
</task_notification>
```

**为什么不复用 tool_use_id？**
- ✅ **正确的做法**：原始 tool call 已经用占位 tool_result 回复了
- ✅ **独立事件**：后台完成是新的独立事件，用 task_notification 格式
- ❌ **错误的做法**：复用 tool_use_id 会违反 Messages API 的语义（一个 tool_use 对应一个 tool_result）

---

## 三、Agent Loop 集成

### 3.1 工具执行双路径

```python
def agent_loop(messages: list, context: dict):
    while True:
        response = client.messages.create(...)
        
        if response.stop_reason != "tool_use":
            return
        
        results = []
        for block in response.content:
            if block.type != "tool_use":
                continue
            
            # 决策：是否后台运行？
            if should_run_background(block.name, block.input):
                # 路径 1: 后台执行
                bg_id = start_background_task(block)
                results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": f"[Background task {bg_id} started] "
                               f"Result will be available when complete."
                })
            else:
                # 路径 2: 同步执行
                output = execute_tool(block)
                results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": output
                })
        
        # 合并结果和通知
        user_content = list(results)
        bg_notifications = collect_background_results()
        if bg_notifications:
            for notif in bg_notifications:
                user_content.append({"type": "text", "text": notif})
        
        messages.append({"role": "user", "content": user_content})
```

### 3.2 执行流程示例

**场景**：用户要求 "npm install 并读取 package.json"

```
Turn 1:
  LLM → bash "npm install" (run_in_background=true)
  
  Agent Loop:
    should_run_background() → True
    start_background_task() → bg_0001
    tool_result: "[Background task bg_0001 started]..."
  
  LLM → "好的，我先看配置文件"
  LLM → read_file "package.json"
  
  Agent Loop:
    should_run_background() → False (read_file 很快)
    output = execute_tool(read_file) → 文件内容
    tool_result: "{...package.json content...}"
  
  User Message:
    [
      tool_result(bg_0001 占位),
      tool_result(package.json 内容)
    ]

Turn 2:
  后台任务完成：
    bg_0001 worker thread → completed
  
  collect_background_results():
    <task_notification>
      <task_id>bg_0001</task_id>
      <status>completed</status>
      ...
    </task_notification>
  
  LLM 收到：
    [
      tool_result(之前的结果),
      text(<task_notification>npm install 完成)
    ]
  
  LLM → "npm install 已完成，我看到 package.json 里..."
```

---

## 四、关键实现细节

### 4.1 线程安全设计

```python
background_lock = threading.Lock()

# 写操作：加锁
def start_background_task(block):
    with background_lock:
        background_tasks[bg_id] = {...}
    thread.start()

# 写操作：加锁
def worker():
    result = execute_tool(block)
    with background_lock:
        background_tasks[bg_id]["status"] = "completed"
        background_results[bg_id] = result

# 读操作：加锁
def collect_background_results():
    with background_lock:
        ready_ids = [...]
    # 删除操作也要加锁
    for bg_id in ready_ids:
        with background_lock:
            task = background_tasks.pop(bg_id)
```

**为什么需要锁？**
- 主线程：启动后台任务、收集结果
- 后台线程：执行工具、写入结果
- **竞态条件**：两线程同时访问 `background_tasks` 和 `background_results`

### 4.2 Daemon 线程

```python
thread = threading.Thread(target=worker, daemon=True)
```

**daemon=True 的作用**：
- 当主进程退出时，所有 daemon 线程自动终止
- 避免孤儿线程：Agent 进程退出后，后台任务跟着结束

### 4.3 内存管理

```python
# 任务完成后立即清理
def collect_background_results():
    for bg_id in ready_ids:
        task = background_tasks.pop(bg_id)      # 删除元数据
        output = background_results.pop(bg_id)  # 删除结果
```

**为什么不保留结果？**
- 已通过 `<task_notification>` 注入到对话历史
- 避免内存泄漏：长时间运行会积累大量后台任务结果
- 对话历史已持久化，无需二次存储

---

## 五、生产环境差异

### 5.1 教学版 vs 生产版

| 特性 | 教学版 | 生产版 (Claude Code) |
|------|--------|----------------------|
| 判断方式 | 关键词启发式 | 模型显式 `run_in_background` |
| 执行环境 | Python threading.Thread | Node.js 单线程 + 不 await |
| 任务存储 | 内存字典 | 文件 + 数据库 |
| 通知机制 | 同步收集 | 命令队列 (`messageQueueManager.ts`) |
| 任务类型 | 仅 bash | 7 种（bash/agent/workflow/mcp...） |
| 任务控制 | 无 | 停止任务、读取后续输出、看门狗 |
| 并发限制 | 无 | 前台 10 并发，后台无限制 |

### 5.2 Claude Code 的七种后台任务

```typescript
// Task.ts:7-13
type TaskType = 
  | "local_bash"       // 本地 shell 命令
  | "local_agent"      // 本地子 agent
  | "remote_agent"     // 远程 agent
  | "in_process_teammate"  // 进程内队友
  | "local_workflow"   // 本地工作流
  | "monitor_mcp"      // MCP 监控
  | "dream"            // 梦境（特殊状态）
```

### 5.3 通知队列机制

```typescript
// 生产版伪代码
messageQueueManager.enqueuePendingNotification({
  type: "task_notification",
  taskId: "bg_0001",
  status: "completed",
  summary: "...",
  priority: "later"  // 不阻塞用户输入
})

// 优先级：next > later
// next: 立即处理（如错误）
// later: 等待下一轮 turn
```

### 5.4 看门狗机制

```typescript
// LocalShellTask.tsx
const STALL_TIMEOUT = 45000  // 45秒无输出

function checkStall() {
  // 检测输出是否停滞
  if (outputNotGrowing && interactivePrompt) {
    // 检测交互式提示符 (y/n), [yes/no]
    notifyUser("后台任务可能卡在交互式对话框")
  }
}
```

**防止后台任务卡住**：
- 45 秒输出无增长 → 可能卡住
- 检测交互式提示符 → 无人响应
- 主动通知用户干预

---

## 六、设计模式与最佳实践

### 6.1 设计模式应用

#### A. 命令模式 (Command Pattern)
```python
# 将工具调用封装为对象
block = ToolUseBlock(name="bash", input={"command": "npm install"})

# 可以同步执行
execute_tool(block)

# 也可以异步执行
start_background_task(block)
```

#### B. 观察者模式 (Observer Pattern)
```python
# 后台任务是 Subject
# Agent Loop 是 Observer

# Subject 完成后通知 Observer
notifications = collect_background_results()
# Observer 响应通知
messages.append({"role": "user", "content": notifications})
```

#### C. 策略模式 (Strategy Pattern)
```python
# 工具执行策略：同步 vs 异步
def should_run_background(tool_name, tool_input):
    return tool_input.get("run_in_background") or is_slow_operation(...)

if should_run_background(...):
    execute_async(block)  # 异步策略
else:
    execute_sync(block)   # 同步策略
```

### 6.2 性能优化要点

#### 1. 避免过度后台化
```python
# ✅ 正确：耗时操作
npm install          # 分钟级 → 后台
docker build         # 分钟级 → 后台
pytest tests/        # 分钟级 → 后台

# ❌ 错误：快速操作
git status           # 秒级 → 同步
read_file            # 毫秒级 → 同步
echo "hello"         # 毫秒级 → 同步
```

#### 2. 结果摘要
```python
# 避免通知过大
summary = output[:200] if len(output) > 200 else output
```

**原因**：
- 通知注入到对话历史 → 消耗 token
- LLM 可能不需要完整输出
- 用户可在工具输出文件中查看完整结果

#### 3. 线程池管理（生产版）
```typescript
// 避免无限制创建线程
const MAX_BACKGROUND_TASKS = 10
const taskQueue = new Queue()

function startBackgroundTask(block) {
  if (taskQueue.size >= MAX_BACKGROUND_TASKS) {
    return "Error: Too many background tasks"
  }
  // ...
}
```

---

## 七、常见问题与陷阱

### 7.1 通知丢失

**问题**：后台任务完成，但 Agent 没收到通知

**原因**：
```python
# ❌ 错误：只收集，不注入
bg_notifications = collect_background_results()
# 忘记加到 messages 中！

# ✅ 正确：收集并注入
user_content = list(results)
bg_notifications = collect_background_results()
if bg_notifications:
    for notif in bg_notifications:
        user_content.append({"type": "text", "text": notif})
messages.append({"role": "user", "content": user_content})
```

### 7.2 竞态条件

**问题**：多个后台任务同时写入结果

```python
# ❌ 错误：无锁访问
background_results[bg_id] = result  # 线程不安全！

# ✅ 正确：加锁访问
with background_lock:
    background_results[bg_id] = result
```

### 7.3 内存泄漏

**问题**：长时间运行，内存持续增长

```python
# ❌ 错误：只添加，不清理
background_tasks[bg_id] = {...}
background_results[bg_id] = result
# 从不删除！

# ✅ 正确：消费后立即清理
def collect_background_results():
    for bg_id in ready_ids:
        task = background_tasks.pop(bg_id)      # 删除
        output = background_results.pop(bg_id)  # 删除
```

### 7.4 错误处理缺失

**问题**：后台任务出错，Agent 永远等待

```python
# ❌ 错误：worker 可能抛异常，状态永远 running
def worker():
    result = execute_tool(block)  # 可能抛异常！
    background_tasks[bg_id]["status"] = "completed"

# ✅ 正确：捕获异常，设置失败状态
def worker():
    try:
        result = execute_tool(block)
        status = "completed"
    except Exception as e:
        result = f"Error: {e}"
        status = "failed"
    
    with background_lock:
        background_tasks[bg_id]["status"] = status
        background_results[bg_id] = result
```

---

## 八、扩展思考

### 8.1 与 s14 Cron Scheduler 的关系

```
s13: 后台任务 - "一次性异步执行"
    用户：npm install
    Agent：好的，后台运行，继续干活
    
s14: 定时任务 - "周期性自动执行"
    用户：每天 9 点跑测试
    Agent：好的，设置 cron job，每天自动触发
```

### 8.2 与 s06 Subagent 的协作

```python
# 后台启动子 agent
start_background_task(ToolUseBlock(
    name="agent",
    input={
        "prompt": "重构这个模块",
        "subagent_type": "code-refactorer"
    }
))
# 主 agent 继续工作，子 agent 在后台重构
```

### 8.3 未来优化方向

#### A. 优先级队列
```python
# 当前：FIFO
# 未来：优先级队列
background_tasks = PriorityQueue()
background_tasks.put((priority, task))

# 优先级：error > user > system > background
```

#### B. 资源限制
```python
# 限制并发后台任务数
MAX_BACKGROUND_TASKS = 10

# 限制内存使用
MAX_RESULT_SIZE = 1_000_000  # 1MB
```

#### C. 持久化
```python
# 当前：内存字典，重启丢失
# 未来：持久化到文件/数据库
def save_task_to_db(bg_id, task):
    db.execute("""
        INSERT INTO background_tasks 
        (id, command, status, result)
        VALUES (?, ?, ?, ?)
    """, (bg_id, task["command"], task["status"], result))
```

---

## 九、总结

### 核心要点

1. **问题本质**：慢操作阻塞 Agent 循环 → LLM 空转浪费
2. **解决思路**：后台执行 + 通知注入 → Agent 继续工作
3. **三大组件**：
   - 决策器：判断是否后台（显式请求 + 启发式兜底）
   - 执行器：daemon 线程 + 生命周期管理
   - 通知器：结果收集 + 格式化注入
4. **关键细节**：
   - 线程安全（Lock）
   - 内存管理（及时清理）
   - 错误处理（异常捕获）
   - Daemon 线程（避免孤儿）

### 设计哲学

> **不要让 Agent 等待，让 Agent 工作**

这就是 Background Tasks 的核心价值 —— 最大化 Agent 的利用效率，让 LLM token 花在刀刃上。
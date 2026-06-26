# Claude Code 生产环境后台任务实现深度分析

基于源码：`query.ts`、`LocalShellTask.tsx`、`messageQueueManager.ts`、`utils/task/framework.ts`

---

## 一、线程模型：没有真正的线程

### 1.1 Node.js 单线程事件循环

```javascript
// 教学版：Python threading.Thread
thread = threading.Thread(target=worker, daemon=True)
thread.start()

// 生产版：Node.js 异步（不 await）
async function startBackgroundTask(block) {
  // 不创建新线程，只是不等待结果
  const taskId = generateTaskId()
  
  // ShellCommand.background() 重定向输出到文件
  const process = shellCommand.background(taskId)
  
  // 立即返回，不 await process
  return taskId
}
```

**核心差异**：
| 维度 | 教学版 (Python) | 生产版 (Node.js) |
|------|----------------|------------------|
| 真实线程 | 是 (threading.Thread) | 否 (单线程 event loop) |
| "后台"定义 | 新线程执行 | 不 await Promise |
| 进程管理 | 主进程阻塞 | 子进程独立运行 |
| 输出捕获 | 内存字典 | 重定向到文件 |

### 1.2 ShellCommand.background() 实现原理

```typescript
// LocalShellTask.tsx 伪代码
class ShellCommand {
  background(taskId: string): ChildProcess {
    const stdoutPath = `/tmp/cc-${taskId}-stdout.log`
    const stderrPath = `/tmp/cc-${taskId}-stderr.log`
    
    return spawn(this.command, {
      stdio: ['ignore', fs.openSync(stdoutPath, 'w'), fs.openSync(stderrPath, 'w')],
      detached: true  // 子进程独立，不受父进程退出影响
    })
  }
}
```

**关键技术**：
- `stdio: ['ignore', file, file]` - 重定向输出到文件
- `detached: true` - 子进程独立运行，父进程退出不影响
- 输出文件路径：`/tmp/cc-{taskId}-{stdout/stderr}.log`

---

## 二、七种后台任务类型

### 2.1 任务类型定义

```typescript
// Task.ts:7-13
enum TaskType {
  LOCAL_BASH = "local_bash",              // 本地 shell 命令
  LOCAL_AGENT = "local_agent",            // 本地子 agent
  REMOTE_AGENT = "remote_agent",          // 远程 cloud agent
  IN_PROCESS_TEAMMATE = "in_process_teammate",  // 进程内队友
  LOCAL_WORKFLOW = "local_workflow",      // 本地工作流
  MONITOR_MCP = "monitor_mcp",            // MCP server 监控
  DREAM = "dream"                         // 特殊梦境状态
}
```

### 2.2 每种类型的特点

#### A. local_bash
```typescript
{
  type: "local_bash",
  command: "npm install",
  taskId: "bg_0001",
  stdoutPath: "/tmp/cc-bg_0001-stdout.log",
  stderrPath: "/tmp/cc-bg_0001-stderr.log",
  startTime: 1623456789,
  status: "running"
}
```

#### B. local_agent
```typescript
{
  type: "local_agent",
  prompt: "Find all security bugs",
  subagentType: "security-reviewer",
  agentId: "a1b2c3d4",
  isolation: "worktree",  // 可选：独立 git worktree
  status: "running"
}
```

#### C. remote_agent
```typescript
{
  type: "remote_agent",
  prompt: "Research latest React patterns",
  cloudProvider: "aws",
  region: "us-west-2",
  status: "queued"
}
```

#### D. in_process_teammate
```typescript
{
  type: "in_process_teammate",
  name: "researcher",
  role: "Search the web for documentation",
  status: "active"
}
```

#### E. local_workflow
```typescript
{
  type: "local_workflow",
  workflowName: "code-review",
  phases: ["lint", "test", "security"],
  currentPhase: "lint",
  status: "running"
}
```

#### F. monitor_mcp
```typescript
{
  type: "monitor_mcp",
  serverName: "filesystem-server",
  healthCheckInterval: 30000,
  lastPing: 1623456789,
  status: "healthy"
}
```

#### G. dream
```typescript
{
  type: "dream",
  trigger: "user_idle_30min",
  activity: "compact_context",
  status: "active"
}
```

---

## 三、通知注入：命令队列机制

### 3.1 优先级队列

```typescript
// messageQueueManager.ts
enum NotificationPriority {
  NEXT = "next",    // 立即处理，阻塞用户输入
  LATER = "later"   // 等待下一轮，不阻塞
}

interface PendingNotification {
  type: string
  priority: NotificationPriority
  content: string
  timestamp: number
}

class MessageQueueManager {
  private nextQueue: PendingNotification[] = []
  private laterQueue: PendingNotification[] = []
  
  enqueuePendingNotification(notification: PendingNotification) {
    if (notification.priority === "next") {
      this.nextQueue.push(notification)
    } else {
      this.laterQueue.push(notification)
    }
  }
  
  consumeNotifications(): PendingNotification[] {
    // next 优先
    const next = this.nextQueue.splice(0)
    const later = this.laterQueue.splice(0)
    return [...next, ...later]
  }
}
```

### 3.2 任务通知格式

```xml
<task_notification>
  <task_id>bg_0001</task_id>
  <type>local_bash</type>
  <status>completed</status>
  <command>npm install</command>
  <summary>added 1423 packages in 45s</summary>
  <exit_code>0</exit_code>
  <stdout_path>/tmp/cc-bg_0001-stdout.log</stdout_path>
  <stderr_path>/tmp/cc-bg_0001-stderr.log</stderr_path>
  <duration_ms>45000</duration_ms>
</task_notification>
```

### 3.3 消费点：query.ts:1566-1593

```typescript
// query.ts 伪代码
async function processNextTurn() {
  const notifications = messageQueueManager.consumeNotifications()
  
  if (notifications.length > 0) {
    const notificationContent = notifications.map(n => n.content).join("\n\n")
    
    // 注入为 user message
    messages.push({
      role: "user",
      content: [
        { type: "text", text: notificationContent }
      ]
    })
    
    // 调用 LLM
    const response = await anthropic.messages.create({
      model: MODEL,
      messages: messages,
      tools: TOOLS
    })
    
    // 处理响应...
  }
}
```

---

## 四、停滞看门狗：防止卡住

### 4.1 看门狗逻辑

```typescript
// LocalShellTask.tsx L24-25
const STALL_TIMEOUT = 45000  // 45秒
const STALL_CHECK_INTERVAL = 5000  // 每5秒检查一次

// L59-98
class StallWatchdog {
  private lastOutputSize = 0
  private lastOutputTime = Date.now()
  private interactivePatterns = [
    /\(y\/n\)/i,
    /\[yes\/no\]/i,
    /\[Y\/n\]/i,
    /Enter password:/i,
    /Press Enter to continue/i
  ]
  
  checkStall(taskId: string, stdoutPath: string): boolean {
    const currentSize = fs.statSync(stdoutPath).size
    const now = Date.now()
    
    // 输出有增长，重置计时
    if (currentSize > this.lastOutputSize) {
      this.lastOutputSize = currentSize
      this.lastOutputTime = now
      return false
    }
    
    // 45秒无增长
    const elapsed = now - this.lastOutputTime
    if (elapsed > STALL_TIMEOUT) {
      // 检测交互式提示符
      const output = fs.readFileSync(stdoutPath, 'utf-8')
      for (const pattern of this.interactivePatterns) {
        if (pattern.test(output)) {
          // 发送警告通知
          enqueuePendingNotification({
            type: "task_stalled",
            priority: "next",  // 立即通知
            content: `
<task_notification>
  <task_id>${taskId}</task_id>
  <status>stalled</status>
  <reason>Interactive prompt detected, no response for 45s</reason>
  <prompt>Please check if the background task needs manual intervention</prompt>
</task_notification>
            `
          })
          return true
        }
      }
    }
    
    return false
  }
}
```

### 4.2 检测场景

**常见的交互式卡住场景**：
```bash
# 1. 确认提示
Continue? (y/n)

# 2. 密码输入
Enter password for sudo:

# 3. 分页显示
--More--

# 4. 选择菜单
Select an option [1-5]:

# 5. 等待输入
Press Enter to continue...
```

**看门狗的作用**：
- 防止后台任务无人响应卡住
- 主动通知用户干预
- 避免 Agent 永远等待一个卡住的任务

---

## 五、并发控制

### 5.1 前台工具并发限制

```typescript
// 配置常量
const MAX_TOOL_USE_CONCURRENCY = process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY || 10

// query.ts 工具执行伪代码
async function executeTools(toolCalls: ToolCall[]) {
  // 分组：safe vs unsafe
  const safeTools = toolCalls.filter(t => isSafeTool(t.name))
  const unsafeTools = toolCalls.filter(t => !isSafeTool(t.name))
  
  // safe 工具并发执行，限制数量
  const safeBatches = chunk(safeTools, MAX_TOOL_USE_CONCURRENCY)
  for (const batch of safeBatches) {
    await Promise.all(batch.map(executeTool))
  }
  
  // unsafe 工具串行执行
  for (const tool of unsafeTools) {
    await executeTool(tool)
  }
}
```

### 5.2 后台任务无硬性限制

```typescript
// 后台任务是独立进程，不占用主线程资源
// 理论上无限制，但实际受系统资源约束：
// - CPU 核数
// - 内存容量
// - 文件描述符限制
// - 进程数限制 (ulimit -u)
```

**为什么前台有限制，后台无限制？**
| 维度 | 前台工具 | 后台任务 |
|------|---------|---------|
| 执行位置 | 主线程 event loop | 独立子进程 |
| 资源占用 | 阻塞主循环 | 不阻塞 |
| 并发影响 | 过多会卡死主循环 | 系统级调度 |
| 控制方式 | 硬性限制 (10) | 系统资源自然限制 |

---

## 六、pendingToolUseSummary：Haiku 后台生成

### 6.1 工具使用摘要

```typescript
// query.ts:1411-1482
async function generateToolUseSummary(toolCalls: ToolCall[]) {
  // 在主模型流式输出期间，启动 Haiku side-query
  const summaryPromise = anthropic.messages.create({
    model: "claude-haiku-4-5",  // 快速小模型
    system: TOOL_USE_SUMMARY_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: JSON.stringify(toolCalls)
    }],
    max_tokens: 100
  })
  
  // 不 await，让 Haiku 在后台生成
  return summaryPromise
}

// services/toolUseSummary/toolUseSummaryGenerator.ts:15
const TOOL_USE_SUMMARY_SYSTEM_PROMPT = `
Write a short summary label for these tool calls.
Think git-commit-subject, not sentence.
Past tense, ~30 characters.
Focus on the action, not the details.

Examples:
- "npm install completed"
- "read package.json"
- "created task_123"
`
```

### 6.2 时间优化

```
传统方案：
  工具执行 (5s)
  → 主模型生成 (30s)
  → Haiku 摘要 (1s)
  → 下一轮
  总耗时：36s

优化方案：
  工具执行 (5s)
  → 同时启动：
      主模型生成 (30s)
      Haiku 摘要 (1s)
  → 下一轮开始前，摘要已就绪
  总耗时：30s (节省 6s)
```

**收益**：
- Haiku 摘要 (~1s) 在主模型生成 (5-30s) 期间完成
- SDK 消费摘要做移动端进度展示
- 每轮节省约 1s

---

## 七、完整生命周期示例

### 7.1 用户请求：npm install

```typescript
// Step 1: Agent 决策
const toolCall = {
  name: "bash",
  input: {
    command: "npm install",
    run_in_background: true
  }
}

// Step 2: 判断后台执行
should_run_background() → true

// Step 3: 启动后台任务
const taskId = "bg_0001"
const stdoutPath = "/tmp/cc-bg_0001-stdout.log"
const stderrPath = "/tmp/cc-bg_0001-stderr.log"

const process = spawn("npm install", {
  stdio: ['ignore', fs.openSync(stdoutPath, 'w'), fs.openSync(stderrPath, 'w')],
  detached: true
})

// Step 4: 注册任务状态
backgroundTasks.set(taskId, {
  type: "local_bash",
  command: "npm install",
  process: process,
  startTime: Date.now(),
  status: "running",
  stdoutPath: stdoutPath,
  stderrPath: stderrPath
})

// Step 5: 立即返回占位结果
return {
  tool_use_id: toolCall.id,
  content: `[Background task ${taskId} started] Result will be available when complete.`
}

// Step 6: Agent 继续工作（如 read_file）
// ...

// Step 7: npm install 完成（45秒后）
process.on('exit', (code) => {
  backgroundTasks.get(taskId).status = "completed"
  backgroundTasks.get(taskId).exitCode = code
  
  // Step 8: 收集结果
  const stdout = fs.readFileSync(stdoutPath, 'utf-8')
  const stderr = fs.readFileSync(stderrPath, 'utf-8')
  const summary = (stdout + stderr).substring(0, 200)
  
  // Step 9: 注入通知
  enqueueTaskNotification({
    taskId: taskId,
    type: "task_notification",
    priority: "later",
    content: `
<task_notification>
  <task_id>${taskId}</task_id>
  <status>completed</status>
  <command>npm install</command>
  <summary>${summary}</summary>
  <exit_code>${code}</exit_code>
  <duration_ms>45000</duration_ms>
</task_notification>
    `
  })
})

// Step 10: 下轮开始，消费通知
const notifications = messageQueueManager.consumeNotifications()
messages.push({
  role: "user",
  content: notifications.map(n => n.content)
})

// Step 11: Agent 看到通知
LLM → "npm install 已完成，我继续..."
```

---

## 八、错误处理与恢复

### 8.1 任务失败

```typescript
// 后台任务出错
process.on('error', (err) => {
  backgroundTasks.get(taskId).status = "failed"
  
  enqueueTaskNotification({
    taskId: taskId,
    priority: "next",  // 立即通知
    content: `
<task_notification>
  <task_id>${taskId}</task_id>
  <status>failed</status>
  <error>${err.message}</error>
  <prompt>Please check the command and retry</prompt>
</task_notification>
    `
  })
})
```

### 8.2 进程超时

```typescript
// 设置超时（如 120 秒）
const TIMEOUT = 120000
const timer = setTimeout(() => {
  process.kill('SIGKILL')
  
  backgroundTasks.get(taskId).status = "timeout"
  
  enqueueTaskNotification({
    priority: "next",
    content: `
<task_notification>
  <task_id>${taskId}</task_id>
  <status>timeout</status>
  <reason>Command exceeded ${TIMEOUT}ms timeout</reason>
</task_notification>
    `
  })
}, TIMEOUT)

// 正常完成时取消超时
process.on('exit', () => clearTimeout(timer))
```

### 8.3 用户取消

```typescript
// 停止后台任务
function stopBackgroundTask(taskId: string) {
  const task = backgroundTasks.get(taskId)
  if (task && task.status === "running") {
    task.process.kill('SIGTERM')
    task.status = "cancelled"
    
    enqueueTaskNotification({
      priority: "later",
      content: `
<task_notification>
  <task_id>${taskId}</task_id>
  <status>cancelled</status>
  <reason>User requested cancellation</reason>
</task_notification>
      `
    })
  }
}
```

---

## 九、性能优化技巧

### 9.1 输出摘要

```typescript
// 只保留前 200 字符
const summary = output.substring(0, 200)

// 完整输出在文件中
const fullOutputPath = `/tmp/cc-${taskId}-stdout.log`

// 通知中告知文件路径
<task_notification>
  <summary>${summary}</summary>
  <stdout_path>${fullOutputPath}</stdout_path>
  <prompt>Full output available at ${fullOutputPath}</prompt>
</task_notification>
```

**原因**：
- 通知注入对话 → 消耗 token
- LLM 可能不需要完整输出
- 文件路径让用户可查看完整内容

### 9.2 批量通知

```typescript
// 不一条一条通知，批量收集
const notifications = []
for (const [taskId, task] of backgroundTasks) {
  if (task.status === "completed") {
    notifications.push(formatNotification(taskId, task))
    backgroundTasks.delete(taskId)  // 清理
  }
}

// 一次性注入所有通知
if (notifications.length > 0) {
  enqueuePendingNotification({
    priority: "later",
    content: notifications.join("\n\n")
  })
}
```

### 9.3 增量输出

```typescript
// 实时查看后台任务输出（可选功能）
function getIncrementalOutput(taskId: string, lastPosition: number) {
  const stdoutPath = backgroundTasks.get(taskId).stdoutPath
  const fd = fs.openSync(stdoutPath, 'r')
  
  // 从上次位置读取新增内容
  const buffer = Buffer.alloc(1024)
  const bytesRead = fs.readSync(fd, buffer, 0, 1024, lastPosition)
  
  return {
    output: buffer.toString('utf-8', 0, bytesRead),
    newPosition: lastPosition + bytesRead
  }
}
```

---

## 十、总结：教学版 vs 生产版

| 特性 | 教学版 (Python) | 生产版 (Node.js) |
|------|----------------|------------------|
| 真实线程 | threading.Thread | 单线程 event loop |
| "后台"定义 | 新线程执行 | 不 await Promise |
| 进程管理 | 主进程阻塞 | 子进程独立 (detached) |
| 输出存储 | 内存字典 | 重定向到文件 |
| 任务类型 | 仅 bash | 7 种（bash/agent/workflow/mcp...） |
| 通知机制 | 同步收集 | 命令队列 + 优先级 |
| 看门狗 | 无 | 45 秒停滞检测 |
| 错误处理 | 基础 | 超时、失败、取消 |
| 并发限制 | 无 | 前台 10，后台无硬性限制 |
| 摘要生成 | 无 | Haiku 后台生成 (~1s) |
| 持久化 | 无 | 文件 + 数据库 |
| 监控 | 无 | MCP server 健康检查 |

**核心差异的本质**：
- Python：多线程并发
- Node.js：异步非阻塞 + 独立子进程

**设计哲学一致**：
> 不阻塞主循环，让 Agent 继续工作
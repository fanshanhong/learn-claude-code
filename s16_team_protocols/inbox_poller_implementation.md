# 真实 Claude Code 的 Inbox Poller 实现详解

> 本文档详细记录真实 CC 的 inbox poller 机制，包括设计原理、代码实现和关键细节

---

## 目录

1. [Inbox Poller 核心机制](#一inbox-poller-核心机制)
2. [TypeScript 完整实现](#二typescript-完整实现)
3. [Python 教学版改进实现](#三python-教学版改进实现)
4. [关键设计细节](#四关键设计细节)
5. [与其他组件的交互](#五与其他组件的交互)
6. [常见问题和解决方案](#六常见问题和解决方案)

---

## 一、Inbox Poller 核心机制

### 1.1 设计理念

**核心思想**：使用独立的后台线程轮询 Lead 的收件箱，发现消息立即处理，不需要等待用户输入。

```
传统方式（教学版）：
用户输入 → Lead 处理 → inbox检查 → 注入 → 等待用户 → 用户输入 → Lead看到inbox

真实CC方式（inbox poller）：
用户输入 → Lead 处理 ←────┐
                         │
后台线程：每1秒轮询 inbox → 发现消息 → submitNewTurn → Lead立即处理
                         │
                         └─ 并行执行！
```

### 1.2 架构对比

#### 教学版架构（串行）

```
┌─────────────────────────────────────┐
│  Lead Agent                         │
│                                     │
│  用户输入 ──→ 主循环 ──→ inbox检查  │
│  ↓                                  │
│  注入history                        │
│  ↓                                  │
│  等待用户输入 ←──────────────────── │
│  ↓                                  │
│  用户输入 ──→ 主循环（看到inbox）   │
│                                     │
│  ❌ inbox消息要等用户下次输入才处理 │
└─────────────────────────────────────┘
```

#### 真实CC架构（并行）

```
┌─────────────────────────────────────────────┐
│  Lead Agent                                 │
│                                             │
│  ┌────────────────────────────────────────┐ │
│  │  主线程：用户交互                       │ │
│  │  用户输入 ──→ 主循环 ──→ 等待用户输入  │ │
│  └────────────────────────────────────────┘ │
│                                             │
│  ┌────────────────────────────────────────┐ │
│  │  Inbox Poller（后台线程）              │ │
│  │  每1秒轮询 inbox                       │ │
│  │  ↓                                     │ │
│  │  发现消息 ──→ submitNewTurn           │ │
│  │  ↓                                     │ │
│  │  立即触发 Lead LLM 调用                │ │
│  └────────────────────────────────────────┘ │
│                                             │
│  ✅ inbox消息立即处理（最多1秒延迟）        │
└─────────────────────────────────────────────┘
```

### 1.3 关键优势

| 维度 | 教学版（串行） | 真实CC（并行） |
|------|--------------|--------------|
| **响应速度** | ❌ 慢（等用户输入） | ✅ 快（最多1秒） |
| **用户体验** | ❌ 需输入两次才看到结果 | ✅ 实时更新 |
| **并发性** | ❌ 串行处理 | ✅ 并行处理 |
| **实时性** | ❌ 被动触发 | ✅ 主动轮询 |
| **成本** | ✅ 可控 | ❌ 需控制 |
| **复杂度** | ✅ 简单 | ❌ 复杂 |

---

## 二、TypeScript 完整实现

### 2.1 核心代码结构

```typescript
// 文件位置：utils/inboxPoller.ts

import { setInterval, clearInterval } from 'node:timers'
import { readInbox, matchResponse } from './messageBus'
import { submitNewTurn, getHistory } from './agentLoop'

/**
 * Inbox Poller - 后台线程轮询 Lead 的收件箱
 * 
 * 设计要点：
 * 1. 每1秒轮询一次 inbox
 * 2. 发现消息立即 submitNewTurn
 * 3. 自动路由协议响应（shutdown_response, plan_approval_response）
 * 4. 与主线程并行执行（不阻塞用户交互）
 */

let pollerId: NodeJS.Timeout | null = null
const POLL_INTERVAL = 1000  // 1秒

/**
 * 启动 Inbox Poller
 */
export function startInboxPoller() {
  if (pollerId !== null) {
    console.warn('[inboxPoller] Already running')
    return
  }

  console.log('[inboxPoller] Starting...')
  
  pollerId = setInterval(async () => {
    try {
      await pollAndProcessInbox()
    } catch (error) {
      console.error('[inboxPoller] Error:', error)
    }
  }, POLL_INTERVAL)
  
  console.log('[inboxPoller] Started (interval: 1000ms)')
}

/**
 * 停止 Inbox Poller
 */
export function stopInboxPoller() {
  if (pollerId === null) {
    return
  }
  
  clearInterval(pollerId)
  pollerId = null
  console.log('[inboxPoller] Stopped')
}

/**
 * 轮询并处理 inbox
 */
async function pollAndProcessInbox() {
  // ① 读取 Lead 的 inbox
  const messages = await readInbox('lead')
  
  if (messages.length === 0) {
    return  // 无消息，继续轮询
  }
  
  console.log(`[inboxPoller] Found ${messages.length} messages`)
  
  // ② 路由协议响应（shutdown_response, plan_approval_response）
  for (const msg of messages) {
    const metadata = msg.metadata || {}
    const requestId = metadata.request_id
    const msgType = msg.type
    
    if (requestId && msgType.endsWith('_response')) {
      const approve = metadata.approve || false
      await matchResponse(msgType, requestId, approve)
      console.log(`[inboxPoller] Routed protocol response: ${msgType} (${requestId})`)
    }
  }
  
  // ③ 格式化消息
  const inboxText = formatInboxMessages(messages)
  
  // ④ 提交新的 turn（立即触发 Lead LLM）
  await submitNewTurn({
    role: 'user',
    content: `[Inbox]\n${inboxText}`
  })
  
  console.log('[inboxPoller] Submitted new turn with inbox messages')
}

/**
 * 格式化 inbox 消息
 */
function formatInboxMessages(messages: any[]): string {
  return messages.map(msg => {
    const from = msg.from || 'unknown'
    const type = msg.type || 'message'
    const content = msg.content || ''
    const metadata = msg.metadata || {}
    const requestId = metadata.request_id
    
    let line = `From ${from}: [${type}]`
    if (requestId) {
      line += ` (req:${requestId})`
    }
    line += ` ${content.substring(0, 200)}`
    
    return line
  }).join('\n')
}
```

### 2.2 submitNewTurn 实现

```typescript
// 文件位置：utils/agentLoop.ts

import { Anthropic } from '@anthropic-ai/sdk'
import { getHistory, addToHistory } from './historyManager'

const client = new Anthropic()
const MODEL = 'claude-3-5-sonnet-20241022'

/**
 * submitNewTurn - 提交新的对话轮次
 * 
 * 关键功能：
 * 1. 注入消息到 history
 * 2. 立即调用 Lead LLM
 * 3. 处理工具调用
 * 4. 不需要等待用户输入
 */

export async function submitNewTurn(content: any) {
  // ① 添加到 history
  addToHistory(content)
  console.log('[submitNewTurn] Added to history')
  
  // ② 立即调用 Lead LLM
  await callLeadLLM()
  console.log('[submitNewTurn] LLM call completed')
}

/**
 * 调用 Lead LLM
 */
async function callLeadLLM() {
  const history = getHistory()
  const systemPrompt = getSystemPrompt()
  const tools = getTools()
  
  try {
    const response = await client.messages.create({
      model: MODEL,
      system: systemPrompt,
      messages: history,
      tools: tools,
      max_tokens: 8000
    })
    
    // ③ 添加 assistant response
    addToHistory({
      role: 'assistant',
      content: response.content
    })
    
    // ④ 如果需要工具调用，继续处理
    if (response.stop_reason === 'tool_use') {
      await handleToolCalls(response.content)
    }
    
  } catch (error) {
    console.error('[callLeadLLM] Error:', error)
    addToHistory({
      role: 'assistant',
      content: [
        { type: 'text', text: `[Error] ${error.message}` }
      ]
    })
  }
}

/**
 * 处理工具调用
 */
async function handleToolCalls(content: any[]) {
  const toolResults = []
  
  for (const block of content) {
    if (block.type !== 'tool_use') {
      continue
    }
    
    console.log(`[handleToolCalls] Executing: ${block.name}`)
    
    const result = await executeTool(block)
    toolResults.push({
      type: 'tool_result',
      tool_use_id: block.id,
      content: result
    })
  }
  
  if (toolResults.length > 0) {
    addToHistory({
      role: 'user',
      content: toolResults
    })
    
    // 继续调用 LLM（处理工具结果）
    await callLeadLLM()
  }
}
```

### 2.3 History Manager 实现

```typescript
// 文件位置：utils/historyManager.ts

import { Mutex } from 'async-mutex'

/**
 * History Manager - 管理 Lead 的对话历史
 * 
 * 关键设计：
 * 1. 使用 Mutex 保证线程安全（主线程和inbox poller并发访问）
 * 2. 持久化到文件（可选）
 * 3. 支持压缩（防止无限增长）
 */

const history: any[] = []
const historyMutex = new Mutex()

/**
 * 获取 history（线程安全）
 */
export async function getHistory(): Promise<any[]> {
  const release = await historyMutex.acquire()
  try {
    return [...history]  // 返回副本
  } finally {
    release()
  }
}

/**
 * 添加到 history（线程安全）
 */
export async function addToHistory(content: any) {
  const release = await historyMutex.acquire()
  try {
    history.push(content)
    
    // 可选：持久化到文件
    await saveHistoryToFile()
    
    // 可选：压缩历史（如果超过限制）
    if (history.length > 100) {
      await compactHistory()
    }
  } finally {
    release()
  }
}

/**
 * 持久化 history 到文件
 */
async function saveHistoryToFile() {
  const HISTORY_FILE = '.claude/history.json'
  // fs.writeFileSync(HISTORY_FILE, JSON.stringify(history))
}

/**
 * 压缩 history（防止无限增长）
 */
async function compactHistory() {
  // 保留最近50轮对话
  // 使用 autoCompact 算法（s08）
  // ...
}
```

### 2.4 完整集成示例

```typescript
// 文件位置：main.ts

import { startInboxPoller, stopInboxPoller } from './utils/inboxPoller'
import { handleUserInput } from './utils/userInputHandler'

/**
 * Lead Agent 主程序
 */

async function main() {
  console.log('Starting Lead Agent...')
  
  // ① 启动 Inbox Poller（后台线程）
  startInboxPoller()
  
  // ② 主线程：处理用户输入
  while (true) {
    const userInput = await getUserInput()
    
    if (userInput.trim().toLowerCase() === 'exit') {
      break
    }
    
    await handleUserInput(userInput)
  }
  
  // ③ 停止 Inbox Poller
  stopInboxPoller()
  
  console.log('Lead Agent stopped')
}

main().catch(console.error)
```

---

## 三、Python 教学版改进实现

### 3.1 Inbox Poller 实现（Python）

```python
# 文件位置：s16_team_protocols/inbox_poller.py

import threading
import time
import json
from pathlib import Path

from anthropic import Anthropic

client = Anthropic()
MODEL = "claude-3-5-sonnet-20241022"

MAILBOX_DIR = Path.cwd() / ".mailboxes"

# ── History Manager (线程安全) ──

history = []
history_lock = threading.Lock()

def get_history():
    """获取 history（线程安全）"""
    with history_lock:
        return list(history)  # 返回副本

def add_to_history(content):
    """添加到 history（线程安全）"""
    with history_lock:
        history.append(content)

# ── Inbox Poller ──

poller_running = False
POLL_INTERVAL = 1  # 1秒

def start_inbox_poller():
    """启动 Inbox Poller"""
    global poller_running
    
    if poller_running:
        print("[inboxPoller] Already running")
        return
    
    print("[inboxPoller] Starting...")
    poller_running = True
    
    def poller_loop():
        """Inbox Poller 主循环"""
        while poller_running:
            try:
                poll_and_process_inbox()
            except Exception as e:
                print(f"[inboxPoller] Error: {e}")
            
            time.sleep(POLL_INTERVAL)
    
    threading.Thread(target=poller_loop, daemon=True).start()
    print("[inboxPoller] Started (interval: 1s)")

def stop_inbox_poller():
    """停止 Inbox Poller"""
    global poller_running
    poller_running = False
    print("[inboxPoller] Stopped")

def poll_and_process_inbox():
    """轮询并处理 inbox"""
    # ① 读取 Lead 的 inbox
    inbox_file = MAILBOX_DIR / "lead.jsonl"
    if not inbox_file.exists():
        return
    
    messages = []
    with open(inbox_file, 'r') as f:
        for line in f:
            if line.strip():
                messages.append(json.loads(line))
    
    if not messages:
        return
    
    # ② 清空 inbox（消费式读取）
    inbox_file.unlink()
    
    print(f"[inboxPoller] Found {len(messages)} messages")
    
    # ③ 路由协议响应
    for msg in messages:
        metadata = msg.get("metadata", {})
        request_id = metadata.get("request_id", "")
        msg_type = msg.get("type", "")
        
        if request_id and msg_type.endswith("_response"):
            approve = metadata.get("approve", False)
            match_response(msg_type, request_id, approve)
            print(f"[inboxPoller] Routed: {msg_type} ({request_id})")
    
    # ④ 格式化消息
    inbox_text = format_inbox_messages(messages)
    
    # ⑤ 提交新的 turn（立即触发 LLM）
    submit_new_turn({
        "role": "user",
        "content": f"[Inbox]\n{inbox_text}"
    })

def format_inbox_messages(messages):
    """格式化 inbox 消息"""
    lines = []
    for msg in messages:
        from_agent = msg.get("from", "unknown")
        msg_type = msg.get("type", "message")
        content = msg.get("content", "")
        metadata = msg.get("metadata", {})
        request_id = metadata.get("request_id", "")
        
        line = f"From {from_agent}: [{msg_type}]"
        if request_id:
            line += f" (req:{request_id})"
        line += f" {content[:200]}"
        
        lines.append(line)
    
    return "\n".join(lines)

def match_response(msg_type, request_id, approve):
    """路由协议响应"""
    # 从 s16 导入
    # from s16_team_protocols.code import match_response
    # match_response(msg_type, request_id, approve)
    print(f"[match_response] {msg_type} {request_id} -> {approve}")

# ── submitNewTurn ──

def submit_new_turn(content):
    """提交新的对话轮次"""
    # ① 添加到 history
    add_to_history(content)
    print("[submitNewTurn] Added to history")
    
    # ② 立即调用 Lead LLM
    call_lead_llm()
    print("[submitNewTurn] LLM call completed")

def call_lead_llm():
    """调用 Lead LLM"""
    current_history = get_history()
    
    try:
        response = client.messages.create(
            model=MODEL,
            system="You are a lead agent.",
            messages=current_history,
            tools=get_tools(),
            max_tokens=8000
        )
        
        # ③ 添加 assistant response
        add_to_history({
            "role": "assistant",
            "content": response.content
        })
        
        # ④ 如果需要工具调用，继续处理
        if response.stop_reason == "tool_use":
            handle_tool_calls(response.content)
    
    except Exception as e:
        print(f"[callLeadLLM] Error: {e}")
        add_to_history({
            "role": "assistant",
            "content": [{"type": "text", "text": f"[Error] {e}"}]
        })

def handle_tool_calls(content):
    """处理工具调用"""
    results = []
    
    for block in content:
        if block.type != "tool_use":
            continue
        
        print(f"[handleToolCalls] Executing: {block.name}")
        result = execute_tool(block)
        results.append({
            "type": "tool_result",
            "tool_use_id": block.id,
            "content": str(result)
        })
    
    if results:
        add_to_history({"role": "user", "content": results})
        call_lead_llm()

def get_tools():
    """返回 Lead 的工具定义"""
    return [
        {"name": "bash", ...},
        {"name": "read_file", ...},
        {"name": "send_message", ...},
        {"name": "spawn_teammate", ...},
        # ...
    ]

def execute_tool(block):
    """执行工具"""
    # 导入工具执行器
    # ...
    return f"Executed {block.name}"
```

### 3.2 集成到 s16 主程序

```python
# 文件位置：s16_team_protocols/code_with_poller.py

from inbox_poller import start_inbox_poller, stop_inbox_poller

if __name__ == "__main__":
    print("s16: team protocols with inbox poller")
    print("Enter a question, press Enter to send. Type q to quit.\n")
    
    # ① 启动 Inbox Poller
    start_inbox_poller()
    
    history = []
    context = update_context({}, [])
    
    try:
        while True:
            try:
                query = input("\033[36ms16 >> \033[0m")
            except (EOFError, KeyboardInterrupt):
                break
            
            if query.strip().lower() in ("q", "exit", ""):
                break
            
            # ② 主线程：处理用户输入
            history.append({"role": "user", "content": query})
            agent_loop(history, context)
            
            # ③ 不需要再手动检查 inbox！
            # inbox_poller 会自动处理
            # inbox_msgs = consume_lead_inbox(...)  ← 删除这行
    
    finally:
        # ④ 停止 Inbox Poller
        stop_inbox_poller()
    
    print("\nLead Agent stopped")
```

### 3.3 关键改进点

**对比原版 vs 改进版**：

```python
# ── 原版（教学版） ──
if __name__ == "__main__":
    while True:
        query = input("s16 >> ")
        history.append({"role": "user", "content": query})
        agent_loop(history, context)
        
        # ← 手动检查 inbox（串行）
        inbox_msgs = consume_lead_inbox(route_protocol=True)
        if inbox_msgs:
            history.append({"role": "user",
                            "content": f"[Inbox]\n..."})
        # ← inbox 消息要等下次用户输入才发给 LLM

# ── 改进版（inbox poller） ──
if __name__ == "__main__":
    # ← 启动后台线程（并行）
    start_inbox_poller()
    
    while True:
        query = input("s16 >> ")
        history.append({"role": "user", "content": query})
        agent_loop(history, context)
        
        # ← 不需要手动检查！inbox poller 自动处理
        # inbox 消息会立即发给 LLM（最多1秒延迟）
    
    stop_inbox_poller()
```

---

## 四、关键设计细节

### 4.1 线程安全（Mutex）

**问题**：主线程和 inbox poller 同时访问 `history`

**解决方案**：使用 Mutex（互斥锁）

```typescript
// TypeScript
import { Mutex } from 'async-mutex'

const historyMutex = new Mutex()

export async function addToHistory(content: any) {
  const release = await historyMutex.acquire()
  try {
    history.push(content)
  } finally {
    release()
  }
}
```

```python
# Python
import threading

history = []
history_lock = threading.Lock()

def add_to_history(content):
    with history_lock:
        history.append(content)
```

### 4.2 轮询间隔选择

**权衡**：
- 间隔太短（如100ms）：频繁轮询，浪费资源
- 间隔太长（如5秒）：响应延迟太高
- **最优：1秒**（平衡性能和响应）

```typescript
const POLL_INTERVAL = 1000  // 1秒（最优）
```

### 4.3 错误处理

**关键**：inbox poller 不能因为错误停止

```typescript
pollerId = setInterval(async () => {
  try {
    await pollAndProcessInbox()
  } catch (error) {
    console.error('[inboxPoller] Error:', error)
    // ← 不停止，继续轮询
  }
}, POLL_INTERVAL)
```

### 4.4 消息优先级

**协议消息优先处理**：

```typescript
// ① 先路由协议响应（shutdown_response, plan_approval_response）
for (const msg of messages) {
  if (msg.metadata?.request_id && msg.type.endsWith('_response')) {
    await matchResponse(msg.type, msg.metadata.request_id, msg.metadata.approve)
  }
}

// ② 再提交新 turn
await submitNewTurn({ ... })
```

### 4.5 防止无限循环

**问题**：inbox 消息可能触发 Lead 发送新消息 → 循环

**解决方案**：
- 使用 request_id 标记协议响应
- 普通消息不触发新消息（除非必要）
- 添加消息计数器（限制循环次数）

```typescript
// 防止无限循环的设计
const MAX_INBOX_PROCESSING = 10  // 每轮最多处理10条消息

async function pollAndProcessInbox() {
  const messages = await readInbox('lead')
  
  if (messages.length > MAX_INBOX_PROCESSING) {
    console.warn('[inboxPoller] Too many messages, truncating')
    messages = messages.slice(0, MAX_INBOX_PROCESSING)
  }
  
  // ...
}
```

---

## 五、与其他组件的交互

### 5.1 与 teammate 的交互

```
Teammate 完成任务 → BUS.send("alice", "lead", "Bug fixed", "result")
↓
Lead inbox: {"from": "alice", "content": "Bug fixed", "type": "result"}
↓
Inbox Poller（1秒后）→ 发现消息
↓
submitNewTurn → Lead LLM 看到 "Bug fixed"
↓
Lead 处理 → 决定下一步
```

### 5.2 与用户输入的交互

```
用户输入 "检查进度" → 主线程处理
↓
（同时）
Inbox Poller 发现 alice 的消息 → submitNewTurn
↓
Lead LLM 看到：
  - 用户输入 "检查进度"
  - alice 的消息 "Bug fixed"
↓
Lead 综合处理 → 回复用户
```

### 5.3 与协议的交互

```
Lead 发送 shutdown_request → alice inbox
↓
alice 处理 → BUS.send("alice", "lead", ..., "shutdown_response")
↓
Lead inbox: {"type": "shutdown_response", "metadata": {"request_id": "..."}}
↓
Inbox Poller → 发现 shutdown_response
↓
match_response → 更新 pending_requests 状态
↓
（可选）submitNewTurn → Lead LLM 看到 shutdown 已批准
```

### 5.4 与后台任务的交互

```
Lead 启动后台任务 → bg_0001
↓
后台任务完成 → task_notification
↓
（后台任务通知会直接注入 history，不经过 inbox）
↓
主线程下次调用 LLM → 看到 task_notification
```

**注意**：后台任务通知**不经过 inbox poller**，因为它们已经是异步处理的。

---

## 六、常见问题和解决方案

### 6.1 问题①：inbox poller 与主线程冲突

**场景**：inbox poller 和主线程同时调用 LLM

```typescript
T0: 用户输入 → 主线程开始 agent_loop
T1: Inbox Poller 发现消息 → submitNewTurn
T2: 主线程还在 agent_loop
T3: submitNewTurn 开始调用 LLM
→ 两个 LLM 调用同时进行！
```

**解决方案①：状态检查**

```typescript
let isProcessingUserInput = false

async function handleUserInput(input) {
  isProcessingUserInput = true
  await agentLoop()
  isProcessingUserInput = false
}

async function pollAndProcessInbox() {
  if (isProcessingUserInput) {
    return  // ← 主线程正在处理，inbox poller 暂停
  }
  
  const messages = await readInbox('lead')
  if (messages.length > 0) {
    await submitNewTurn(...)
  }
}
```

**解决方案②：消息队列**

```typescript
const pendingInboxMessages = []

async function pollAndProcessInbox() {
  const messages = await readInbox('lead')
  pendingInboxMessages.push(...messages)
}

async function afterAgentLoop() {
  if (pendingInboxMessages.length > 0) {
    const messages = pendingInboxMessages.splice(0)
    await submitNewTurn(...)
  }
}
```

### 6.2 问题②：成本控制

**场景**：inbox 消息频繁，成本不可控

```typescript
// 问题：1分钟内收到100条消息 → 100次LLM调用
```

**解决方案①：消息聚合**

```typescript
async function pollAndProcessInbox() {
  const messages = await readInbox('lead')
  
  if (messages.length > 5) {
    // ← 聚合多条消息为一条
    const aggregated = messages.map(m => `From ${m.from}: ${m.content}`).join('\n')
    await submitNewTurn({
      role: 'user',
      content: `[Inbox - ${messages.length} messages]\n${aggregated}`
    })
  } else {
    // ← 少量消息，逐条处理
    for (const msg of messages) {
      await submitNewTurn(...)
    }
  }
}
```

**解决方案②：成本限制**

```typescript
let llmCallsThisMinute = 0
const MAX_LLM_CALLS_PER_MINUTE = 10

async function submitNewTurn(content) {
  if (llmCallsThisMinute >= MAX_LLM_CALLS_PER_MINUTE) {
    console.warn('[submitNewTurn] Rate limit exceeded')
    return
  }
  
  llmCallsThisMinute++
  await callLeadLLM()
}

// 每分钟重置计数器
setInterval(() => {
  llmCallsThisMinute = 0
}, 60000)
```

### 6.3 问题③：消息顺序混乱

**场景**：inbox poller 和用户输入的消息顺序不一致

```typescript
T0: 用户输入 "任务A"
T1: Inbox Poller 发现 alice 的消息 "任务A完成"
T2: submitNewTurn → history: [用户输入, alice消息]
T3: 但实际顺序应该是：[alice消息, 用户输入]
```

**解决方案：时间戳排序**

```typescript
function addToHistoryWithTimestamp(content) {
  const timestampedContent = {
    ...content,
    timestamp: Date.now()
  }
  
  addToHistory(timestampedContent)
  
  // 按时间戳排序
  sortHistoryByTimestamp()
}
```

### 6.4 问题④：inbox poller 内存泄漏

**场景**：inbox poller 线程永不退出

```typescript
// 问题：程序退出时，inbox poller 还在运行
```

**解决方案：优雅停止**

```typescript
let pollerId = null

export function startInboxPoller() {
  pollerId = setInterval(...)
}

export function stopInboxPoller() {
  if (pollerId) {
    clearInterval(pollerId)
    pollerId = null
  }
}

// 程序退出时自动停止
process.on('exit', () => {
  stopInboxPoller()
})
```

---

## 七、总结

### 7.1 Inbox Poller 的核心价值

```
传统方式（教学版）：
- 响应延迟高（等待用户输入）
- 用户体验差（需输入两次才看到结果）
- 成本可控（用户触发）

Inbox Poller（真实CC）：
- 响应速度快（最多1秒延迟）
- 用户体验好（实时更新）
- 成本需控制（自动触发）
```

### 7.2 关键实现要点

```
① 独立后台线程
   - setInterval (TypeScript)
   - threading.Thread (Python)

② 线程安全
   - Mutex (TypeScript)
   - threading.Lock (Python)

③ submitNewTurn
   - 注入 history
   - 立即调用 LLM

④ 错误处理
   - 不停止轮询
   - 记录错误

⑤ 成本控制
   - 消息聚合
   - 速率限制
```

### 7.3 适用场景

```
适合使用 inbox poller：
- 生产环境（需要实时响应）
- 多 teammate 并发工作
- 长时间运行的 Agent
- 用户期望实时反馈

不适合使用 inbox poller：
- 教学演示（优先简单）
- 成本敏感场景
- 单 teammate 简单任务
- 短时间运行
```

---

## 附录：完整代码示例

### A. TypeScript 完整实现（生产级）

见上文第二章。

### B. Python 完整实现（教学改进）

见上文第三章。

### C. 测试示例

```python
# 测试 inbox poller

from inbox_poller import start_inbox_poller, stop_inbox_poller
from message_bus import BUS
import time

# 启动 inbox poller
start_inbox_poller()

# 模拟 teammate 发送消息
BUS.send("alice", "lead", "Task 1 completed", "result")
BUS.send("alice", "lead", "Task 2 completed", "result")

# 等待 inbox poller 处理（最多1秒）
time.sleep(2)

# 检查 history
print(f"History length: {len(history)}")
# 应该看到 inbox 消息已注入

# 停止 inbox poller
stop_inbox_poller()
```

---

## 参考资料

- [s16 Team Protocols 主文档](./README_ME.md)
- [stop_reason 和 inbox 处理分析](./stop_reason_analysis.md)
- [循环结构分析](./cycle_analysis.md)
- [Node.js setInterval 文档](https://nodejs.org/api/timers.html)
- [Python threading 文档](https://docs.python.org/3/library/threading.html)
# s13 Agent Loop 执行流程深度分析

## 用户场景：npm install + read package.json

### 问题：会死循环吗？

```python
def agent_loop(messages: list, context: dict):
    while True:
        response = client.messages.create(...)  # 调用 LLM
        
        if response.stop_reason != "tool_use":
            return  # ← 关键！如果 LLM 不继续工作，就返回
        
        # 执行工具...
        # npm install 后台
        # read_file 同步
        
        # 组成 user message
        messages.append({"role": "user", "content": user_content})
        
        # 继续 while True...
```

**核心问题**：
- npm install 3分钟，还在运行
- agent_loop 会一直调用 LLM 吗？
- 会死循环吗？

---

## 答案：不会死循环！关键在 stop_reason

### Turn 1：LLM 生成两个 tool_use

```
用户输入："npm install 并读取 package.json"

LLM 思考：
  "好的，我会后台运行 npm install，同时读配置文件"
  
LLM 输出：
  [
    {"type": "tool_use", "id": "tool_001", "name": "bash",
     "input": {"command": "npm install", "run_in_background": true}},
    {"type": "tool_use", "id": "tool_002", "name": "read_file",
     "input": {"path": "package.json"}}
  ]
  
stop_reason: "tool_use"  ← LLM 要继续工作！
```

### Agent Loop 处理 Turn 1

```python
while True:
    response = client.messages.create(...)
    
    # stop_reason == "tool_use"，继续执行工具
    
    messages.append({"role": "assistant", "content": response.content})
    
    # 执行工具
    results = []
    for block in response.content:
        if block.type != "tool_use":
            continue
        
        # 第一个：bash "npm install"
        if should_run_background(block.name, block.input):
            bg_id = start_background_task(block)  # 启动后台任务
            results.append({
                "type": "tool_result",
                "tool_use_id": "tool_001",
                "content": "[Background task bg_0001 started]"
            })
        
        # 第二个：read_file "package.json"
        else:
            output = execute_tool(block)  # 同步执行
            results.append({
                "type": "tool_result",
                "tool_use_id": "tool_002",
                "content": "{...package.json content...}"
            })
    
    # 收集后台通知（此时 bg_0001 还在运行，没有通知）
    bg_notifications = collect_background_results()  # 返回 []
    
    # 组成 user message
    user_content = [
        {"type": "tool_result", "tool_use_id": "tool_001",
         "content": "[Background task bg_0001 started]"},
        {"type": "tool_result", "tool_use_id": "tool_002",
         "content": "{...package.json content...}"}
    ]
    
    messages.append({"role": "user", "content": user_content})
    
    # 继续 while True...
```

### Turn 2：LLM 收到占位 + 文件内容

```
messages 此时包含：
[
    {"role": "user", "content": "npm install 并读取 package.json"},
    {"role": "assistant", "content": [tool_use(tool_001), tool_use(tool_002)]},
    {"role": "user", "content": [
        tool_result(tool_001, "占位：bg_0001 已启动"),
        tool_result(tool_002, "package.json 内容")
    ]}
]

再次调用 client.messages.create(messages)

LLM 思考：
  "好的，我看到配置文件内容了..."
  "npm install 正在后台运行，我先分析一下配置..."
  
LLM 输出：
  [
    {"type": "text", "text": "我看到 package.json 里..."}
  ]
  
stop_reason: "end_turn"  ← LLM 不需要继续工作！
```

### Agent Loop 处理 Turn 2

```python
while True:
    response = client.messages.create(...)
    
    messages.append({"role": "assistant", "content": response.content})
    
    # 关键检查！
    if response.stop_reason != "tool_use":  # stop_reason == "end_turn"
        return  # ← 直接返回！不继续循环
    
    # 如果 stop_reason == "tool_use"，才会继续
    # 但这里是 "end_turn"，所以退出 agent_loop
```

### 主程序继续等待用户输入

```python
if __name__ == "__main__":
    history = []
    context = update_context({}, [])
    
    while True:  # ← 主循环，等待用户输入
        query = input("s13 >> ")
        if query.strip().lower() in ("q", "exit", ""):
            break
        
        history.append({"role": "user", "content": query})
        agent_loop(history, context)  # ← 可能已经返回
        context = update_context(context, history)
        
        # 打印 LLM 的最后回复
        for block in history[-1]["content"]:
            if getattr(block, "type", None) == "text":
                print(block.text)
        
        print()
        # 等待用户下一次输入...
```

---

## npm install 完成后，通知何时注入？

### 时间线：

```
T=0s: 用户输入 "npm install 并读取 package.json"
  → Turn 1: LLM 生成两个 tool_use
  → Agent Loop: 启动 bg_0001，同步执行 read_file
  → Turn 2: LLM 说 "看到配置文件了..."
  → Agent Loop 返回（stop_reason == "end_turn")
  
T=0s~3min: Agent Loop 已退出，主程序等待用户输入
  → 后台线程还在运行 npm install
  
T=3min: npm install 完成
  → worker thread 完成
  → background_tasks[bg_0001]["status"] = "completed"
  → background_results[bg_0001] = "added 1423 packages"
  
T=3min+ε: 用户输入新 prompt（如"npm install 完成了吗？")
  → 主循环再次调用 agent_loop
  → 收集后台通知
  → 注入到 messages
```

### 教学版的缺陷：

```
问题：通知不会自动注入，必须等用户下一次输入

T=0s:
  - Agent Loop 返回
  - messages 里没有 bg_0001 的通知
  
T=3min:
  - bg_0001 完成
  - background_tasks 里状态变成 "completed"
  - 但消息历史里还没有通知！
  
T=3min+ε:
  - 用户输入新 prompt
  - agent_loop 再次启动
  - collect_background_results() 才会收集
  - 才注入到 messages
```

---

## 死循环的误解

### ❌ 错误理解

```
错误理解：
  while True:
      response = client.messages.create(...)
      # 如果 npm install 还没完成
      # 就一直循环调用 LLM
      
纠正：
  - stop_reason != "tool_use" 时，agent_loop 直接返回
  - LLM 不需要继续工作，就退出循环
  - 主程序等待用户下一次输入
```

### ✅ 正确理解

```
Turn 1:
  LLM 生成 tool_use → stop_reason == "tool_use"
  Agent Loop 执行工具（npm install 后台，read_file 同步）
  
Turn 2:
  LLM 收到占位 + 文件内容
  LLM 可能说"看到配置了..."
  stop_reason == "end_turn"
  Agent Loop 返回
  
主程序：
  等待用户下一次输入
  
下次输入时：
  collect_background_results() 可能收集到通知
  （如果 npm install 已完成）
```

---

## 生产版的差异：通知自动注入

### 教学版的问题

```python
# 教学版：通知在下次 agent_loop 时才收集
def agent_loop(messages, context):
    while True:
        # ...
        bg_notifications = collect_background_results()  # 同步收集
        # 必须等用户下一次输入才会调用 agent_loop
```

**缺陷**：
- 用户必须在 npm install 完成后主动输入
- 才能看到通知
- 不主动，通知一直在 background_results 里等待

### 生产版的改进：事件驱动

```typescript
// 生产版：后台完成立即入队
process.on('exit', (code) => {
    // npm install 完成时，立即入队通知
    messageQueueManager.enqueuePendingNotification({
        priority: "later",
        content: "<task_notification>bg_0001 完成</task_notification>"
    })
    
    // 触发新一轮 turn（自动，不需要用户输入）
    triggerNextTurn()
})

// 自动消费队列
async function processNextTurn() {
    const notifications = messageQueueManager.consumeNotifications()
    
    if (notifications.length > 0) {
        messages.push({
            role: "user",
            content: notifications
        })
        
        // 自动调用 LLM（不需要用户输入）
        const response = await anthropic.messages.create(...)
    }
}
```

**优势**：
- npm install 完成 → 立即入队
- 自动触发新一轮 turn
- 不需要用户主动输入
- LLM 自动收到通知

---

## 对比：教学版 vs 生产版

| 维度 | 教学版 | 生产版 |
|------|--------|--------|
| **Agent Loop 退出条件** | stop_reason != "tool_use" | 同 |
| **通知收集时机** | 下次 agent_loop | 后台完成立即入队 |
| **通知注入** | 用户必须主动输入 | 自动触发 turn |
| **等待行为** | 主程序等待用户输入 | 自动消费队列 |
| **实时性** | 低（等用户） | 高（自动） |
| **用户体验** | 必须主动查询 | 自动收到通知 |

---

## 实战演示：教学版的实际行为

### 场景 1：npm install 很快完成（5秒）

```
T=0s: 用户输入 "npm install 并读取 package.json"
  → Turn 1: 启动 bg_0001，读 package.json
  → Turn 2: LLM 说"看到配置了..."
  → Agent Loop 返回
  
T=5s: npm install 完成（Agent Loop 已退出）
  → background_tasks[bg_0001]["status"] = "completed"
  
T=5s+ε: 用户输入 "继续"
  → agent_loop 再次启动
  → collect_background_results() 收集通知
  → Turn 3: LLM 收到 bg_0001 完成的通知
  → LLM: "npm install 也完成了，我继续..."
```

### 场景 2：npm install 很慢（3分钟）

```
T=0s: 用户输入
  → Turn 1: 启动 bg_0001，读 package.json
  → Turn 2: LLM 说"看到配置了..."
  → Agent Loop 返回
  
T=0s~3min: 主程序等待用户输入
  → 用户可能做别的事
  → 或者输入新 prompt
  
T=180s: npm install 完成
  → background_tasks 更新
  
T=180s+ε: 用户输入 "npm install 完成了吗？"
  → agent_loop 再次启动
  → 收集通知
  → LLM: "是的，已完成..."
```

---

## LLM 如何判断是否继续工作？

### stop_reason 的含义

```
Anthropic Messages API 的 stop_reason：

"tool_use":
  - LLM 生成了 tool_use
  - 需要等待工具执行结果
  - Agent Loop 继续执行工具
  
"end_turn":
  - LLM 认为当前任务完成
  - 不需要继续工作
  - Agent Loop 返回
  
"max_tokens":
  - 达到 token 限制
  - Agent Loop 返回
  
"stop_sequence":
  - 遇到自定义停止序列
  - Agent Loop 返回
```

### LLM 的决策逻辑

```
Turn 1:
  用户："npm install 并读取 package.json"
  
  LLM 思考：
    "我需要调用 bash 和 read_file"
    "调用完成后，还需要继续工作吗？"
    
  LLM 决策：
    "是的，我需要分析 package.json 内容"
    "所以我先调用工具，然后继续"
    
  stop_reason: "tool_use"

Turn 2:
  LLM 收到：占位 + package.json 内容
  
  LLM 思考：
    "我看到配置文件了"
    "npm install 正在后台运行"
    "我现在分析配置..."
    "还需要继续工作吗？"
    
  LLM 决策：
    "暂时不需要，我已经分析了配置"
    "等 npm install 完成，我可能需要做后续工作"
    "但现在可以先暂停"
    
  stop_reason: "end_turn"
```

---

## 核心要点总结

### 1. Agent Loop 不会死循环
- ✅ stop_reason != "tool_use" 时立即返回
- ✅ LLM 不需要继续工作，就退出循环
- ✅ 主程序等待用户下一次输入

### 2. 通知延迟注入
- ❌ 教学版：通知在下次 agent_loop 时才收集
- ✅ 生产版：后台完成立即入队，自动触发 turn

### 3. LLM 智能决策
- LLM 根据 stop_reason 决定是否继续工作
- 如果暂时不需要工作，就返回（end_turn）
- 等用户下一次输入或后台通知

### 4. 用户视角
- 教学版：必须主动查询后台任务状态
- 生产版：自动收到后台任务完成通知

---

## 改进建议：教学版如何更实时？

### 方案 1：轮询等待（不推荐）

```python
def agent_loop(messages, context):
    while True:
        response = client.messages.create(...)
        
        if response.stop_reason != "tool_use":
            # 等待所有后台任务完成
            while background_tasks:
                time.sleep(1)  # 每秒检查
                bg_notifications = collect_background_results()
                if bg_notifications:
                    messages.append({"role": "user", "content": bg_notifications})
                    response = client.messages.create(...)
            return
```

**缺点**：
- 阻塞主程序
- 用户无法输入新 prompt
- 浪费时间

### 方案 2：超时机制（推荐）

```python
def agent_loop(messages, context):
    while True:
        response = client.messages.create(...)
        
        if response.stop_reason != "tool_use":
            # 收集后台通知（如果有）
            bg_notifications = collect_background_results()
            if bg_notifications:
                messages.append({"role": "user", "content": bg_notifications})
                # 再次调用 LLM（自动处理通知）
                response = client.messages.create(...)
                messages.append({"role": "assistant", "content": response.content})
            return  # 最终返回
```

**优点**：
- 如果后台任务刚好完成，立即注入
- 不阻塞主程序
- 代码简单

### 方案 3：事件驱动（生产版）

```typescript
// Node.js 的事件驱动
process.on('exit', () => {
    enqueueNotification()
    triggerNextTurn()  // 自动触发新一轮
})
```

---

## 最终答案

### 你的担心是对的，但不会死循环

**原因**：
1. Agent Loop 根据 stop_reason 决定是否继续
2. LLM 不需要继续工作时，直接返回（end_turn）
3. 主程序等待用户下一次输入

**教学版的缺陷**：
- 通知不会自动注入
- 必须等用户下一次输入才能看到

**生产版的改进**：
- 后台完成立即入队
- 自动触发新一轮 turn
- 实时通知

---

## 实战验证：运行代码观察

```bash
cd learn-claude-code
python s13_background_tasks/code.py

# 场景 1：npm install 快
s13 >> npm install 并读取 package.json

观察：
  Turn 1: 启动 bg_0001，读 package.json
  Turn 2: LLM 说"看到配置了..."
  （Agent Loop 返回）
  
等待 5 秒，npm install 完成

再次输入：
s13 >> 继续

观察：
  Turn 3: 收集 bg_0001 通知
  LLM: "npm install 也完成了"

# 场景 2：npm install 慢
s13 >> npm install 并读取 package.json

等待 3 分钟...

再次输入：
s13 >> npm install 完成了吗？

观察：
  收集 bg_0001 通知
  LLM: "是的，已完成"
```

---

## 总结

**不会死循环**：
- Agent Loop 智能退出（stop_reason != "tool_use")
- LLM 决定是否继续工作

**通知延迟**：
- 教学版：下次 agent_loop 才收集
- 生产版：自动触发 turn

**用户体验**：
- 教学版：主动查询
- 生产版：自动通知
# s16 spawn_teammate_thread 循环深度解析

> 本文档详细拆解 spawn_teammate_thread 的多层循环结构和 consume_lead_inbox 的执行时机

---

## 目录

1. [spawn_teammate_thread 的三层循环结构](#一spawn_teammate_thread-的三层循环结构)
2. [consume_lead_inbox 的执行时机](#二consume_lead_inbox-的执行时机)
3. [完整执行流程图](#三完整执行流程图)
4. [常见误解澄清](#四常见误解澄清)
5. [代码逐行解析](#五代码逐行解析)

---

## 一、spawn_teammate_thread 的三层循环结构

### 1.1 循环层级总览

```python
def run():
    shutdown_requested = False
    
    # ★ 第1层循环：外层主循环（持久运行）
    while not shutdown_requested:  # ← 第513行
        # ① 检查收件箱（处理协议消息）
        inbox = BUS.read_inbox(name)
        ...
        
        # ② LLM 调用
        response = client.messages.create(...)
        
        # ③ 如果 LLM 不再调用工具
        if response.stop_reason != "tool_use":
            # ★ 第2层循环：IDLE 等待循环（等待新消息）
            while not shutdown_requested:  # ← 第545行
                time.sleep(1)
                inbox = BUS.read_inbox(name)
                ...
                if inbox:
                    # 有新消息 → break → 回到第1层循环
                    break
        
        # ④ 执行工具调用
        for block in response.content:
            ...
```

**关键理解**：
- **第1层循环**：控制 teammate 的整体生命周期（持久运行）
- **第2层循环**：控制 IDLE 状态（等待新任务）
- **没有第3层循环**：工具执行只是顺序处理，不是循环

### 1.2 循环层级图解

```
┌────────────────────────────────────────────────────────────┐
│            第1层循环：while not shutdown_requested          │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  ① 检查收件箱（处理协议消息）                         │  │
│  │    - shutdown_request → 返回 True → 结束             │  │
│  │    - plan_approval_response → 注入 messages          │  │
│  │    - 普通消息 → 注入 messages                         │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  ② LLM 调用                                          │  │
│  │    response = client.messages.create(...)            │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  ③ 检查 stop_reason                                  │  │
│  │    if response.stop_reason != "tool_use":           │  │
│  │       → 进入第2层循环（IDLE 等待）                    │  │
│  └──────────────────────────────────────────────────────┘  │
│  │                                                          │  │
│  │  ┌──────────────────────────────────────────────────┐  │  │
│  │  │   第2层循环：IDLE 等待                            │  │  │
│  │  │   while not shutdown_requested:                  │  │  │
│  │  │     time.sleep(1)  ← 每1秒轮询一次               │  │  │
│  │  │     inbox = BUS.read_inbox(name)                 │  │  │
│  │  │     if inbox:                                    │  │  │
│  │  │       - 处理协议消息                             │  │  │
│  │  │       - 注入普通消息                             │  │  │
│  │  │       - break → 回到第1层循环                    │  │  │
│  │  └──────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  ④ 执行工具调用（顺序处理，不是循环）                 │  │
│  │    for block in response.content:                    │  │
│  │      if block.type == "tool_use":                   │  │
│  │        execute_tool(block)                           │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  → 继续第1层循环（下一轮 LLM 调用）                        │
└────────────────────────────────────────────────────────────┘
```

### 1.3 循环之间的转换关系

```
状态转换图：

┌───────────┐
│  启动     │
└───────────┘
      │
      ▼
┌───────────────────────────────────────┐
│  第1层循环：WORK 状态                 │
│  - 检查收件箱                         │
│  - LLM 调用                           │
│  - 执行工具                           │
└───────────────────────────────────────┘
      │
      │ stop_reason != "tool_use"
      ▼
┌───────────────────────────────────────┐
│  第2层循环：IDLE 状态                 │
│  - 每1秒轮询收件箱                    │
│  - 等待新消息                         │
└───────────────────────────────────────┘
      │
      │ 有新消息 OR shutdown_request
      ▼
  ┌───┴───┐
  │       │
  ▼       ▼
回到第1层  结束线程
循环
```

---

## 二、consume_lead_inbox 的执行时机

### 2.1 consume_lead_inbox 的定义

从代码第420-435行：

```python
def consume_lead_inbox(route_protocol: bool = True) -> list[dict]:
    """Read Lead's inbox. Route protocol responses, return all messages.
    Called by both run_check_inbox() and main loop to avoid
    messages being consumed without protocol routing."""
    msgs = BUS.read_inbox("lead")
    if not msgs:
        return []
    if route_protocol:
        for msg in msgs:
            meta = msg.get("metadata", {})
            req_id = meta.get("request_id", "")
            msg_type = msg.get("type", "")
            if req_id and msg_type.endswith("_response"):
                approve = meta.get("approve", False)
                match_response(msg_type, req_id, approve)
    return msgs
```

**核心功能**：
- 读取 Lead 的收件箱
- 自动路由协议响应（shutdown_response、plan_approval_response）
- 返回所有消息

### 2.2 consume_lead_inbox 的两次调用时机

#### 调用时机①：Lead 使用 check_inbox 工具

```python
# 第668-679行
def run_check_inbox() -> str:
    """Check Lead's inbox. Routes protocol responses via match_response."""
    msgs = consume_lead_inbox(route_protocol=True)  # ← 调用！
    if not msgs:
        return "(inbox empty)"
    lines = []
    for m in msgs:
        ...
    return "\n".join(lines)
```

**触发条件**：
- Lead 的 LLM 决定调用 `check_inbox` 工具
- 主动检查收件箱

**执行流程**：
```
用户输入 → Lead LLM 思考 → 调用 check_inbox 工具
→ execute_tool → run_check_inbox → consume_lead_inbox
→ 返回收件箱消息 → Lead LLM 看到 → 继续处理
```

#### 调用时机②：主循环结束后自动检查

```python
# 第853-880行（主程序）
if __name__ == "__main__":
    history = []
    context = update_context({}, [])
    while True:
        query = input("s16 >> ")  # ← 用户输入
        history.append({"role": "user", "content": query})
        agent_loop(history, context)  # ← Lead 主循环
        
        # ★ 主循环结束后，自动检查收件箱
        inbox_msgs = consume_lead_inbox(route_protocol=True)  # ← 调用！
        if inbox_msgs:
            inbox_text = "\n".join(...)
            history.append({"role": "user",
                            "content": f"[Inbox]\n{inbox_text}"})
```

**触发条件**：
- Lead 主循环结束（LLM 不再调用工具）
- **等待用户下次输入之前**（但不是"用户再次输入时"）

**执行流程**：
```
用户输入 → Lead LLM 处理 → 主循环结束
→ consume_lead_inbox ← 自动检查！
→ 如果有消息 → 注入 history
→ 等待用户下次输入
```

### 2.3 两个调用时机的差异

| 维度 | 调用时机①（check_inbox工具） | 调用时机②（主循环结束） |
|------|---------------------------|---------------------|
| **触发者** | Lead 的 LLM 决定 | **系统自动** |
| **时机** | Lead 处理过程中 | Lead 处理完成后 |
| **是否需要用户输入** | 不需要（LLM主动） | **不需要**（自动执行） |
| **结果处理** | 作为工具结果返回 | 注入到 history |
| **频率** | LLM 需要时才调用 | 每次主循环结束都调用 |

### 2.4 用户误解澄清

#### ❌ 错误理解
> "consume_lead_inbox 要每次用户再次输入内容才会触发执行吗？"

#### ✅ 正确理解
> "consume_lead_inbox 在主循环结束后**立即自动执行**，不需要等待用户下次输入。但如果有消息，会在**等待用户下次输入之前**注入到 history，这样用户下次输入时，Lead 能看到这些消息。"

---

## 三、完整执行流程图

### 3.1 Lead Agent 的执行流程

```
┌────────────────────────────────────────────────────────────┐
│                    Lead Agent 主循环                        │
│                                                            │
│  用户输入 "s16 >> "                                         │
│      │                                                     │
│      ▼                                                     │
│  history.append({"role": "user", "content": query})       │
│      │                                                     │
│      ▼                                                     │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  agent_loop(history, context)                        │ │
│  │                                                      │ │
│  │  while True:                                         │ │
│  │    response = client.messages.create(...)           │ │
│  │    history.append(response)                          │ │
│  │    if response.stop_reason != "tool_use":           │ │
│  │      return  ← 主循环结束                             │ │
│  │    for block in response.content:                    │ │
│  │      execute_tool(block)                             │ │
│  │      if block.name == "check_inbox":                │ │
│  │        → consume_lead_inbox ← 调用时机①             │ │
│  │      ... 其他工具 ...                                │ │
│  │    history.append(tool_results)                      │ │
│  │    → 继续循环                                         │ │
│  └──────────────────────────────────────────────────────┘ │
│      │                                                     │
│      ▼                                                     │
│  ★ 主循环结束后                                            │
│  inbox_msgs = consume_lead_inbox(route_protocol=True)     │
│      │                                                     │
│      │ if inbox_msgs:                                      │
│      ▼                                                     │
│  history.append({"role": "user",                          │
│                   "content": "[Inbox]\n{inbox_text}"})    │
│      │                                                     │
│      ▼                                                     │
│  print("[Inbox: {len(inbox_msgs)} messages injected]")    │
│      │                                                     │
│      ▼                                                     │
│  → 等待用户下次输入                                         │
│                                                            │
│  用户下次输入 "s16 >> "                                     │
│      │                                                     │
│      ▼                                                     │
│  history.append({"role": "user", "content": new_query})   │
│      │                                                     │
│      ▼                                                     │
│  Lead LLM 看到：                                           │
│    - 上次注入的 Inbox 消息 ← 能看到！                      │
│    - 新的用户输入                                          │
│    → 一起处理                                              │
└────────────────────────────────────────────────────────────┘
```

### 3.2 Teammate 的执行流程

```
┌────────────────────────────────────────────────────────────┐
│                 Teammate 线程                              │
│                                                            │
│  spawn_teammate_thread("alice", "backend", "任务A")        │
│      │                                                     │
│      ▼                                                     │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  第1层循环：while not shutdown_requested              │ │
│  │                                                      │ │
│  │  ① 检查收件箱                                         │ │
│  │    inbox = BUS.read_inbox(name)                      │ │
│  │    for msg in inbox:                                 │ │
│  │      if msg.type == "shutdown_request":              │ │
│  │        → 发送 shutdown_response                       │ │
│  │        → shutdown_requested = True                   │ │
│  │        → break（结束第1层循环）                       │ │
│  │      if msg.type == "plan_approval_response":        │ │
│  │        → 注入 messages                               │ │
│  │      if 普通消息:                                     │ │
│  │        → 注入 messages                               │ │
│  │                                                      │ │
│  │  ② LLM 调用                                           │ │
│  │    response = client.messages.create(...)            │ │
│  │    messages.append(response)                          │ │
│  │                                                      │ │
│  │  ③ 检查 stop_reason                                  │ │
│  │    if response.stop_reason != "tool_use":           │ │
│  │      → 进入第2层循环（IDLE 等待）                     │ │
│  │    else:                                              │ │
│  │      → 执行工具调用 → 继续第1层循环                   │ │
│  │                                                      │ │
│  │  ┌──────────────────────────────────────────────────┐│ │
│  │  │  第2层循环：IDLE 等待                            ││ │
│  │  │                                                  ││ │
│  │  │  while not shutdown_requested:                  ││ │
│  │  │    time.sleep(1)  ← 每1秒轮询一次               ││ │
│  │  │    inbox = BUS.read_inbox(name)                 ││ │
│  │  │    if not inbox:                                ││ │
│  │  │      continue  ← 继续等待                        ││ │
│  │  │    for msg in inbox:                            ││ │
│  │  │      if msg.type == "shutdown_request":         ││ │
│  │  │        → 发送 shutdown_response                  ││ │
│  │  │        → shutdown_requested = True              ││ │
│  │  │        → break（结束第2层循环）                  ││ │
│  │  │      if 普通消息:                                ││ │
│  │  │        → 注入 messages                           ││ │
│  │  │    if shutdown_requested:                       ││ │
│  │  │      break（结束第2层循环）                      ││ │
│  │  │    if 有普通消息:                                ││ │
│  │  │      break（结束第2层循环，回到第1层）           ││ │
│  │  └──────────────────────────────────────────────────┘│ │
│  │                                                      │ │
│  │  ④ 执行工具调用（如果 LLM 调用了工具）               │ │
│  │    for block in response.content:                    │ │
│  │      execute_tool(block)                             │ │
│  │    messages.append(tool_results)                     │ │
│  │                                                      │ │
│  │  → 继续第1层循环                                      │ │
│  └──────────────────────────────────────────────────────┘ │
│      │                                                     │
│      │ shutdown_requested == True                          │
│      ▼                                                     │
│  发送最终总结给 Lead                                       │
│  BUS.send(name, "lead", summary, "result")                 │
│  active_teammates.pop(name, None)                          │
│  → 线程结束                                                │
└────────────────────────────────────────────────────────────┘
```

---

## 四、常见误解澄清

### 4.1 误解①：三层循环？

**误解**：
> "spawn_teammate_thread 有三层循环，第一层检查收件箱，第二层LLM调用，第三层工具执行"

**真相**：
- ✅ **只有两层循环**
- ❌ 工具执行不是循环，只是顺序处理（for loop）

**正确理解**：
```
第1层循环：整体生命周期（持久运行）
第2层循环：IDLE 状态（等待新消息）
工具执行：顺序处理（不是循环）
```

### 4.2 误解②：IDLE循环一直等待？

**误解**：
> "IDLE 循环会一直等待，直到用户再次输入才会唤醒"

**真相**：
- ✅ IDLE 循环**每1秒主动轮询**收件箱
- ❌ 不依赖用户输入
- ✅ 收件箱有消息就**立即唤醒**

**正确理解**：
```
IDLE 循环：
while True:
    time.sleep(1)  ← 主动轮询（不等待用户）
    inbox = BUS.read_inbox(name)
    if inbox:
        break  ← 有消息立即唤醒
```

### 4.3 误解③：consume_lead_inbox 需要用户输入触发？

**误解**：
> "consume_lead_inbox 要每次用户再次输入内容才会触发执行"

**真相**：
- ✅ consume_lead_inbox 在主循环结束后**立即自动执行**
- ❌ 不需要等待用户下次输入
- ✅ 消息注入发生在**等待用户下次输入之前**

**正确理解**：
```
主循环结束 → consume_lead_inbox（立即执行）
→ 如果有消息 → 注入 history
→ 等待用户下次输入
→ 用户下次输入时，Lead 能看到已注入的消息
```

### 4.4 误解④：第2层循环会阻塞第1层？

**误解**：
> "第2层循环（IDLE）会阻塞第1层循环，导致无法处理其他事情"

**真相**：
- ✅ 第2层循环**确实会阻塞**第1层循环（但这是设计意图）
- ✅ 在 IDLE 状态下，teammate **不应该执行其他事情**
- ✅ 只有收到新消息才唤醒（这是正确的行为）

**正确理解**：
```
第1层循环在执行任务
→ LLM 不再调用工具（任务完成或暂停）
→ 进入第2层循环（IDLE等待）
→ 阻塞第1层循环（这是正确的）
→ 收到新消息
→ 退出第2层循环
→ 回到第1层循环（继续执行新任务）
```

---

## 五、代码逐行解析

### 5.1 第1层循环详解

```python
# 第513-532行：第1层循环开始
shutdown_requested = False
while not shutdown_requested:  # ← 第1层循环入口
    # ① 检查收件箱
    inbox = BUS.read_inbox(name)
    should_stop = False
    non_protocol = []
    for msg in inbox:
        # 处理协议消息（shutdown_request、plan_approval_response）
        if msg.get("type") in ("shutdown_request", "plan_approval_response"):
            should_stop = handle_inbox_message(name, msg, messages)
            if should_stop:
                break
        else:
            # 普通消息
            non_protocol.append(msg)
    
    # 如果收到 shutdown_request，退出第1层循环
    if should_stop:
        shutdown_requested = True
        break
    
    # 注入普通消息到 messages
    if non_protocol:
        inbox_json = json.dumps(non_protocol)
        messages.append({"role": "user",
            "content": "<inbox>" + inbox_json + "</inbox>"})
```

**关键点**：
- 第1层循环在开始时**先检查收件箱**
- 处理协议消息（shutdown_request 可能导致退出）
- 注入普通消息到 messages（供 LLM 处理）

### 5.2 LLM 调用

```python
# 第534-542行：LLM 调用
try:
    response = client.messages.create(
        model=MODEL, system=system, messages=messages[-20:],
        tools=sub_tools, max_tokens=8000)
except Exception:
    break

messages.append({"role": "assistant", "content": response.content})

# ③ 检查 stop_reason
if response.stop_reason != "tool_use":
    # ← 进入第2层循环（IDLE 等待）
```

**关键点**：
- LLM 调用后，检查 `stop_reason`
- 如果是 `"tool_use"` → 执行工具 → 继续第1层循环
- 如果不是 `"tool_use"` → 进入第2层循环（IDLE）

### 5.3 第2层循环详解

```python
# 第545-564行：第2层循环（IDLE 等待）
while not shutdown_requested:  # ← 第2层循环入口
    time.sleep(1)  # ← 每1秒轮询一次
    inbox = BUS.read_inbox(name)
    
    # 如果没有消息，继续等待
    if not inbox:
        continue
    
    # 处理收件箱消息
    for msg in inbox:
        # 处理协议消息
        if msg.get("type") in ("shutdown_request", "plan_approval_response"):
            should_stop = handle_inbox_message(name, msg, messages)
            if should_stop:
                shutdown_requested = True
                break
        else:
            # 普通消息
            non_protocol.append(msg)
    
    # 如果收到 shutdown_request，退出第2层循环
    if shutdown_requested:
        break
    
    # 如果有普通消息，退出第2层循环，回到第1层
    if non_protocol:
        inbox_json = json.dumps(non_protocol)
        messages.append({"role": "user",
            "content": "<inbox>" + inbox_json + "</inbox>"})
        break  # ← 退出第2层循环，回到第1层循环
```

**关键点**：
- 第2层循环**每1秒轮询**收件箱（不等待用户）
- 收到 shutdown_request → 退出（结束线程）
- 收到普通消息 → 退出（回到第1层循环）
- 没有消息 → 继续等待（continue）

### 5.4 工具执行（不是循环）

```python
# 第567-575行：工具执行
results = []
for block in response.content:  # ← 这不是循环结构，只是顺序处理
    if block.type == "tool_use":
        handler = sub_handlers.get(block.name)
        output = handler(**block.input) if handler else "Unknown"
        results.append({"type": "tool_result",
                        "tool_use_id": block.id,
                        "content": str(output)})
messages.append({"role": "user", "content": results})

# ← 继续第1层循环（下一轮 LLM 调用）
```

**关键点**：
- 工具执行只是**顺序处理**（for loop）
- 不是循环结构的一部分
- 执行完后，回到第1层循环继续

### 5.5 consume_lead_inbox 的两次调用

```python
# 调用①：check_inbox 工具调用
def run_check_inbox() -> str:
    msgs = consume_lead_inbox(route_protocol=True)  # ← LLM 主动调用
    ...

# 调用②：主循环结束后自动调用
if __name__ == "__main__":
    while True:
        query = input("s16 >> ")
        history.append({"role": "user", "content": query})
        agent_loop(history, context)  # ← Lead 主循环
        
        # ★ 主循环结束后，立即自动检查
        inbox_msgs = consume_lead_inbox(route_protocol=True)  # ← 自动调用！
        if inbox_msgs:
            history.append({"role": "user",
                            "content": f"[Inbox]\n{inbox_text}"})
        
        # ← 等待用户下次输入
```

**关键点**：
- 调用①：LLM 主动决定（在处理过程中）
- 调用②：系统自动执行（在主循环结束后）
- **两次都不需要等待用户下次输入**

---

## 六、总结

### 6.1 spawn_teammate_thread 的循环结构

```
两层循环结构：

第1层循环（WORK）：
- 持久运行的主循环
- 检查收件箱 → LLM调用 → 执行工具
- stop_reason != "tool_use" → 进入第2层循环

第2层循环（IDLE）：
- 等待新消息
- 每1秒轮询收件箱（不等待用户）
- 收到新消息 → 回到第1层循环
- 收到 shutdown_request → 结束线程

工具执行：
- 不是循环结构
- 只是顺序处理（for loop）
```

### 6.2 consume_lead_inbox 的执行时机

```
两次调用时机：

调用①（LLM主动）：
- Lead 的 LLM 决定调用 check_inbox 工具
- 在处理过程中主动检查收件箱

调用②（系统自动）：
- Lead 主循环结束后立即执行
- 不需要等待用户下次输入
- 有消息就注入到 history
- 用户下次输入时，Lead 能看到已注入的消息
```

### 6.3 核心设计理念

**Teammate 的持久运行**：
- 第1层循环：保证 teammate 可以连续执行多个任务
- 第2层循环：保证 teammate 在空闲时不会退出，等待新任务

**Lead 的消息处理**：
- 主循环结束后自动检查：保证不会遗漏 teammate 的消息
- 双重检查机制：LLM 主动 check_inbox + 系统自动检查

**不需要用户触发**：
- Teammate 的 IDLE 轮询：每1秒主动检查（不等待用户）
- Lead 的消息注入：主循环结束后立即执行（不等待用户）

---

## 附录：完整代码片段

### A. 第1层循环完整代码

```python
# s16_team_protocols/code.py:513-532
shutdown_requested = False
while not shutdown_requested:  # ← 第1层循环
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
    if non_protocol:
        inbox_json = json.dumps(non_protocol)
        messages.append({"role": "user",
            "content": "<inbox>" + inbox_json + "</inbox>"})
```

### B. 第2层循环完整代码

```python
# s16_team_protocols/code.py:545-564
while not shutdown_requested:  # ← 第2层循环（IDLE）
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
        inbox_json = json.dumps(non_protocol)
        messages.append({"role": "user",
            "content": "<inbox>" + inbox_json + "</inbox>"})
        break
```

### C. consume_lead_inbox 完整代码

```python
# s16_team_protocols/code.py:420-435
def consume_lead_inbox(route_protocol: bool = True) -> list[dict]:
    msgs = BUS.read_inbox("lead")
    if not msgs:
        return []
    if route_protocol:
        for msg in msgs:
            meta = msg.get("metadata", {})
            req_id = meta.get("request_id", "")
            msg_type = msg.get("type", "")
            if req_id and msg_type.endswith("_response"):
                approve = meta.get("approve", False)
                match_response(msg_type, req_id, approve)
    return msgs
```

### D. 主循环结束后的调用

```python
# s16_team_protocols/code.py:872-879
inbox_msgs = consume_lead_inbox(route_protocol=True)
if inbox_msgs:
    inbox_text = "\n".join(
        f"From {m['from']}: {m['content'][:200]}" for m in inbox_msgs)
    history.append({"role": "user",
                    "content": f"[Inbox]\n{inbox_text}"})
    print(f"\n\033[33m[Inbox: {len(inbox_msgs)} messages injected]\033[0m")
```

---

## 参考资料

- [s16 Team Protocols 主文档](./README_ME.md)
- [s16 Team Protocols 代码](./code.py)
- [s15 Agent Teams 讨论文档](./README_ME2.md)
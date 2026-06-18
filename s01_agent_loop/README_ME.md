# s01 Agent Loop — 深度理解笔记

## 核心问题

大模型能输出命令，但不会自己执行，也不会看到结果后继续推理。

手动流程：
```
用户 → 模型输出命令 → 手动执行 → 贴结果回去 → 模型继续 → 手动执行 → ...
```

自动化：
```
用户 → Agent Loop 自动执行并反馈 → 直到完成
```

---

## 核心解决方案

**一个 `while True` 循环 + 一个判断**

```python
while True:
    response = LLM(messages, tools)
    messages.append({"role": "assistant", "content": response.content})
    
    if response.stop_reason != "tool_use":
        return  # 模型说"我做完了"，退出
    
    # 执行工具，收集结果
    results = execute_tools(response)
    
    # 喂回去，继续循环
    messages.append({"role": "user", "content": results})
```

---

## 双层循环结构

### 为什么需要两层循环？

| 循环 | 位置 | 作用 | 触发条件 | 退出条件 |
|------|------|------|---------|---------|
| **外层 while** | `main` 函数 | 处理多轮对话（用户可以多次输入） | 程序启动 | 用户输入 `q`/`exit`/空 |
| **内层 while** | `agent_loop` 函数 | 处理单次输入的多轮工具调用 | 用户提交问题 | `stop_reason != "tool_use"` |

### 流程图

```
外层循环 (多轮对话)
┌─────────────────────────────────────────────────────────────┐
│  while True:                                                 │
│      query = input(">> ")    ←── 等待用户输入                │
│      history.append(user_msg)                                │
│                                                              │
│      ┌─────────────────────────────────────────────────────┐│
│      │ 内层循环 (单次输入的多轮工具调用)                     ││
│      │ agent_loop(history):                                 ││
│      │     while True:                                      ││
│      │         response = LLM(messages)                     ││
│      │         messages.append(assistant_msg)               ││
│      │                                                       ││
│      │         if stop_reason != "tool_use":                ││
│      │             return  ←── 模型说完成，退出内层          ││
│      │                                                       ││
│      │         results = execute_tools(response)             ││
│      │         messages.append(user_msg_with_results)        ││
│      │         # 继续下一轮...                                ││
│      └─────────────────────────────────────────────────────┘│
│                                                              │
│      print(final_response)                                   │
│      # 继续等待下一个用户输入...                              ││
└─────────────────────────────────────────────────────────────┘
```

### 实例：用户输入 "创建 hello.py 并运行"

**内层循环执行过程：**

| 轮次 | LLM 输出 | stop_reason | 动作 |
|------|---------|-------------|------|
| 第 1 轮 | `tool_use(bash: echo 'print("Hello")' > hello.py)` | `"tool_use"` | 执行 → 添加 tool_result → 继续循环 |
| 第 2 轮 | `tool_use(bash: python hello.py)` | `"tool_use"` | 执行 → 添加 tool_result → 继续循环 |
| 第 3 轮 | `text: "已完成创建和运行"` | `"end_turn"` | 退出内层循环 |

**Messages 结构：**

```python
messages = [
    {"role": "user", "content": "创建 hello.py 并运行"},
    {"role": "assistant", "content": [tool_use: echo...]},      # 第1轮
    {"role": "user", "content": [tool_result: "(no output)"]},
    {"role": "assistant", "content": [tool_use: python...]},    # 第2轮
    {"role": "user", "content": [tool_result: "Hello!"]},
    {"role": "assistant", "content": [text: "已完成"]},          # 第3轮结束
]
```

---

## 关键代码详解

### 1. 用户输入提示符

```python
query = input("\033[36ms01 >> \033[0m")
```

| 部分 | 含义 |
|------|------|
| `input(...)` | Python 内置函数，等待用户输入 |
| `\033[36m` | ANSI 转义码，设置前景色为青色 |
| `s01 >> ` | 提示符文本 |
| `\033[0m` | ANSI 转义码，重置颜色 |

### 2. 调用大模型

```python
response = client.messages.create(
    model=MODEL,          # 模型 ID，如 claude-sonnet-4-6
    system=SYSTEM,        # 系统提示词：你是编码 agent
    messages=messages,    # 对话历史
    tools=TOOLS,          # 可用工具（这里只有 bash）
    max_tokens=8000,      # 最大输出 token
)
```

返回：
- `response.content`：模型回复（可能是文本或工具调用）
- `response.stop_reason`：停止原因

### 3. 先添加消息还是先判断？

```python
# 正确顺序！
messages.append({"role": "assistant", "content": response.content})  # 先添加
if response.stop_reason != "tool_use":                                # 后判断
    return
```

**为什么必须先添加？**

无论模型是调用工具还是结束对话，它的回复都必须记录到 messages：
- 调用工具时：后续需要这个 assistant 消息（包含工具调用 ID）
- 不调用工具时：这是最终回答，下一轮对话需要这个上下文

如果先判断再添加，会导致：
- 调用工具时 assistant 消息丢失
- 下轮循环 messages 不完整，API 报错

### 4. 工具执行

```python
results = []
for block in response.content:
    if block.type == "tool_use":
        output = run_bash(block.input["command"])
        results.append({
            "type": "tool_result",
            "tool_use_id": block.id,  # 关联工具调用 ID
            "content": output,
        })
messages.append({"role": "user", "content": results})
```

**关键点：**
- `tool_use_id` 必须与 `block.id` 一致，用于关联
- 结果作为 `user` 消息添加，触发下一轮 LLM 调用

---

## 两个核心信号

| stop_reason | 含义 | 循环动作 |
|-------------|------|---------|
| `"tool_use"` | 模型说"我要用工具" | 执行 → 结果喂回去 → 继续循环 |
| `"end_turn"` / 其他 | 模型说"我做完了" | 退出循环 |

---

## 消息流转规则

```
user(input) → assistant(tool_use) → user(tool_result) → assistant(tool_use) → ... → assistant(text)
```

**角色交替规则：**
- `user` → `assistant` → `user` → `assistant` → ...
- 工具结果以 `user` 角色发送，模型以 `assistant` 角色回复

---

## 工具定义 Schema

```python
TOOLS = [{
    "name": "bash",
    "description": "Run a shell command.",
    "input_schema": {
        "type": "object",
        "properties": {
            "command": {"type": "string"}
        },
        "required": ["command"],
    },
}]
```

告诉模型：
- 工具名：`bash`
- 功能：运行 shell 命令
- 参数：一个字符串 `command`

---

## 安全机制

```python
def run_bash(command: str) -> str:
    dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"]
    if any(d in command for d in dangerous):
        return "Error: Dangerous command blocked"
    # ...
```

1. **危险命令黑名单**：拦截 `rm -rf /`、`sudo` 等
2. **超时限制**：120 秒防止卡死
3. **输出截断**：最多 50000 字符

---

## 总结

| 概念 | 核心要点 |
|------|---------|
| **Agent Loop** | 一个 `while True`，模型调工具就继续，不调就停 |
| **双层循环** | 外层管对话，内层管工具调用 |
| **消息格式** | user → assistant → user(tool_result) → assistant → ... |
| **关键判断** | `stop_reason == "tool_use"` 决定是否继续 |

这是 AI Agent 的最小核心，后面 18 个章节都在这个循环上叠加机制，但**循环本身始终不变**。

---

## 参考资料

- [s01_agent_loop/README.md](./README.md) — 原始教材
- Claude Code 源码 `src/query.ts` — 生产级实现（1729 行的核心就是这 30 行）
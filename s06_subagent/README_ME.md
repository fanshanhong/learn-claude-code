# s06 Subagent — 深度理解笔记

## 核心问题

```
Agent 在修一个 bug。它读了 30 个文件来追踪调用链，中间聊了 60 轮。

messages 列表涨到 120 条，其中大部分是"追踪调用链"的中间过程，
和"修 bug"这个最终目标无关。

问题表现：
   ├─ 中间过程占着上下文位置
   ├─ Agent 越来越"健忘"
   ├─ 记不住最初的问题是什么了
   ├─ 上下文被无关信息污染
   └─ 注意力漂移，偏离目标

类比：
   你修 bug 的时候，会"开一个新终端"来追踪调用链。
   追踪完了，终端关掉，结果写进笔记，回到原来的终端继续修 bug。
   Agent 也需要这个能力：开一个独立的子上下文，给它一个独立的消息列表，
   让它专心做一件事。
```

---

## 一、宏观设计理念

### 1.1 什么是 Subagent？

```
Subagent 的核心概念：

定义：
   Subagent 是一个独立的 LLM 循环，拥有全新的 messages[]，
   专心执行一个子任务，结束后只回传摘要文本给主 Agent。

类比：
   ├─ 主 Agent：主终端（处理主任务）
   ├─ Subagent：新开的临时终端（处理子任务）
   ├─ messages：终端的历史记录
   ├─ 干净上下文：新开的终端没有历史记录
   └─ 回传摘要：临时终端关闭，结果写回笔记

关键特点：
   ├─ 上下文隔离：子 Agent 的中间过程不污染主 Agent 的上下文
   ├─ 只回传结论：不是回传整个 messages 列表
   ├─ 禁止递归：子 Agent 不能再 spawn 新的子 Agent
   ├─ 安全策略不跳过：子 Agent 工具调用也走 PreToolUse hook
   └─ 副作用保留：文件系统的改动（写文件、改文件）保留在工作目录
```

### 1.2 设计理念：上下文隔离

```
为什么需要上下文隔离？

问题：上下文污染
   ├─ 主 Agent 执行复杂任务
   ├─ 需要追踪调用链（读 30 个文件）
   ├─ messages 涨到 120 条
   ├─ 大部分是中间过程
   ├─ 和最终目标无关
   ├─ 占用上下文位置
   ├─ 系统提示的影响力被稀释
   ├─ Agent 越来越健忘
   └─ 偏离目标

解决方案：上下文隔离
   ├─ 给子任务一个全新的 messages[]
   ├─ 子 Agent 专心执行子任务
   ├─ 中间过程在子 messages 中
   ├─ 不污染主 messages
   ├─ 子任务完成后
   ├─ 只回传摘要文本
   ├─ 子 messages 被丢弃
   └─ 主 messages 保持干净

设计哲学：
   ├─ "大任务拆小"
   ├─ "每个小任务干净的上下文"
   ├─ "专心做一件事"
   ├─ "只保留结论，丢弃过程"
   └─ "注意力不漂移"
```

### 1.3 主 Agent vs Subagent

```
主 Agent vs Subagent 对比：

主 Agent：
   ├─ messages：包含所有对话历史（用户输入 + 工具结果）
   ├─ tools：全部工具（bash, read, write, edit, glob, todo_write, task）
   ├─ system：SYSTEM prompt（"For complex sub-problems, use task tool"）
   ├─ 循环：主循环（agent_loop）
   ├─ 上下文：可能很长（120+ 条消息）
   ├─ 注意力：可能漂移（被中间过程干扰）
   └─ 目标：完成用户任务

Subagent：
   ├─ messages：全新 messages（只有一条 description）
   ├─ tools：子工具（bash, read, write, edit, glob）—— 没有 task！
   ├─ system：SUB_SYSTEM prompt（"完成任务，不要委派"）
   ├─ 循环：子循环（在 spawn_subagent 函数内）
   ├─ 上下文：干净（只有 1 条消息开始）
   ├─ 注意力：专注（没有其他干扰）
   ├─ 目标：完成 description 指定的子任务
   ├─ 生命周期：最多 30 轭
   └─ 结果：只返回摘要文本

关键差异：
   ├─ messages：主 Agent 可能很长，Subagent 全新干净
   ├─ tools：主 Agent 有 task，Subagent 没有（防止递归）
   ├─ system：不同的 system prompt
   ├─ 循环：主循环 vs 子循环
   └─ 结果：主 Agent 继续处理，Subagent 只返回摘要
```

---

## 二、实现细节详解

### 2.1 task 工具定义

```python
# task 工具定义（添加到主 Agent 的 TOOLS）
TOOLS.append({
    "name": "task",
    "description": "Launch a subagent to handle a complex subtask. Returns only the final conclusion.",
    "input_schema": {
        "type": "object",
        "properties": {
            "description": {"type": "string"}  # 子任务描述
        },
        "required": ["description"]
    }
})

# 注册到 TOOL_HANDLERS
TOOL_HANDLERS["task"] = spawn_subagent
```

**关键点：**
- 工具名：`task`
- 参数：`description`（字符串，描述子任务）
- 返回值：只有最终的结论文本

### 2.2 spawn_subagent 实现

```python
def spawn_subagent(description: str) -> str:
    """Spawn a subagent with fresh messages[], return summary only."""
    print(f"\n\033[35m[Subagent spawned]\033[0m")
    
    # 1. 创建全新的 messages（只有一条 description）
    messages = [{"role": "user", "content": description}]
    
    # 2. 子 Agent 循环（最多 30 轭）
    for _ in range(30):  # safety limit
        # 调用 LLM
        response = client.messages.create(
            model=MODEL,
            system=SUB_SYSTEM,
            messages=messages,
            tools=SUB_TOOLS,  # 子工具（没有 task）
            max_tokens=8000,
        )
        
        # 添加 assistant 回复
        messages.append({"role": "assistant", "content": response.content})
        
        # 检查是否结束
        if response.stop_reason != "tool_use":
            break
        
        # 执行工具
        results = []
        for block in response.content:
            if block.type == "tool_use":
                # 3. 子 Agent 的工具调用也走 hooks
                blocked = trigger_hooks("PreToolUse", block)
                if blocked:
                    results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": str(blocked)
                    })
                    continue
                
                # 执行工具
                handler = SUB_HANDLERS.get(block.name)
                output = handler(**block.input) if handler else f"Unknown: {block.name}"
                
                trigger_hooks("PostToolUse", block, output)
                print(f"  \033[90m[sub] {block.name}: {str(output)[:100]}\033[0m")
                
                results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": output
                })
        
        # 添加 tool_result
        messages.append({"role": "user", "content": results})
    
    # 4. 只返回最后的文本结论
    result = extract_text(messages[-1]["content"])
    print(f"\033[35m[Subagent done]\033[0m")
    return result  # 只有摘要，messages 被丢弃
```

### 2.3 子 Agent 的工具列表

```python
# 子 Agent 的工具（没有 task，防止递归）
SUB_TOOLS = [
    {"name": "bash", ...},
    {"name": "read_file", ...},
    {"name": "write_file", ...},
    {"name": "edit_file", ...},
    {"name": "glob", ...},
]
# NO "task" tool — prevent recursive spawning

# 子 Agent 的 handlers
SUB_HANDLERS = {
    "bash": run_bash,
    "read_file": run_read,
    "write_file": run_write,
    "edit_file": run_edit,
    "glob": run_glob,
}
```

**关键设计：**
- 子 Agent 没有 `task` 工具
- 没有 `todo_write` 工具（教学版省略）
- 防止递归：子 Agent 不能再 spawn 新的子 Agent

### 2.4 子 Agent 的 SYSTEM Prompt

```python
# 主 Agent 的 SYSTEM prompt
SYSTEM = (
    f"You are a coding agent at {WORKDIR}. "
    "For complex sub-problems, use the task tool to spawn a subagent."
)

# 子 Agent 的 SYSTEM prompt（不同！）
SUB_SYSTEM = (
    f"You are a coding agent at {WORKDIR}. "
    "Complete the task you were given, then return a concise summary. "
    "Do not delegate further."  # ← 关键：不要委派
)
```

**关键点：**
- 子 Agent 的 SYSTEM 明确说："不要委派"
- 子 Agent 被告知："完成任务，返回摘要"
- 防止子 Agent 尝试再次调用 task

### 2.5 extract_text 辅助函数

```python
def extract_text(content) -> str:
    """Extract text from message content blocks."""
    if not isinstance(content, list):
        return str(content)
    return "\n".join(
        getattr(b, "text", "") 
        for b in content 
        if getattr(b, "type", None) == "text"
    )
```

**作用：**
- 从 messages 的最后一条消息中提取文本
- 只返回 text block 的内容
- 不返回 tool_use 或其他类型的 block

---

## 三、三个关键设计决策

```
三个关键设计决策：

决策 1：上下文隔离
   ├─ 选择：全新 messages[]
   ├─ 原因：子 Agent 的中间过程不污染主 Agent 的上下文
   └─ 实现：messages = [{"role": "user", "content": description}]

决策 2：只回传结论
   ├─ 选择：extract_text(last_message)
   ├─ 原因：不是回传整个 messages 列表
   └─ 实现：return extract_text(messages[-1]["content"])

决策 3：禁止递归
   ├─ 选择：子 Agent 无 task 工具
   ├─ 原因：防止子 Agent 再 spawn 新的子 Agent
   └─ 实现：SUB_TOOLS 不包含 "task"

决策 4：安全策略不跳过
   ├─ 选择：子 Agent 工具调用也走 PreToolUse hook
   ├─ 原因：上下文隔离不代表权限隔离
   └─ 实现：trigger_hooks("PreToolUse", block) 在子循环中
```

---

## 四、完整执行流程

```
完整执行流程示例：

用户输入："分析这个项目使用了什么测试框架"
    ↓
主 Agent 循环开始
    ↓
LLM 分析任务：
   ├─ "这需要读很多文件来追踪"
   ├─ "应该用 subagent 来处理"
   └─ 决定调用 task 工具
    ↓
tool_use: task
   description = "Find what testing framework this project uses. Read package.json, config files, and test files."
    ↓
主 Agent 执行 spawn_subagent(description)
    ↓
┌─────────────────────────────────────────────────────────────┐
│ Subagent 开始                                                │
│                                                              │
│ print("[Subagent spawned]")                                  │
│                                                              │
│ messages = [                                                 │
│     {"role": "user",                                         │
│      "content": "Find what testing framework..."}            │
│ ]                                                            │
│                                                              │
│ ─────────────────────────────────────────────────────────── │
│                                                              │
│ Subagent 循环（最多 30 轭）：                                  │
│                                                              │
│ Round 1:                                                     │
│     LLM 调用：                                                │
│         tool_use: read_file                                  │
│             path="package.json"                              │
│     ↓                                                        │
│     trigger_hooks("PreToolUse", block)                       │
│     ↓                                                        │
│     handler = SUB_HANDLERS["read_file"]                      │
│     ↓                                                        │
│     output = run_read("package.json")                        │
│         → "内容：pytest, unittest..."                         │
│     ↓                                                        │
│     trigger_hooks("PostToolUse", block, output)              │
│     ↓                                                        │
│     print("[sub] read_file: pytest...")                      │
│     ↓                                                        │
│     messages.append(tool_result)                             │
│                                                              │
│ ─────────────────────────────────────────────────────────── │
│                                                              │
│ Round 2:                                                     │
│     LLM 调用：                                                │
│         tool_use: glob                                       │
│             pattern="test_*.py"                              │
│     ↓                                                        │
│     print("[sub] glob: test_auth.py, test_user.py...")       │
│     ↓                                                        │
│     messages.append(tool_result)                             │
│                                                              │
│ ─────────────────────────────────────────────────────────── │
│                                                              │
│ Round 3:                                                     │
│     LLM 调用：                                                │
│         tool_use: read_file                                  │
│             path="test_auth.py"                              │
│     ↓                                                        │
│     print("[sub] read_file: import pytest...")               │
│     ↓                                                        │
│     messages.append(tool_result)                             │
│                                                              │
│ ─────────────────────────────────────────────────────────── │
│                                                              │
│ Round 4:                                                     │
│     LLM 分析完成：                                            │
│         text: "项目使用 pytest 作为测试框架。                  │
│               发现了 5 个测试文件，都导入 pytest。"            │
│     ↓                                                        │
│     stop_reason = "end_turn"                                 │
│     ↓                                                        │
│     break（退出循环）                                         │
│                                                              │
│ ─────────────────────────────────────────────────────────── │
│                                                              │
│ 提取结论：                                                    │
│     result = extract_text(messages[-1]["content"])           │
│         → "项目使用 pytest 作为测试框架..."                    │
│                                                              │
│ print("[Subagent done]")                                     │
│                                                              │
│ return result                                                │
│                                                              │
│ messages 被丢弃（整个子上下文被丢弃）                          │
└─────────────────────────────────────────────────────────────┘
    ↓
主 Agent 收到 tool_result：
   content = "项目使用 pytest 作为测试框架。发现了 5 个测试文件..."
    ↓
主 Agent 继续：
   ├─ messages.append(tool_result)
   ├─ 主 messages 只增加了一条摘要消息
   ├─ 不是增加 4 条（子 Agent 的中间过程）
   └─ 主上下文保持干净
    ↓
主 Agent 继续处理：
   ├─ "好的，我知道了测试框架是 pytest"
   ├─ 继续后续任务...
   └─ 主 messages 现在只有：
       ├─ 用户输入
       ├─ assistant（调用 task）
       ├─ tool_result（摘要）
       ├─ assistant（继续处理）
       └─ ...
```

---

## 五、关键问题澄清

### 5.1 spawn_subagent 会创建子进程吗？

```
spawn_subagent 的真实实现：

错误理解：
   ├─ spawn_subagent 创建子进程
   ├─ 进程间通信（IPC）
   ├─ 多线程
   ├─ 真正的"spawn"（操作系统级别）
   └─ 并发执行

正确理解：
   ├─ spawn_subagent 是同一个进程内的函数调用
   ├─ 不创建子进程
   ├─ 不创建线程
   ├─ 不涉及进程间通信
   ├─ 只是创建了一个新的 messages 数组
   ├─ 然后在这个数组内循环调用 LLM
   ├─ 同步执行（父等待子完成）
   └─ "spawn" 是概念上的，不是操作系统级别的

──────────────────────────────────────────────────────────

代码验证：

def spawn_subagent(description: str) -> str:
    # 没有任何进程创建代码
    # 没有 subprocess.Popen
    # 没有 multiprocessing.Process
    # 没有 threading.Thread
    # 没有 os.fork()

    # 只是创建新的 messages 数组
    messages = [{"role": "user", "content": description}]

    # 在同一个进程内循环调用 LLM
    for _ in range(30):
        response = client.messages.create(...)
        # ...

    # 返回结果（函数返回）
    return result

──────────────────────────────────────────────────────────

执行模型：

主进程
   ├─ agent_loop（主循环）
   ├─ 收到 tool_use: task
   ├─ 调用 spawn_subagent（函数调用）
   │   ├─ 创建新 messages
   │   ├─ 子循环（在同一个进程内）
   │   ├─ LLM 调用
   │   ├─ 工具执行
   │   └─ 返回摘要
   ├─ spawn_subagent 返回
   ├─ 继续主循环
   └─ ...

没有进程切换，没有上下文切换，没有并发
全部在同一个 Python 进程内

──────────────────────────────────────────────────────────

为什么叫 "spawn"？

概念上的"spawn"：
   ├─ 不是操作系统的 spawn
   ├─ 是概念上的"创建独立上下文"
   ├─ 类比：
   │   ├─ "开一个新终端" → 创建新的上下文
   │   ├─ 但实际上没有开新终端
   │   ├─ 只是创建新的 messages
   │   └─ 执行完后丢弃
   └─ "spawn" 是隐喻，不是字面意思

真正隔离的是：
   ├─ messages（上下文）
   ├─ 不是进程
   ├─ 不是内存
   └─ 不是 CPU

──────────────────────────────────────────────────────────

CC 的真实实现（对比）：

教学版（s06）：
   ├─ 同进程，同步
   ├─ 函数调用
   ├─ 新 messages
   └─ 无进程

CC 生产版：
   ├─ 同进程，同步或异步
   ├─ 也是函数调用（不是进程）
   ├─ 新 messages 或 fork messages
   ├─ async 模式：run_in_background
   │   ├─ 但还是在同一个进程内
   │   ├─ 只是异步执行
   │   └─ 不是进程
   └─ 没有真正的进程创建

总结：
   "spawn" 是概念上的，不是操作系统级别的
   真正隔离的是 messages（上下文），不是进程
```

### 5.2 上下文就是 messages 吗？

```
上下文的精确定义：

什么是上下文？

在 LLM Agent 中：
   ├─ 上下文 = messages 数组
   ├─ messages 包含：
   │   ├─ 用户输入（user messages）
   │   ├─ 助手回复（assistant messages）
   │   ├─ 工具调用（tool_use blocks）
   │   ├─ 工具结果（tool_result）
   │   └─ 文本回复（text blocks）
   ├─ 上下文长度 = messages 的长度
   ├─ 上下文内容 = messages 的具体内容
   └─ LLM 根据 messages 进行推理

──────────────────────────────────────────────────────────

"干净的上下文" 的精确含义：

定义：
   干净的上下文 = 空的 messages + 一条 description

实现：
   messages = [{"role": "user", "content": description}]

特点：
   ├─ messages 长度 = 1
   ├─ 只包含一条消息
   ├─ 没有之前的对话历史
   ├─ 没有工具执行结果
   ├─ 没有其他干扰信息
   └─ 子 Agent 只看到这一个任务

──────────────────────────────────────────────────────────

对比：主 Agent 的上下文 vs Subagent 的上下文

主 Agent 的 messages（可能很长）：
   [
       {"role": "user", "content": "修 bug"},
       {"role": "assistant", "content": [tool_use...]},
       {"role": "user", "content": [tool_result...]},
       {"role": "assistant", "content": [tool_use...]},
       {"role": "user", "content": [tool_result...]},
       ...
       {"role": "assistant", "content": [tool_use...]},
       {"role": "user", "content": [tool_result...]},
       # 120 条消息
   ]

Subagent 的 messages（干净）：
   [
       {"role": "user",
        "content": "Find what testing framework..."}
       # 只有 1 条消息
   ]

──────────────────────────────────────────────────────────

为什么"干净"很重要？

主 Agent 的问题：
   ├─ messages 有 120 条
   ├─ 大部分是中间过程
   ├─ LLM 看到所有历史
   ├─ 注意力被分散
   ├─ 系统提示影响力被稀释
   ├─ 容易忘记最初目标
   └─ 可能偏离方向

Subagent 的优势：
   ├─ messages 只有 1 条
   ├─ 只看到当前任务
   ├─ 没有历史干扰
   ├─ 注意力集中
   ├─ 系统提示影响力强
   ├─ 不会忘记目标
   └─ 专注执行

──────────────────────────────────────────────────────────

执行过程中，Subagent 的 messages 会增长：

开始：
   messages = [{"role": "user", "content": description}]

Round 1：
   messages.append(assistant, [tool_use])
   messages.append(user, [tool_result])
   # messages 长度 = 3

Round 2：
   messages.append(assistant, [tool_use])
   messages.append(user, [tool_result])
   # messages 长度 = 5

Round 3：
   messages.append(assistant, [text])
   # messages 长度 = 6

结束：
   extract_text(messages[-1])
   return result
   messages 被丢弃

──────────────────────────────────────────────────────────

关键理解：

   ├─ "上下文隔离" = "不同的 messages 数组"
   ├─ "干净上下文" = "新的 messages 数组，只有 description"
   ├─ "spawn" = "创建新的 messages，不是进程"
   ├─ "子 Agent" = "在新的 messages 内循环的 LLM"
   ├─ "回传摘要" = "只返回文本，messages 丢弃"
   ├─ "不污染主上下文" = "子 messages 不加入主 messages"
   └─ 全部是 messages 的操作，不是进程

总结：
   你的理解完全正确！
   ├─ 上下文 = messages
   ├─ 干净的上下文 = 空的 messages + 一条 description
   ├─ "spawn" = 创建新的 messages
   └─ 不是进程，只是数组
```

---

## 六、"一个 Subagent 就是一个 Claude 实例" 的正确理解

### 6.1 Claude 实例的精确定义

```
"Claude 实例" 的正确含义：

在 Claude API 的语境中：
   ├─ Claude 实例 = Claude API 的一个独立对话会话
   ├─ 每次调用 client.messages.create() 就是一个对话
   ├─ 每个 messages 数组代表一个独立的对话上下文
   └─ 所以可以理解为"一个 Claude 的对话实例"

Subagent 的特点：
   ├─ 有独立的 messages 数组
   ├─ 有独立的 SYSTEM prompt
   ├─ 有独立的 tools 列表
   ├─ 有独立的 LLM 循环
   ├─ 调用 client.messages.create()
   └─ 所以确实是"一个 Claude 的对话实例"

正确理解：
   ├─ "Claude 实例" = "Claude API 的对话会话实例"
   ├─ 不是"进程实例"
   ├─ 不是"程序实例"
   ├─ 不是"模型实例"
   └─ 是"对话会话实例"

──────────────────────────────────────────────────────────

常见误解：

误解 1："进程实例"
   ├─ 以为 Subagent 是一个独立的进程
   ├─ 以为每个 Subagent 是一个 Claude.exe 程序
   ├─ 以为有进程间通信
   └─ 错误！Subagent 是同一个进程内的代码

误解 2："程序实例"
   ├─ 以为每个 Subagent 运行一个独立的 Claude CLI 程序
   ├─ 以为有多个 Claude Code 程序实例
   └─ 错误！只有一个 Claude Code 程序

误解 3："模型实例"
   ├─ 以为每个 Subagent 加载一个独立的 Claude 模型
   ├─ 以为有多个 GPU 进程
   ├─ 以为每个 Subagent 有自己的模型权重
   └─ 错误！Claude 模型在 Anthropic 服务器上，只有一个

误解 4："并发实例"
   ├─ 以为多个 Subagent 同时运行
   ├─ 以为是并行执行
   ├─ 以为有并发控制
   └─ 错误！教学版是同步执行，一个接一个
```

### 6.2 物理层面 vs 对话层面

```
物理层面（只有一个）：

Claude Code CLI 程序：
   ├─ 一个 Python 进程
   ├─ 一个程序实例
   ├─ 在你的电脑上
   ├─ 执行所有代码
   └─ Spawn 所有 Subagent

Claude 模型：
   ├─ 一个模型实例
   ├─ 在 Anthropic 服务器
   ├─ 所有对话共享
   └─ GPU 推理

Claude API 服务：
   ├─ 一个 API 服务
   ├─ Anthropic 的 HTTP API
   ├─ 接收所有 API 请求
   └─ 处理所有 messages

──────────────────────────────────────────────────────────

对话层面（多个 Claude 实例）：

Claude 实例 #1（主 Agent）：
   ├─ messages：主对话历史
   ├─ SYSTEM：主 SYSTEM prompt
   ├─ tools：主工具列表（有 task）
   ├─ 循环：主循环（agent_loop）
   ├─ 调用：client.messages.create()
   ├─ Claude API 对话会话 #1
   └─ Anthropic 服务器处理

Claude 实例 #2（Subagent #1）：
   ├─ messages：子对话历史 #1
   ├─ SYSTEM：SUB_SYSTEM prompt
   ├─ tools：子工具列表（无 task）
   ├─ 循环：子循环（spawn_subagent 函数内）
   ├─ 调用：client.messages.create()
   ├─ Claude API 对话会话 #2
   ├─ Anthropic 服务器处理
   ├─ 完成后 messages 被丢弃
   └─ Claude 实例 #2 结束

Claude 实例 #3（Subagent #2）：
   ├─ messages：子对话历史 #2
   ├─ SYSTEM：SUB_SYSTEM prompt
   ├─ tools：子工具列表（无 task）
   ├─ 循环：子循环
   ├─ 调用：client.messages.create()
   ├─ Claude API 对话会话 #3
   ├─ Anthropic 服务器处理
   ├─ 完成后 messages 被丢弃
   └─ Claude 实例 #3 结束

──────────────────────────────────────────────────────────

总结：

物理层面：
   ├─ 1 个 Claude Code CLI 程序
   ├─ 1 个 Claude 模型（在 Anthropic 服务器）
   ├─ 1 个 Claude API 服务
   ├─ 1 个 Python 进程
   └─ 没有多个进程

对话层面：
   ├─ 主 Agent = Claude 实例 #1
   ├─ Subagent #1 = Claude 实例 #2
   ├─ Subagent #2 = Claude 实例 #3
   ├─ 每个 Subagent 是一个 Claude 对话实例
   ├─ 每个 Subagent 有独立的 messages
   ├─ 每个 Subagent 调用 Claude API
   └─ 共享同一个 Claude 模型

正确说法：
   ├─ "一个 Subagent = 一个 Claude API 对话会话实例"
   ├─ "一个 Subagent = 一个独立的 messages 数组"
   ├─ 不是"一个 Claude 进程实例"
   ├─ 不是"一个 Claude 模型实例"
   └─ 是"对话实例"，不是"物理实例"
```

### 6.3 类比理解

```
聊天软件类比：

Claude Code CLI 就像一个聊天软件：
   ├─ 一个聊天程序（Claude Code CLI）
   ├─ 可以开多个聊天窗口
   ├─ 每个聊天窗口有独立的历史
   ├─ 每个聊天窗口是独立的对话
   └─ 但物理上只有一个聊天程序

主 Agent：
   ├─ 主聊天窗口
   ├─ 和 Claude 的主对话
   ├─ messages = 主聊天历史
   ├─ 可以发送消息
   ├─ 可以调用工具
   ├─ 可以开新窗口（spawn subagent）
   └─ 是 Claude 实例 #1

Subagent：
   ├─ 新开的聊天窗口
   ├─ 和 Claude 的子对话
   ├─ messages = 子聊天历史（干净）
   ├─ 只有任务描述
   ├─ 完成任务后关闭
   ├─ 结果写回主窗口
   ├─ 子窗口被丢弃
   └─ 是 Claude 实例 #2

关键理解：
   ├─ 物理上：只有一个聊天程序
   ├─ 对话上：多个聊天窗口（多个 Claude 实例）
   ├─ 每个窗口 = 一个 Claude API 对话会话
   ├─ 不是多个聊天程序
   ├─ 不是多个进程
   └─ 是"对话实例"，不是"程序实例"

──────────────────────────────────────────────────────────

Web 浏览器类比：

Claude Code CLI 就像一个浏览器：
   ├─ 一个浏览器程序
   ├─ 可以开多个标签页
   ├─ 每个标签页有独立的历史
   ├─ 每个标签页访问同一个网站
   └─ 但物理上只有一个浏览器程序

主 Agent：
   ├─ 主标签页
   ├─ 访问 Claude API
   ├─ messages = 浏览历史
   ├─ 可以开新标签页
   └─ Claude 实例 #1

Subagent：
   ├─ 新开的标签页
   ├─ 访问 Claude API
   ├─ messages = 标签页历史（干净）
   ├─ 完成任务后关闭
   ├─ 结果写回主标签页
   ├─ 标签页被丢弃
   └─ Claude 实例 #2

Claude API 服务：
   ├─ 网站（api.anthropic.com）
   ├─ 一个网站
   ├─ 所有标签页访问同一个网站
   └─ 处理所有请求

关键理解：
   ├─ 物理上：只有一个浏览器程序
   ├─ 对话上：多个标签页（多个 Claude 实例）
   ├─ 每个标签页 = 一个 Claude API 对话会话
   ├─ 不是多个浏览器
   ├─ 不是多个进程
   └─ 是"标签页实例"，不是"程序实例"
```

### 6.4 完整执行流程图解

```
完整执行流程（物理层面 + 对话层面）：

物理层面（一个 Python 进程）：

┌───────────────────────────────────────────────────────┐
│ Claude Code CLI 程序（一个进程）                        │
│                                                        │
│ 主循环                                                 │
│     ├─ agent_loop(messages_1)                         │
│     │   ├─ response = client.messages.create(...)     │
│     │   ├─ tool_use: task                             │
│     │   └─ spawn_subagent(description)                │
│     │       ├─ 创建 messages_2                        │
│     │       ├─ 子循环                                  │
│     │       │   ├─ response = client.messages.create  │
│     │       │   ├─ tool_use: read_file                │
│     │       │   ├─ ...                                │
│     │       │   └─ stop                               │
│     │       └─ return result                          │
│     ├─ messages_1.append(tool_result)                 │
│     ├─ 继续主循环                                      │
│     │   ├─ tool_use: task                             │
│     │   └─ spawn_subagent(description)                │
│     │       ├─ 创建 messages_3                        │
│     │       ├─ 子循环                                  │
│     │       │   ├─ response = client.messages.create  │
│     │       │   ├─ ...                                │
│     │       │   └─ stop                               │
│     │       └─ return result                          │
│     ├─ messages_1.append(tool_result)                 │
│     └─ 继续主循环                                      │
│                                                        │
│ 所有代码在同一个进程内                                   │
│ 没有 subprocess、multiprocessing、threading             │
│ 只有函数调用                                            │
│ messages_1、messages_2、messages_3 是不同的数组        │
│ 但都在同一个进程内存中                                   │
└───────────────────────────────────────────────────────┘

──────────────────────────────────────────────────────────

对话层面（多个 Claude 实例）：

Claude 实例 #1（主 Agent）：
   ├─ messages_1
   ├─ SYSTEM
   ├─ TOOLS（有 task）
   ├─ client.messages.create
   ├─ Claude API 对话会话 #1
   └ Anthropic 服务器处理

Claude 实例 #2（Subagent #1）：
   ├─ messages_2
   ├─ SUB_SYSTEM
   ├─ SUB_TOOLS（无 task）
   ├─ client.messages.create
   ├─ Claude API 对话会话 #2
   ├─ Anthropic 服务器处理
   ├─ 完成后 messages_2 被丢弃
   └─ Claude 实例 #2 结束

Claude 实例 #3（Subagent #2）：
   ├─ messages_3
   ├─ SUB_SYSTEM
   ├─ SUB_TOOLS（无 task）
   ├─ client.messages.create
   ├─ Claude API 对话会话 #3
   ├─ Anthropic 服务器处理
   ├─ 完成后 messages_3 被丢弃
   └─ Claude 实例 #3 结束

Claude 模型（Anthropic 服务器）：
   ├─ 一个模型实例
   ├─ 处理所有对话
   ├─ Claude 实例 #1 调用
   ├─ Claude 实例 #2 调用
   ├─ Claude 实例 #3 调用
   └─ 共享同一个模型

──────────────────────────────────────────────────────────

总结：

物理层面：
   ├─ 1 个 Claude Code CLI 程序
   ├─ 1 个 Python 进程
   ├─ 1 个 Claude 模型（在 Anthropic）
   ├─ 所有 Subagent 在同一个进程内
   └─ 没有多个进程

对话层面：
   ├─ 多个 Claude API 对话会话
   ├─ 主 Agent = Claude 实例 #1
   ├─ Subagent #1 = Claude 实例 #2
   ├─ Subagent #2 = Claude 实例 #3
   ├─ 每个 Subagent 是一个 Claude 对话实例
   ├─ 每个 Subagent 有独立的 messages
   ├─ 每个 Subagent 调用 Claude API
   └─ 共享同一个 Claude 模型

正确说法：
   ├─ "一个 Subagent = 一个 Claude API 对话会话实例"
   ├─ "一个 Subagent = 一个独立的 messages 数组"
   ├─ 不是"一个 Claude 进程实例"
   ├─ 不是"一个 Claude 模型实例"
   └─ 是"对话实例"，不是"物理实例"
```

---

## 七、Claude Code 的实现详解

### 7.1 CC 的三种 Subagent 模式

```
CC 的三种执行模式：

教学版只讲了"全新的 messages[]"。
CC 实际有三种执行模式：

模式 1：Normal Subagent
   ├─ 触发条件：指定了 subagent_type（normal path）
   ├─ 上下文：全新 messages[]，只有 prompt
   ├─ 类似教学版
   └─ 最简单

模式 2：Fork Subagent
   ├─ 触发条件：没指定 subagent_type，fork gate 开启
   ├─ 上下文：通过 buildForkedMessages() 构造 cache-friendly 前缀
   ├─ 目的：共享 prompt cache
   ├─ messages：共享 prompt cache，不是完全干净
   └─ 性能优化

模式 3：General-Purpose
   ├─ 触发条件：没指定 subagent_type，fork gate 关闭
   ├─ 上下文：同 Normal
   └─ 默认模式

对比表：

模式              触发条件               上下文                    目的
Normal Subagent   指定 subagent_type    全新 messages[]           简单隔离
Fork Subagent     fork gate 开启        cache-friendly 前缀       性能优化
General-Purpose   fork gate 关闭        全新 messages[]           默认
```

### 7.2 Fork 模式：为了共享 Prompt Cache

```
Fork 模式详解：

这是教学版没有的核心概念。

目的：
   ├─ 共享 Anthropic API 的 prompt cache
   ├─ 父子 Agent 的 system prompt、tools、messages 前缀一致
   ├─ API 端不需要重算
   └─ 节省 token 和时间

实现：
   ├─ 不创建全新上下文
   ├─ 通过 buildForkedMessages() 构造 cache-friendly 消息前缀
   ├─ 保留父 assistant message
   ├─ 生成 placeholder tool results
   └─ 目的不是隔离，而是缓存共享

源码位置：
   ├─ forkSubagent.ts:60-71
   ├─ buildForkedMessages(): forkSubagent.ts:107-168
   └─ forkedAgent.ts:57-68

缓存命中的五个关键组件：
   ├─ system prompt
   ├─ tools
   ├─ model
   ├─ messages 前缀
   └─ thinking config
   必须字节级一致才能命中缓存
```

### 7.3 Context Isolation 的精确粒度

```
Context Isolation 的精确粒度：

createSubagentContext()（forkedAgent.ts:345-462）
创建子 Agent 的 ToolUseContext：

字段              行为
abortController   新的 child controller，父 abort 向下传播
setAppState       默认 no-op；但 sync agent 通过 shareSetAppState 共享
readFileState     从父克隆（避免重复读相同文件）
queryTracking     新 chainId，depth = parentDepth + 1

子 Agent 不是完全隔离的：
   ├─ 文件读取状态是共享的（从父克隆）
   ├─ UI 和通知的隔离程度取决于执行路径
   ├─ sync/async/fork/teammate 各不同
   └─ 不是简单的"完全隔离"
```

### 7.4 递归 Fork 防护

```
递归 Fork 防护：

教学版：
   ├─ 子 Agent 不给 task 工具
   ├─ 简单直接
   └─ 防止递归

CC 的真实实现（更精细）：

isInForkChild()（forkSubagent.ts:78-89）：
   ├─ 检查对话历史中是否有 FORK_BOILERPLATE_TAG
   ├─ 有就拒绝
   └─ 防止递归 fork

constants/tools.ts:36-46：
   ├─ Agent 工具默认在所有 agent 的禁用集合里
   ├─ USER_TYPE === 'ant' 时例外
   └─ 默认禁止

forkSubagent.ts:73-89：
   ├─ 针对 fork child 有专门的递归保护
   └─ 多层防护

agentToolUtils.ts:100-110：
   ├─ teammate 场景下有特殊放行
   └─ 根据场景不同处理

不是简单的"禁止新的子 Agent"，而是：
   ├─ 多层防护
   ├─ 不同场景不同规则
   └─ 精细控制
```

### 7.5 Permission Bubbling

```
Permission Bubbling：

Fork Agent 的 permissionMode: 'bubble'（forkSubagent.ts:67）

含义：
   ├─ 子 Agent 的权限弹窗冒泡到父终端
   ├─ 用户在主终端里审批子 Agent 的操作
   └─ 不是子 Agent 自己处理权限

好处：
   ├─ 用户只需要关注主终端
   ├─ 子 Agent 的权限请求统一在主终端显示
   ├─ 简化用户交互
   └─ 统一权限管理
```

### 7.6 Async vs Sync

```
Async vs Sync：

教学版：
   ├─ 只展示同步子 Agent
   ├─ 父等着子跑完
   └─ 简单模型

CC 的异步路径：

AgentTool.tsx:686-764：
   ├─ run_in_background: true 时异步启动
   ├─ 返回 { status: 'async_launched' } 立即给父 Agent
   ├─ 子 Agent 完成后通过通知机制告知父 Agent
   └─ 不阻塞父 Agent

实际触发条件（不止 run_in_background）：
   ├─ run_in_background: true
   ├─ auto-background
   ├─ assistant force async
   ├─ coordinator/proactive
   └─ 多种路径

异步的好处：
   ├─ 父 Agent 可以继续工作
   ├─ 子 Agent 在后台执行
   ├─ 不阻塞
   └─ 提高效率

注意：
   ├─ 异步还是在同一个进程内
   ├─ 不是进程
   ├─ 只是异步执行
   └─ 留给 s13 详细讲解
```

### 7.7 教学版 vs CC 对比

```
教学版 vs CC 对比：

方面                教学版              CC
三种模式            一种               三种
上下文              全新 messages[]    全新或 cache-friendly
目的                简单隔离          简单隔离 + 性能优化
Prompt cache 共享   无                有
递归防护            无 task 工具       多层防护
权限处理            子 Agent 自己      Permission Bubbling
Async               无                有（run_in_background）
上下文粒度           完全隔离          readFileState 共享

教学版的简化是刻意的：
   ├─ 三种模式 → 一种（fresh messages）：概念清晰
   ├─ Prompt cache 共享 → 省略：教学版不涉及 API 层优化
   ├─ 递归 fork 防护 → 化为"子 Agent 无 task 工具"
   ├─ Async → 省略（留给 s13）：先理解同步模型
   └─ 目标：概念清晰，不是完整实现
```

---

## 八、总结

### 8.1 核心概念总结

```
Subagent 的核心概念：

问题 1：spawn_subagent 会创建子进程吗？
   答案：不会！
   ├─ spawn_subagent 是同一个进程内的函数调用
   ├─ 不创建子进程
   ├─ 不创建线程
   ├─ 不涉及进程间通信
   ├─ 只是创建新的 messages 数组
   ├─ "spawn" 是概念上的，不是操作系统级别的
   └─ 真正隔离的是 messages（上下文），不是进程

问题 2：上下文就是 messages 吗？
   答案：是的！完全正确！
   ├─ 上下文 = messages 数组
   ├─ 干净的上下文 = 空的 messages + 一条 description
   ├─ 实现：messages = [{"role": "user", "content": description}]
   ├─ 没有之前的对话历史
   ├─ 没有工具执行结果
   ├─ 没有其他干扰信息
   └─ 子 Agent 只看到这一个任务

问题 3：一个 Subagent 就是一个 Claude 实例吗？
   答案：部分正确，需要澄清！
   ├─ 正确：Subagent 是一个 Claude API 对话会话实例
   ├─ 澄清：不是 Claude 进程实例
   ├─ 澄清：不是 Claude 模型实例
   ├─ 澄清：不是 Claude 程序实例
   ├─ 正确说法："一个 Subagent = 一个 Claude API 对话会话实例"
   └─ 是"对话实例"，不是"物理实例"

设计精髓：
   ├─ "spawn" = 创建新的 messages，不是进程
   ├─ "上下文隔离" = 不同的 messages 数组
   ├─ "干净上下文" = 新的 messages 数组，只有 description
   ├─ "子 Agent" = 在新的 messages 内循环的 LLM
   ├─ "回传摘要" = 只返回文本，messages 丢弃
   ├─ "不污染主上下文" = 子 messages 不加入主 messages
   ├─ "Claude 实例" = Claude API 对话会话实例
   ├─ 物理层面：一个程序、一个进程、一个模型
   ├─ 对话层面：多个 Claude API 对话会话（多个 messages）
   └─ 全部是 messages 的操作，不是进程
```

### 8.2 三个关键设计决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 上下文隔离 | 全新 messages[] | 子 Agent 的中间过程不污染主 Agent 的上下文 |
| 只回传结论 | extract_text(last_message) | 不是回传整个 messages 列表 |
| 禁止递归 | 子 Agent 无 task 工具 | 防止子 Agent 再 spawn 新的子 Agent |
| 安全策略不跳过 | 子 Agent 工具调用也走 hook | 上下文隔离不代表权限隔离 |

### 8.3 物理层面 vs 对话层面

| 层面 | 数量 | 内容 |
|------|------|------|
| **物理层面** | **1 个** | Claude Code CLI 程序、Python 进程、Claude 模型 |
| **对话层面** | **多个** | 主 Agent + 多个 Subagent（多个 messages 数组） |

---

## 九、参考资料

- [s06_subagent/README.md](./README.md) — 原始教材
- Claude Code 源码：
  - `AgentTool.tsx:686-764` — Agent 工具实现
  - `forkSubagent.ts:60-71` — Fork Subagent 模式
  - `forkedAgent.ts:57-68` — Forked Agent
  - `forkedAgent.ts:345-462` — createSubagentContext
  - `forkSubagent.ts:78-89` — isInForkChild（递归防护）
  - `forkSubagent.ts:107-168` — buildForkedMessages
  - `constants/tools.ts:36-46` — Agent 工具禁用规则

---

<!-- 文档版本：v1.0 -->
<!-- 创建时间：2026-06-21 -->
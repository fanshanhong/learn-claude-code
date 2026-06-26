# s10: System Prompt — 运行时组装，不硬编码

## 目录

- [一、宏观思想：从硬编码到运行时组装](#一宏观思想从硬编码到运行时组装)
- [二、架构设计：四层架构](#二架构设计四层架构)
- [三、context 的详细解析](#三context-的详细解析)
- [四、实现细节](#四实现细节)
- [五、memory 的两层分离设计](#五memory-的两层分离设计)
- [六、CC 的真实实现（教学版 vs 生产级）](#六cc-的真实实现教学版-vs-生产级)
- [七、完整流程图](#七完整流程图)
- [八、总结](#八总结)

---

## 一、宏观思想：从硬编码到运行时组装

### 问题：硬编码的三大痛点

从 s01 到 s09，system prompt 都是一行硬编码：

```python
# s01-s09 的硬编码方式
SYSTEM = f"You are a coding agent at {WORKDIR}. Use tools to solve tasks."
```

但随着 Agent 能力增加（记忆、压缩、技能加载），prompt 该提的能力越来越多：

```python
# 问题：不断追加，越来越长
SYSTEM = (
    f"You are a coding agent at {WORKDIR}. "
    "Use tools to solve tasks. Act, don't explain. "
    "Before starting any multi-step task, use todo_write. "
    "Skills are available via list_skills and load_skill. "
    "Relevant memories are injected below when available. "
    # ... 加一个能力就多一段
)
```

**三大痛点：**

| 痛点 | 具体问题 | 影响 |
|------|---------|------|
| **换项目要重写整个 prompt** | 不知道哪些该改、哪些该留 | 维护成本高 |
| **修改一处可能影响全局** | 加一段工具描述可能跟前面的指令冲突 | 稳定性差 |
| **每次请求都带全部内容** | 当前对话用不到某些段落也浪费 token | 成本高、噪音多 |

### 解决思路：运行时组装

```
核心理念："prompt 是组装出来的，不是写死的"

设计原则：
1. 分段化：把一大段字符串拆成独立的段落
2. 按需加载：根据真实状态决定加载哪些段落
3. 缓存机制：避免重复组装，命中 API-level cache

结果：
- 修改一个段落不影响其他段落
- 不浪费 token（只加载需要的）
- 可以命中 prompt cache（稳定部分）
```

---

## 二、架构设计：四层架构

### 架构图

```
┌─────────────────────────────────────────────────────────┐
│                      agent_loop                          │
│  每轮开始：get_system_prompt(context)                    │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│              get_system_prompt(context)                  │
│  缓存 wrapper：检测 context 变化                         │
│  ├─> context 未变 → 返回缓存                            │
│  └─> context 变化 → 调用 assemble_system_prompt        │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│           assemble_system_prompt(context)                │
│  按需拼接：根据 context 选择段落                         │
│  ├─> 始终加载：identity, tools, workspace              │
│  └─> 按需加载：memory（如果 MEMORY.md 存在）            │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│              PROMPT_SECTIONS（分段定义）                  │
│  字典结构：每个 key 是一个独立的段落                     │
│  {                                                       │
│    "identity": "You are a coding agent...",             │
│    "tools": "Available tools: bash...",                 │
│    "workspace": f"Working directory: {WORKDIR}",        │
│    "memory": "Relevant memories...",                    │
│  }                                                       │
└─────────────────────────────────────────────────────────┘

        ▲
        │
        │ 真实状态
        │
┌─────────────────────────────────────────────────────────┐
│              update_context(messages)                    │
│  收集真实状态：工具、文件、目录                          │
│  {                                                       │
│    "enabled_tools": ["bash", "read_file", ...],         │
│    "workspace": "/path/to/workdir",                     │
│    "memories": "MEMORY.md 内容（如果存在）",            │
│  }                                                       │
└─────────────────────────────────────────────────────────┘
```

### 四层架构详解

#### 第 1 层：PROMPT_SECTIONS（分段定义）

```python
# 第42-47 行
PROMPT_SECTIONS = {
    "identity": "You are a coding agent. Act, don't explain.",
    "tools": "Available tools: bash, read_file, write_file.",
    "workspace": f"Working directory: {WORKDIR}",
    "memory": "Relevant memories are injected below when available.",
}
```

**设计理念：**
- 每个 section 是独立的段落
- 修改一个不影响其他
- 易于维护和扩展

**四类 section：**

| Section | 加载策略 | 内容 | 为什么这么分？ |
|---------|---------|------|--------------|
| **identity** | 始终 | Agent 身份、工作方式 | 每轮都需要知道"你是谁" |
| **tools** | 始终 | 可用工具列表 | 每轮都需要知道"能做什么" |
| **workspace** | 始终 | 工作目录 | 每轮都需要知道"在哪工作" |
| **memory** | 按需 | 相关记忆内容 | 只有有记忆时才需要 |

#### 第 2 层：assemble_system_prompt（按需拼接）

```python
# 第 50-64 行
def assemble_system_prompt(context: dict) -> str:
    sections = []

    # 始终加载
    sections.append(PROMPT_SECTIONS["identity"])
    sections.append(PROMPT_SECTIONS["tools"])
    sections.append(PROMPT_SECTIONS["workspace"])

    # 按需加载 — 基于真实状态，不是关键词
    memories = context.get("memories", "")
    if memories:
        sections.append(f"Relevant memories:\n{memories}")

    return "\n\n".join(sections)
```

**设计理念：**
- 始终加载：每轮都需要的（identity、tools、workspace）
- 按需加载：特定条件下才需要的（memory）
- 基于**真实状态**判断，不是关键词猜测

**为什么要按需加载？**

```
假设有 50 个记忆文件（MEMORY.md 有 50 行）：

全加载：
system prompt = identity + tools + workspace + memory（50 行）
= ~10KB 文本
= 每轮都浪费 token（如果当前对话不需要记忆）

按需加载：
system prompt = identity + tools + workspace
= ~3KB 文本
= 只有有记忆时才加载 memory section
= 节省 token，减少噪音
```

#### 第 3 层：get_system_prompt（缓存 wrapper）

```python
# 第71-92 行
def get_system_prompt(context: dict) -> str:
    global _last_context_key, _last_prompt
    key = json.dumps(context, sort_keys=True, ensure_ascii=False, default=str)
    if key == _last_context_key and _last_prompt:
        print("  \033[90m[cache hit] system prompt unchanged\033[0m")
        return _last_prompt
    _last_context_key = key
    _last_prompt = assemble_system_prompt(context)

    loaded = ["identity", "tools", "workspace"]
    if context.get("memories"):
        loaded.append("memory")
    print(f"  \033[32m[assembled] sections: {', '.join(loaded)}\033[0m")
    return _last_prompt
```

**设计理念：**
- 避免**重复拼接**字符串（开销浪费）
- 使用 `json.dumps` 作为 cache key（确定性序列化）
- context 未变时返回缓存

#### 第 4 层：update_context（真实状态）

```python
# 第156-167 行
def update_context(context: dict, messages: list) -> dict:
    memories = ""
    if MEMORY_INDEX.exists():  # ← 检查文件是否存在
        content = MEMORY_INDEX.read_text().strip()
        if content:
            memories = content
    return {
        "enabled_tools": list(TOOL_HANDLERS.keys()),  # 实际注册的工具
        "workspace": str(WORKDIR),  # 实际工作目录
        "memories": memories,  # 实际记忆内容（如果存在）
    }
```

**设计理念：**
- 反映**真实状态**，不是关键词猜测
- 检查文件是否存在（MEMORY_INDEX.exists()）
- 检查工具是否注册（TOOL_HANDLERS.keys()）

---

## 三、context 的详细解析

### context 的结构

**context 是一个 Python 字典，包含三个键：**

```python
context = {
    "enabled_tools": ["bash", "read_file", "write_file"],  # 实际注册的工具列表
    "workspace": "/Users/yichen/cainiao/AI/workspace/learn-claude-code",  # 实际工作目录
    "memories": "MEMORY.md 的内容（如果存在）",  # 实际记忆内容
}
```

**详细结构解析：**

| 键 | 类型 | 内容 | 来源 | 作用 |
|---|------|------|------|------|
| **enabled_tools** | `list[str]` | 实际注册的工具名称列表 | `TOOL_HANDLERS.keys()` | 决定加载哪些工具描述 |
| **workspace** | `str` | 实际工作目录的绝对路径 | `WORKDIR` | 注入到 workspace section |
| **memories** | `str` | MEMORY.md 的完整内容（如果存在） | `MEMORY_INDEX.read_text()` | 决定是否加载 memory section |

### context 的内容：真实状态

```
context 的内容来自三个真实状态：

1. enabled_tools：
   来源：TOOL_HANDLERS.keys()
   意义：实际注册的工具（不是硬编码的工具列表）
   示例：["bash", "read_file", "write_file"]

2. workspace：
   来源：WORKDIR（Path.cwd()）
   意义：实际工作目录（不是硬编码的路径）
   示例："/Users/yichen/cainiao/AI/workspace/learn-claude-code"

3. memories：
   来源：MEMORY_INDEX.exists() + read_text()
   意义：MEMORY.md 的实际内容（如果文件存在）
   示例："- [user-preference-tabs](...) — User prefers tabs..."
```

**为什么叫"真实状态"？**

```
对比：

错误做法：硬编码状态
context = {
    "enabled_tools": ["bash", "read", "write"],  # ← 硬编码
    "workspace": "/hardcoded/path",  # ← 硬编码
    "memories": "hardcoded memories",  # ← 硬编码
}

问题：
- 工具可能动态注册/注销
- 工作目录可能变化
- MEMORY.md 可能不存在

正确做法：真实状态（s10）
context = {
    "enabled_tools": list(TOOL_HANDLERS.keys()),  # ← 实际注册的工具
    "workspace": str(WORKDIR),  # ← 实际工作目录
    "memories": MEMORY_INDEX.read_text() if exists,  # ← 实际文件内容
}

优点：
- 反映当前运行态的真实状态
- 不是猜测或硬编码
- 动态更新
```

### 双层循环结构

```
外层循环（main）：多次对话
  ├─> 每次对话是一个独立的用户输入
  └─> while True: history.append(user_input)

内层循环（agent_loop）：一次对话的多次思考和工具调用
  ├─> 每次思考：LLM 调用 → assistant 消息
  ├─> 每次工具调用：tool_use → tool_result
  └─> while True: response = client.messages.create(...)
```

### 三次 update_context 调用的时机和必要性

#### 调用 1：程序启动时（第204 行）- 初始化

```python
# 第204 行
context = update_context({}, [])
```

**时机：**
- 程序启动时
- main 循环开始前
- 第一轮对话前

**作用：**
- 初始化 context（第一次创建）
- 收集初始真实状态

**必要性：**

```
问题：如果没有初始化，会怎样？

假设没有 update_context({}, []):
  ├─> context 不存在
  ├─> get_system_prompt(context) 报错
  └─> 无法组装 system prompt

必要性：
  ├─> 必须有初始 context
  ├─> 收集初始真实状态（工具、目录、文件）
  └─> 第一次对话需要 system prompt
```

#### 调用 2：工具执行后（第196 行）- 检测变化

```python
# 第196 行（agent_loop 内部）
context = update_context(context, messages)
system = get_system_prompt(context)
```

**时机：**
- 工具执行后
- messages 添加了 tool_result 后
- 下一轮 LLM 调用前

**作用：**
- 检查工具执行是否改变了真实状态
- 如果状态变化，重新组装 system prompt

**必要性：**

```
问题：如果工具执行后不更新，会怎样？

场景：用户创建 MEMORY.md

工具执行前：
  ├─> context["memories"] = ""（文件不存在）
  ├─> system = identity + tools + workspace（无 memory）
  └─> LLM 不知道有记忆可用

工具执行：write_file(".memory/MEMORY.md", ...)
  ├─> 文件已创建！

工具执行后（如果不更新）：
  ├─> context["memories"]仍然 = ""（过期状态）
  ├─> system仍然 = identity + tools + workspace（无 memory）
  └─> LLM 不知道文件已创建（信息过时）

工具执行后（如果更新）：
  ├─> context["memories"] = "..."（最新状态）
  ├─> system = identity + tools + workspace + memory（有 memory）
  ├─> LLM 知道文件已创建
  └─>下一轮思考可以利用记忆

必要性：
  ├─> 工具执行是最可能改变状态的时机
  ├─> 不更新会导致 context 过时
  ├─> system prompt 反映过时状态
  └─> LLM 基于错误信息思考
```

#### 调用 3：agent_loop 结束后（第214 行）- 为下一轮准备

```python
# 第214 行
context = update_context(context, history)
```

**时机：**
- agent_loop 结束后
- 对话完成后（stop_reason != "tool_use"）
- 下一轮用户输入前

**作用：**
- 更新 context（反映对话中的变化）
- 为下一轮对话做准备

**必要性：**

```
问题：如果 agent_loop 结束后不更新，会怎样？

必要性：
  ├─> 对话可能改变状态（虽然工具执行后已更新）
  ├─> 显式确认状态，避免遗漏
  ├─> 为下一轮对话做准备
  └─> 确保 context 始终反映真实状态
```

### 为什么不在 agent_loop 前更新？

```
agent_loop 前不需要更新：

原因分析：

1. context 已经是最新的：
   ├─> 程序启动时已初始化（第204 行）
   ├─> 或上一轮对话结束后已更新（第214 行）
   └─> context 已经反映真实状态，不需要再次更新

2. 用户输入不会改变状态：
   ├─> 用户只是输入文本
   ├─> 不会创建文件、不会注册工具
   ├─> context 不需要更新
   └─> 直接使用已有的 context

3. 更新时机在"状态可能变化"时：
   ├─> 工具执行：最可能改变状态（如创建文件）
   ├─> 对话结束：可能改变状态
   ├─> 用户输入：不会改变状态（无需更新）
   └─> agent_loop 前：context 已经最新（无需更新）
```

### context 在架构中的位置：核心枢纽

```
作用：
1. 连接真实状态和 system prompt
   ├─> 收集真实状态（update_context）
   └─> 组装 system prompt（assemble_system_prompt）

2. 触发缓存机制
   ├─> 序列化为 cache key（get_system_prompt）
   └─> 检测 context 变化

3. 动态更新
   ├─> 程序启动时初始化
   ├─> 对话后更新
   └─> 工具执行后更新
```

**数据流向：**

```
真实状态 → context → system prompt

流程：
1. update_context()
   ├─> 检查文件是否存在（MEMORY_INDEX.exists()）
   ├─> 检查工具是否注册（TOOL_HANDLERS.keys()）
   ├─> 检查工作目录（WORKDIR）
   └─> 返回 context = {enabled_tools, workspace, memories}

2. get_system_prompt(context)
   ├─> 序列化 context（json.dumps）
   ├─> 检查缓存
   └─> 返回 system prompt

3. assemble_system_prompt(context)
   ├─> 使用 context["workspace"] 注入 workspace section
   ├─> 使用 context["memories"] 注入 memory section
   └─> 返回拼接结果

4. LLM 调用
   └─> system = system prompt（基于 context 组装）
```

---

## 四、实现细节

### 缓存机制的实现

```python
# 全局变量保存缓存
_last_context_key = None
_last_prompt = None

def get_system_prompt(context: dict) -> str:
    global _last_context_key, _last_prompt

    # 序列化 context 作为 key
    key = json.dumps(context, sort_keys=True, ensure_ascii=False, default=str)

    # 检查缓存
    if key == _last_context_key and _last_prompt:
        print("  [cache hit] system prompt unchanged")
        return _last_prompt

    # 缓存未命中，重新组装
    _last_context_key = key
    _last_prompt = assemble_system_prompt(context)

    return _last_prompt
```

**为什么用 json.dumps 而不是 hash()？**

```python
# 问题：Python hash() 的局限
hash(context)  # ← 会报错！

原因：
1. 进程随机化：Python hash() 有随机种子，不同进程 hash 值不同
2. Unhashable type：dict/list 不能直接 hash
   >>> hash({"a": 1})  # TypeError: unhashable type: 'dict'

解决方案：json.dumps
key = json.dumps(context, sort_keys=True, ensure_ascii=False, default=str)

优点：
1. 确定性：序列化结果稳定（sort_keys=True）
2. 支持所有类型：dict/list 都能序列化
3. 可比较：字符串可以直接比较
```

### agent_loop 中的使用

```python
# 第172-198 行
def agent_loop(messages: list, context: dict):
    system = get_system_prompt(context)  # ← 获取组装的 prompt

    while True:
        response = client.messages.create(
            model=MODEL, system=system, messages=messages,
            tools=TOOLS, max_tokens=8000
        )
        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason != "tool_use":
            return

        # 工具执行
        results = []
        for block in response.content:
            if block.type != "tool_use":
                continue
            handler = TOOL_HANDLERS.get(block.name)
            output = handler(**block.input)
            results.append({"type": "tool_result", "tool_use_id": block.id, "content": output})
        messages.append({"role": "user", "content": results})

        # 重新评估 context 和 prompt
        context = update_context(context, messages)  # ← 更新真实状态
        system = get_system_prompt(context)  # ← 可能重新组装
```

**关键流程：**

```
agent_loop：
  │
  ├─> 第 1 步：获取 system prompt
  │     └─> system = get_system_prompt(context)
  │
  ├─> 第 2 步：LLM 调用
  │     └─> response = client.messages.create(system=system, ...)
  │
  ├─> 第 3 步：工具执行
  │     ├─> 执行 tool_use
  │     └─> messages.append({"role": "user", "content": results})
  │
  ├─> 第 4 步：重新评估 context
  │     └─> context = update_context(context, messages)
  │           └─> 检查 MEMORY.md 是否存在
  │           └─> 检查工具是否注册
  │
  └─> 第 5 步：可能重新组装 prompt
        └─> system = get_system_prompt(context)
              ├─> context 未变 → 返回缓存
              └─> context 变化 → 重新组装
```

**为什么要每轮重新评估？**

```
场景：用户创建记忆文件

第 1 轮：用户输入 "Create MEMORY.md"
- context["memories"] = ""（文件不存在）
- system = identity + tools + workspace

工具执行：write_file(".memory/MEMORY.md", ...)

第 2 轮：
- update_context() 检查文件存在
- context["memories"] = "..."（文件已存在）
- system = identity + tools + workspace + memory（重新组装）

结果：自动加载 memory section
```

### 始终加载 vs 按需加载的策略

```python
# 第54-62 行
def assemble_system_prompt(context: dict) -> str:
    sections = []

    # 始终加载（每轮都需要）
    sections.append(PROMPT_SECTIONS["identity"])
    sections.append(PROMPT_SECTIONS["tools"])
    sections.append(PROMPT_SECTIONS["workspace"])

    # 按需加载（特定条件下才需要）
    memories = context.get("memories", "")
    if memories:  # ← 基于真实状态判断
        sections.append(f"Relevant memories:\n{memories}")

    return "\n\n".join(sections)
```

**策略分析：**

| Section | 加载策略 | 判断依据 | 为什么？ |
|---------|---------|---------|---------|
| **identity** | 始终 | 无（始终存在） | Agent 必须知道身份 |
| **tools** | 始终 | enabled_tools | Agent 必须知道可用工具 |
| **workspace** | 始终 | 无（始终存在） | Agent 必须知道工作目录 |
| **memory** | 按需 | MEMORY.md 存在 | 只有有记忆时才需要 |

---

## 五、memory 的两层分离设计

### s09 的完整流程（结合 s10）

```
s09 的 memory 处理流程：

1. MEMORY.md 索引（放入 SYSTEM prompt）：
   ├─> build_system() 读MEMORY.md
   ├─> system = "你是 coding agent...\n\nMemories available:\n{MEMORY.md 内容}"
   └─> 常驻 SYSTEM prompt（可以被 cache）

2. 记忆文件内容（放入 messages）：
   ├─> load_memories(messages)
   ├─> select_relevant_memories(messages)  # LLM 选择相关记忆
   ├─> read_memory_file(filename)  # 读完整记忆文件
   ├─> memories_content = "<relevant_memories>...\n\n完整内容..."
   └─> 注入到 user message 前面：
         request_messages[memory_turn] = {
             "content": memories_content + "\n\n" + 原始用户输入
         }
```

### s10 简化了什么？

```
s10 的简化：

s10 只关注"动态拼接 memory section 到 SYSTEM prompt"
s10 不关心"记忆文件内容的按需加载"

s10 的 memory 处理：
  ├─> assemble_system_prompt(context)
  ├─> if context["memories"]:  # 如果 MEMORY.md 存在
  │     sections.append(f"Relevant memories:\n{memories}")
  └─> 注入到 SYSTEM prompt

注意：s10 只注入 MEMORY.md 的索引，不注入记忆文件的完整内容
记忆文件的完整内容仍然是 s09 的逻辑（在 messages 中）
```

### 完整架构（s09 + s10）

```
完整的 memory 处理（s09 + s10 结合）：

SYSTEM prompt（s10）：
  ├─> identity section
  ├─> tools section
  ├─> workspace section
  ├─> memory section（MEMORY.md 索引）
  │     └─> "Relevant memories:\n- [user-preference-tabs](...) — ..."
  └─> 紧凑、可以被 cache

messages（s09）：
  ├─> user message:
  │     ├─> memories_content（选中的记忆文件完整内容）
  │     │     └─> "<relevant_memories>\n---\nname: ...\n完整正文\n---\n..."
  │     ├─> 原始用户输入
  │     └─> 按需加载，不破坏 cache
  └─> assistant message
  └─> tool_result message

关键分离：
  ├─> MEMORY.md 索引 → SYSTEM prompt（常驻，可 cache）
  ├─> 记忆文件完整内容 → messages（按需，不破坏 cache）
  └─> 两者分工明确
```

### 分离的好处

```
分离的好处：

1. SYSTEM prompt 紧凑（节省 token）
   ├─> 只包含 MEMORY.md 索引（一行一个链接）
   ├─> 不包含记忆文件的完整内容
   └─> token 开销小

2. 可以被 cache（效率）
   ├─> SYSTEM prompt 内容稳定
   ├─> 不频繁变化
   └─> 可以命中 prompt cache

3. 按需加载完整内容（不浪费）
   ├─> 只加载相关的记忆文件（最多5 个）
   ├─> 不是全部加载
   └─> 不浪费 token

4. 不破坏 cache（稳定性）
   ├─> 记忆文件内容注入到 messages（user message）
   ├─> 不修改 SYSTEM prompt
   └─> SYSTEM prompt 的 cache 保持有效
```

---

## 六、CC 的真实实现（教学版 vs 生产级）

### 教学版的简化

| 教学版 | CC 真实实现 |
|-------|------------|
| 4 个 section | 20+ 个 section（受 feature flag 影响） |
| 单层缓存（进程内） | 三层缓存（进程内 + section 注册 + API-level） |
| json.dumps 作为 key | lodash memoize + cache scope |
| 无 dynamic boundary | SYSTEM_PROMPT_DYNAMIC_BOUNDARY 分隔静态/动态 |

### CC 的三层缓存机制

```
CC 的三层缓存：

1. lodash memoize（进程内）
   - getSystemContext 和 getUserContext 在会话中缓存
   - 类似教学版的 json.dumps 缓存

2. section 注册缓存（会话级）
   - STATE.systemPromptSectionCache 缓存动态 section 结果
   - /clear 或 /compact 时清除

3. API-level 缓存（跨会话）
   - splitSysPromptPrefix() 按 boundary 分成不同 cache scope
   - 静态 section 合并成一个 global cache block
   - 动态 section 不使用 global cache（cacheScope: null）
```

### CC 的 SYSTEM_PROMPT_DYNAMIC_BOUNDARY

```
CC 的 prompt 组装：

静态 section（始终加载，可命中 global cache）：
- identity
- system
- doing_tasks
- actions
- using_tools
- tone_style
- output_efficiency

SYSTEM_PROMPT_DYNAMIC_BOUNDARY  ← 分隔线

动态 section（按状态加载，不使用 global cache）：
- session_guidance
- memory
- ant_model_override
- env_info_simple
- language
- output_style
- mcp_instructions（易失性）
- ...

结果：
- 静态部分命中 global cache（跨会话保留）
- 动态部分不命中 global cache（每轮重新组装）
- 缓存效率最大化
```

### CC 的 getUserContext vs getSystemContext

| | getSystemContext | getUserContext |
|---|---|---|
| **内容** | gitStatus、cacheBreaker | CLAUDE.md 内容、currentDate |
| **注入方式** | 追加到 system prompt 数组 | 前置为 `<system-reminder>` 用户消息 |
| **何时跳过** | 自定义 system prompt 时 | 始终运行 |

---

## 七、完整流程图

### 时间线详解

```
时间点1：程序启动（第一次对话前）
  ├─> context = update_context({}, [])  # 第204 行
  ├─> context = {
  │     "enabled_tools": ["bash", "read_file", "write_file"],
  │     "workspace": "/path/to/workdir",
  │     "memories": ""（MEMORY.md 不存在）
  │   }
  └─> 作用：初始化真实状态，第一次组装 system prompt

时间点 2：用户输入（外层循环）
  ├─> query = input("s10 >> ")
  ├─> history.append({"role": "user", "content": query})
  └─> 注意：这里没有更新 context！

时间点 3：agent_loop 开始（内层循环）
  ├─> agent_loop(history, context)  # 第213 行
  ├─> system = get_system_prompt(context)  # 使用已有的 context
  └─> 注意：不是更新 context，而是传入已有的 context

时间点 4：第一次 LLM 调用（思考）
  ├─> response = client.messages.create(system=system, ...)
  ├─> messages.append({"role": "assistant", "content": [tool_use]})
  └─> 还没有更新 context

时间点 5：工具执行
  ├─> run_write(".memory/MEMORY.md", ...)
  ├─> messages.append({"role": "user", "content": [tool_result]})
  ├─> MEMORY.md 文件已创建！

时间点 6：工具执行后更新 context（第一次更新）
  ├─> context = update_context(context, messages)  # 第196 行
  ├─> 检查 MEMORY_INDEX.exists() → True（文件已存在）
  ├─> context = {
  │     "enabled_tools": [...],
  │     "workspace": "...",
  │     "memories": "..."（有内容！）
  │   }
  ├─> system = get_system_prompt(context)  # 重新组装
  └─> 作用：检测工具执行后的状态变化，更新 system prompt

时间点 7：第二次 LLM 调用（思考）
  ├─> response = client.messages.create(system=system, ...)  # 使用新的 system
  ├─> messages.append({"role": "assistant", "content": "文件已创建"})
  └─> stop_reason != "tool_use"，对话结束

时间点 8：agent_loop 结束
  └─> return

时间点 9：agent_loop 结束后更新 context（第二次更新）
  ├─> context = update_context(context, history)  # 第214 行
  ├─> context = {..., "memories": "..."}（内容不变）
  ├─> system = get_system_prompt(context)
  ├─> [cache hit] system prompt unchanged  # context 未变
  └─> 作用：检测对话后的状态变化，为下一轮对话做准备

时间点 10：等待下一轮用户输入（外层循环继续）
  ├─> query = input("s10 >> ")
  └─> 重复时间点 2-9...
```

### 数据流向

```
真实状态 → context → system prompt

流程：
1. update_context()
   ├─> 检查文件是否存在（MEMORY_INDEX.exists()）
   ├─> 检查工具是否注册（TOOL_HANDLERS.keys()）
   ├─> 检查工作目录（WORKDIR）
   └─> 返回 context = {enabled_tools, workspace, memories}

2. get_system_prompt(context)
   ├─> 序列化 context（json.dumps）
   ├─> 检查缓存
   └─> 返回 system prompt

3. assemble_system_prompt(context)
   ├─> 使用 context["workspace"] 注入 workspace section
   ├─> 使用 context["memories"] 注入 memory section
   └─> 返回拼接结果

4. LLM 调用
   └─> system = system prompt（基于 context 组装）
```

---

## 八、总结

### 设计理念

```
"prompt 是组装出来的，不是写死的"

三层设计：
1. 分段化（PROMPT_SECTIONS）
   - 每个段落独立维护
   - 修改不影响其他

2. 按需加载
   - 始终加载：每轮都需要
   - 按需加载：特定条件下才需要
   - 基于**真实状态**判断（文件是否存在）

3. 缓存机制
   - 避免重复拼接（进程内缓存）
   - 命中 API-level cache（CC 的三层缓存）
```

### 解决的问题

| 问题 | s01-s09（硬编码） | s10（运行时组装） |
|------|------------------|------------------|
| 换项目要重写整个 prompt | 不知道哪些该改、哪些该留 | 只改相关段落 |
| 修改一处可能影响全局 | 加一段可能跟前面冲突 | 段落独立，不冲突 |
| 每次请求都带全部内容 |浪费 token、噪音多 | 按需加载，节省 token |

### context 的核心作用

```
context 的三大作用：

作用 1：真实状态的容器
  ├─> 收集真实状态（enabled_tools, workspace, memories）
  ├─> 不是硬编码，不是猜测
  └─> 反映当前运行态的真实状态

作用 2：system prompt 组装的依据
  ├─> 根据 context 决定加载哪些 section
  ├─> context["memories"] != "" → 加载 memory section
  └─> context["enabled_tools"] → 决定 tools section 内容

作用 3：缓存机制的核心
  ├─> 序列化为 cache key（json.dumps）
  ├─> 检测 context 变化
  └─> context 未变 → 缓存命中
```

### 三次 update_context 的必要性

```
三层 update_context 的必要性：

第 1 层：程序启动（初始化）
  ├─> 必须有初始 context
  ├─> 第一次对话需要 system prompt
  └─> 无此步骤 → 无法运行

第 2 层：工具执行后（检测变化）
  ├─> 工具执行是最可能改变状态的时机
  ├─> 不更新 → context 过时 → system prompt 过时
  ├─> LLM 基于错误信息思考
  └─> 无此步骤 → 信息不一致

第 3 层：对话结束后（为下一轮准备）
  ├─> 对话可能改变状态
  ├─>下一轮需要最新 context
  ├─> 显式确认状态，避免遗漏
  └─> 无此步骤 → 可能遗漏状态变化

设计理念：
  ├─> 在"状态可能变化"的时机立即检查
  ├─> 保证 context 始终反映真实状态
  ├─> 保证 system prompt 始终反映真实状态
  └─> 避免使用过时信息
```

### memory 的两层分离

```
memory 的两层分离：

第 1 层：MEMORY.md 索引（s10）
  ├─> 放入 SYSTEM prompt
  ├─> 紧凑、常驻、可 cache
  └─> 作用：让 LLM 知道"有哪些记忆可用"

第 2 层：记忆文件完整内容（s09）
  ├─> 放入 messages（user message 前）
  ├─> 按需加载、不破坏 cache
  └─> 作用：提供完整细节

分离的好处：
  ├─> SYSTEM prompt 紧凑（节省 token）
  ├─> 可以被 cache（效率）
  ├─> 按需加载完整内容（不浪费）
  └─> 不破坏 cache（稳定性）
```

### CC 的真实实现更复杂

```
教学版：简化版（4 个 section，单层缓存）
CC：生产级（20+ section，三层缓存，dynamic boundary）

关键差异：
- CC 有 SYSTEM_PROMPT_DYNAMIC_BOUNDARY（分隔静态/动态）
- CC 有三层缓存（进程内 + section 注册 + API-level）
- CC 有更多 section（受 feature flag、output style、KAIROS 等影响）
```
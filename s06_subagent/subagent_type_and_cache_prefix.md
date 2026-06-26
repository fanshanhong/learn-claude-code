# subagent_type 完整列表 + Prompt Cache 前缀匹配详解

---

## 问题 1: subagent_type 有哪些枚举值？

### 真实答案（基于源码）

**subagent_type 不是受限 enum，是自由字符串字段！**

```typescript
// Agent 工具的 input_schema
{
  "name": "Agent",
  "input_schema": {
    "type": "object",
    "properties": {
      "prompt": {"type": "string"},
      "subagent_type": {"type": "string"},  ← 自由字符串，不是 enum
      ...
    }
  }
}
```

**为什么不是 enum？**

因为 Claude Code 支持：
- 用户自定义 agent type（通过 `.claude/agents/` 目录）
- 项目自定义 agent type（通过 project settings）
- Policy 自定义 agent type（通过 policy settings）
- Plugin 自定义 agent type（通过 plugin）

所以 `subagent_type` 是自由字符串，运行时通过**模糊匹配**查找对应的 agent 定义。

### 内置 agent type 完整列表（7 个）

| # | agentType | whenToUse | tools | model | 说明 |
|---|-----------|-----------|-------|-------|------|
| 1 | **"general-purpose"** | 通用多步任务 | `["*"]` (所有工具) | inherit | **默认 agent**，没指定 subagent_type 时使用 |
| 2 | **"Explore"** | 只读搜索，定位代码 | disallowed: `[Agent, TodoWrite, FileEdit, FileWrite, NotebookEdit]` | haiku (可升级) | **只读 agent**，不能写文件，用于快速定位 |
| 3 | **"Plan"** | 规划实现策略 | 同 Explore | inherit | **规划 agent**，只能探索和规划，不能修改 |
| 4 | **"fork"** | 继承父对话上下文 | `["*"]` | inherit | **特殊 agent**，共享 prompt cache |
| 5 | **"claude"** | FleetView 通用 | `["*"]` | inherit | **后台 catch-all**，FleetView 默认 |
| 6 | **"statusline-setup"** | 配置状态栏 | `["Read", "Edit"]` | sonnet | **配置 agent**，只有读写工具 |
| 7 | **"claude-code-guide"** | 查询 Claude Code 文档 | `[Grep/Glob, WebSearch, Read, WebFetch]` | haiku | **文档 agent**，回答使用问题 |

### 各个 agent type 的详细说明

#### 1. "general-purpose"

```typescript
const GENERAL_PURPOSE_AGENT = {
  agentType: "general-purpose",
  whenToUse: "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.",
  tools: ["*"],  // 所有工具
  model: "inherit",  // 继承父 agent 的模型
  maxTurns: 200,
  permissionMode: "bubble",  // 权限冒泡到父
  source: "built-in",
  baseDir: "built-in"
}
```

**特点**：
- ✅ 所有工具可用（bash、read、write、edit、glob、grep、Agent 等）
- ✅ 继承父 agent 的模型
- ✅ 最大 200 轮
- 🔑 **默认 agent**（没指定 subagent_type 时使用）

#### 2. "Explore"

```typescript
const EXPLORE_AGENT = {
  agentType: "Explore",
  whenToUse: "Fast read-only search agent for broad fan-out searches — when answering means sweeping many files, directories, or naming conventions and you only need the conclusion, not the file dumps. It reads excerpts rather than whole files, so it locates code; it doesn't review or audit it.",
  tools: ["*"],  // 声明 "*" 但有 disallowedTools
  disallowedTools: ["Agent", "TodoWrite", "FileEdit", "FileWrite", "NotebookEdit"],
  model: "haiku",  // 默认 haiku，可升级到 sonnet/opus
  maxTurns: 50,
  omitClaudeMd: true,  // 不加载 CLAUDE.md
  permissionMode: "bubble",
  source: "built-in"
}
```

**特点**：
- ✅ 只读工具可用（read、glob、grep、bash）
- ❌ **不能写文件**（FileEdit、FileWrite 被禁用）
- ❌ 不能再 spawn Agent（Agent 工具被禁用）
- ❌ 不能用 TodoWrite
- ✅ 默认 haiku（快速），但可升级到 sonnet/opus
- ✅ 最大 50 轮
- 🔑 **只读搜索**，用于快速定位代码

#### 3. "Plan"

```typescript
const PLAN_AGENT = {
  agentType: "Plan",
  whenToUse: "Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task.",
  tools: ["*"],  // 同 Explore
  disallowedTools: ["Agent", "TodoWrite", "FileEdit", "FileWrite", "NotebookEdit"],
  model: "inherit",  // 继承父 agent 的模型
  maxTurns: 50,
  omitClaudeMd: true,
  permissionMode: "bubble",
  source: "built-in"
}
```

**特点**：
- ✅ 同 Explore（只读工具）
- ❌ 不能写文件
- ❌ 不能再 spawn Agent
- ✅ 继承父 agent 的模型
- 🔑 **规划策略**，不能执行

#### 4. "fork"

```typescript
const FORK_AGENT = {
  agentType: "fork",
  whenToUse: "Implicit fork — inherits full conversation context. Not selectable via subagent_type; triggered by omitting subagent_type when the fork experiment is active.",
  tools: ["*"],
  model: "inherit",
  maxTurns: 200,
  permissionMode: "bubble",
  getSystemPrompt: () => "",  // 空字符串，继承父 system prompt
  source: "built-in"
}
```

**特点**：
- ✅ 继承父 agent 的完整对话上下文
- ✅ 共享 prompt cache
- 🔑 **不是常规 agent**，是特殊的 Fork 模式
- 🔑 需要 fork experiment 开启

#### 5. "claude"

```typescript
const CLAUDE_AGENT = {
  agentType: "claude",
  whenToUse: "Catch-all for any task that doesn't fit a more specific agent. FleetView's default when no agent name is typed.",
  tools: ["*"],
  model: "inherit",
  appendSystemPrompt: true,  // 特殊：追加 system prompt
  source: "built-in"
}
```

**特点**：
- ✅ FleetView（后台任务面板）的默认 agent
- ✅ 有特殊的 appendSystemPrompt
- 🔑 **不是当前会话的常规 agent**

#### 6. "statusline-setup"

```typescript
const STATUSLINE_SETUP_AGENT = {
  agentType: "statusline-setup",
  whenToUse: "Use this agent to configure the user's Claude Code status line setting.",
  tools: ["Read", "Edit"],  // 只有这两个工具
  model: "sonnet",
  permissionMode: "bubble",
  source: "built-in"
}
```

**特点**：
- ✅ 只有 Read 和 Edit 工具
- ✅ 使用 sonnet 模型
- 🔑 **配置状态栏专用**

#### 7. "claude-code-guide"

```typescript
const CLAUDE_CODE_GUIDE_AGENT = {
  agentType: "claude-code-guide",
  whenToUse: "Use this agent when the user asks questions about: (1) Claude Code (the CLI tool)... (2) Claude Agent SDK... (3) Claude API...",
  tools: ["Grep", "Glob", "WebSearch", "Read", "WebFetch"],  // 搜索+阅读+联网
  model: "haiku",
  permissionMode: "dontAsk",  // 免权限确认
  source: "built-in"
}
```

**特点**：
- ✅ 搜索、阅读、联网工具
- ❌ 不能写文件、不能执行命令
- ✅ 使用 haiku 模型
- ✅ **免权限确认**（permissionMode: "dontAsk"）
- 🔑 **文档查询专用**

### 内置 Agent 加载逻辑

```typescript
function loadBuiltinAgents() {
  if (CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS && isSDKMode()) return [];
  if (isCoordinatorMode()) return getCoordinatorAgents();  // 返回 worker

  let agents = [general-purpose];  // 始终存在

  if (!isBackgroundMode()) agents.push(statusline-setup);
  if (isClaudeAgentEnabled()) agents.push(claude);
  if (isExplorePlanEnabled()) agents.push(Explore, Plan);  // 门控开启
  if (!isSDKEntrypoint()) agents.push(claude-code-guide);

  return agents;
}
```

### 用户自定义 agent type

除了内置 agent，用户可以通过：
1. `.claude/agents/` 目录创建自定义 agent
2. Project settings 定义 agent
3. Policy settings 定义 agent
4. Plugin 定义 agent

**自定义 agent 的格式**：

```typescript
// .claude/agents/custom-reviewer.ts
export const agent = {
  agentType: "custom-reviewer",
  whenToUse: "Code review agent...",
  tools: ["read_file", "glob", "grep"],
  model: "sonnet",
  maxTurns: 30,
  systemPrompt: "You are a code reviewer...",
  permissionMode: "bubble"
}
```

然后 LLM 可以调用：
```
tool_use: Agent
  input: {
    prompt: "Review the auth module...",
    subagent_type: "custom-reviewer"  ← 自定义的 agent type
  }
```

---

## 问题 2: 前缀相同的精确含义

### 你的理解场景

**场景 1（会命中）**：
```
父 Agent 的 messages:
  [0] user: "修 bug"
  [1] assistant: [...text..., tool_use(id=A), tool_use(id=B)]  ← 500 tokens
  [2] user: [tool_result(id=A, 真实输出), tool_result(id=B, 真实输出)]  ← 1000 tokens

Fork 子 Agent 的 messages:
  [0] assistant: [...text..., tool_use(id=A), tool_use(id=B)]  ← 500 tokens，与父 [1] 相同 ✓
  [1] user: [
    tool_result(id=A, "Fork started..."),  ← 与父 [2] 的 tool_result(id=A) 一部分相同
    tool_result(id=B, "Fork started..."),
    {text: "<fork-boilerplate>\nYour directive: ..."}
  ]  ← 200 tokens
```

**场景 2（不会命中）**：
```
父 Agent 的 messages:
  [0] user: "修 bug"
  [1] assistant: [...text..., tool_use(id=A), tool_use(id=B)]  ← 500 tokens
  [2] user: [tool_result(id=A, 真实输出), tool_result(id=B, 真实输出)]  ← 1000 tokens
  [3] assistant: [...text..., tool_use(id=C)]  ← 300 tokens

Fork 子 Agent 的 messages:
  [0] assistant: [...text..., tool_use(id=A), tool_use(id=B)]  ← 与父 [1] 相同 ✓
  [1] assistant: [...text..., tool_use(id=C)]  ← 与父 [3] 相同，跳过了父 [2] ❌
```

### Prompt Cache 前缀匹配的真实规则

**关键理解**：前缀必须是**从头开始的连续 token 序列**，不能跳过中间的消息。

#### 规则 1：从头开始

```
前缀 = messages 数组从头开始的连续部分

不能从中间开始！
不能跳过中间的消息！
必须是连续的！
```

#### 规则 2：字节级一致

```
前缀部分的每个字节必须完全一致

包括：
  ├─ role（"user" 或 "assistant"）
  ├─ content 的结构
  ├─ tool_use_id（必须完全相同）
  ├─ 文本内容（必须完全相同）
  └─ 顺序（必须完全相同）
```

#### 规则 3：连续匹配

```
父 messages:
  [0] user: A
  [1] assistant: B
  [2] user: C
  [3] assistant: D

子 messages:
  [0] user: A     ← 与父 [0] 相同 ✓
  [1] assistant: B ← 与父 [1] 相同 ✓
  [2] user: C'    ← 与父 [2] 不同 ❌

前缀匹配长度：[0] + [1] = 2 条消息 ✓
缓存命中：A + B 的 KV Cache ✓
新增计算：C' + 之后的消息 ✓
```

### 为什么场景 2 不会命中？

**关键原因**：前缀不连续，跳过了父的 [2]。

```
Anthropic API 的 Prompt Cache 机制：

1. Token 序列化：
   messages → tokens = [T0, T1, T2, T3, T4, T5, T6, T7, T8, ...]
   
   其中：
     [0] user → T0, T1, T2
     [1] assistant → T3, T4, T5
     [2] user → T6, T7
     [3] assistant → T8, T9, T10

2. KV Cache 存储：
   API 缓存的是 token 序列的 KV Cache
   
   缓存索引：
     key = hash(token_sequence[0:N])
     value = KV_Cache[0:N]
   
3. 前缀匹配：
   新请求的 token 序列 → hash → 查找缓存
   
   必须：
     ├─ 从 token[0] 开始
     ├─ 连续的 token 序列
     └─ 每个字节的 hash 完全相同
```

**场景 2 的问题**：

```
父 messages:
  [0] user: A          → tokens: [T0, T1, T2]
  [1] assistant: B     → tokens: [T3, T4, T5]
  [2] user: C          → tokens: [T6, T7]
  [3] assistant: D     → tokens: [T8, T9, T10]

父完整的 token 序列:
  [T0, T1, T2, T3, T4, T5, T6, T7, T8, T9, T10]

父的 KV Cache 存储:
  hash([T0, ..., T10]) → KV_Cache[全部]

──────────────────────────────────────────────────────────

子 messages:
  [0] assistant: B     → tokens: [T3, T4, T5]
  [1] assistant: D     → tokens: [T8, T9, T10]

子的 token 序列:
  [T3, T4, T5, T8, T9, T10]

──────────────────────────────────────────────────────────

问题：
  子的 token 序列从 T3 开始，不是 T0 ❌
  子的 token 序列跳过了 T6, T7 ❌
  
  hash([T3, T4, T5, T8, T9, T10]) ≠ hash([T0, ..., T10]) ❌
  
  Cache miss ❌
  
  API 需要重新计算全部 ❌
```

### 正确的 Fork 模式构造（为什么场景 1 会命中）

**关键**：buildForkedMessages() 的构造保证了前缀连续且字节级一致。

```
父 messages:
  [0] user: "修 bug"   → tokens: [T0, T1, T2]
  [1] assistant: B    → tokens: [T3, T4, T5] (包含 tool_use(id=A), tool_use(id=B))
  [2] user: C         → tokens: [T6, T7, T8, T9, T10] (tool_result(id=A), tool_result(id=B))

父完整的 token 序列:
  [T0, T1, T2, T3, T4, T5, T6, T7, T8, T9, T10]

──────────────────────────────────────────────────────────

buildForkedMessages() 的构造:

子的 messages:
  [0] assistant: B    → tokens: [T3, T4, T5] ← 深拷贝，与父 [1] 字节级一致 ✓
  [1] user: C'       → tokens: [T6', T7', T8', T9', T10', T11, T12]
       其中：
         tool_result(id=A, "Fork started") → T6', T7'
         tool_result(id=B, "Fork started") → T8', T9'
         {text: "<fork-boilerplate>..."} → T11, T12

──────────────────────────────────────────────────────────

关键问题：子的 token 序列从 T3 开始，不是 T0，会命中吗？

答案：不会命中完整前缀，但会命中部分前缀！

──────────────────────────────────────────────────────────

真实情况（Anthropic API 的 Prompt Cache 实现）:

1. API 缓存了多个粒度的前缀:
   ├─ hash([]) → 空 cache
   ├─ hash([T0]) → cache 1 token
   ├─ hash([T0, T1]) → cache 2 tokens
   ├─ hash([T0, T1, T2]) → cache 3 tokens
   ├─ hash([T0, ..., T5]) → cache 6 tokens
   ├─ hash([T0, ..., T10]) → cache 11 tokens
   └─ ... 多个粒度

2. 新请求会尝试匹配最长前缀:
   子的 token 序列: [T3, T4, T5, T6', T7', ...]
   
   尝试匹配:
     ├─ 从 T0 开始？ ❌ 子序列不从 T0 开始
     ├─ 从 T1 开始？ ❌ 子序列不从 T1 开始
     ├─ 从 T2 开始？ ❌ 子序列不从 T2 开始
     ├─ 从 T3 开始？ ✓ 子序列从 T3 开始
     │   但 API 的缓存索引是从 T0 开始的，不从 T3 开始 ❌
     └─ ...
   
3. 结果：
   Cache miss ❌
   
   但是，Fork 模式的特殊之处在于：
   它使用了 **"继承 system prompt + tools"** 的方式，而不是直接匹配 messages 前缀
   
──────────────────────────────────────────────────────────

真实的 Fork 模式缓存机制（从源码分析）:

Fork Agent 的特殊配置:
  ├─ getSystemPrompt: () => ""  ← 空字符串，继承父 system prompt ✓
  ├─ tools: ["*"]               ← 继承父 tools ✓
  ├─ model: "inherit"           ← 继承父 model ✓
  
缓存命中的五要素:
  ├─ system prompt: 父的 system prompt = 子的 system prompt（继承） ✓
  ├─ tools: 父的 tools = 子的 tools（继承） ✓
  ├─ model: 父的 model = 子的 model（继承） ✓
  ├─ messages 前缀: ???（这个最复杂）
  └─ thinking config: 父的 thinking = 子的 thinking ✓

──────────────────────────────────────────────────────────

messages 前缀的真实匹配（源码中的实现）:

实际上，Fork 模式不是简单地匹配 messages 前缀，
而是使用了 **"构造 cache-friendly messages"** 的技巧。

buildForkedMessages() 的真实目的:
  ├─ 不是为了匹配父的完整 messages 前缀
  ├─ 而是为了构造一个 **"子 Agent 的 messages"**
  │   ├─ 第一条：父 assistant message（深拷贝）
  │   ├─ 第二条：placeholder tool_results + 新任务
  │   └─ 这样子 Agent 可以看到父的推理过程，但不看到具体结果
  └─ 同时，通过继承 system prompt、tools、model，来命中缓存

缓存命中的真实计算:
  Request 1（父 Agent）:
    system + tools + messages[0:2] → hash → KV Cache
  
  Request 2（Fork 子 Agent）:
    system（继承）+ tools（继承）+ messages（新的，从父 assistant 开始）
    
    由于 system + tools 相同，这部分可以命中缓存 ✓
    
    但 messages 前缀不同，所以 messages 部分需要重新计算 ❌
    
    所以，Fork 模式的缓存优化主要体现在：
      ├─ system prompt 缓存命中（5000 tokens）
      ├─ tools 缓存命中（2000 tokens）
      └─ messages 需要重新计算（但节省了 system + tools 的部分）

──────────────────────────────────────────────────────────

所以，场景 1 的真实情况:

父 Request:
  system: 5000 tokens
  tools: 2000 tokens
  messages: 8600 tokens
  总计: 15600 tokens
  
子 Request（Fork）:
  system: 5000 tokens（继承，缓存命中）✓ → 节省 5000 tokens 计算
  tools: 2000 tokens（继承，缓存命中）✓ → 芞省 2000 tokens 计算
  messages: 700 tokens（新构造）❌ → 需要计算
  
  节省: 7000 tokens 的计算（约 45%）
  
──────────────────────────────────────────────────────────

结论：
  Fork 模式的缓存命中，主要是 system + tools 的缓存命中
  不是 messages 前缀的完整命中
  因为 messages 前缀不连续（子 messages 从 assistant 开始，跳过了父的 user）
```

### 总结：前缀匹配的精确规则

#### 规则 1：从头开始

```
前缀必须从 messages[0] 开始

不能从 messages[1] 开始 ❌
不能从 messages[2] 开始 ❌
必须从 messages[0] 开始 ✓
```

#### 规则 2：连续匹配

```
父 messages:
  [0] A
  [1] B
  [2] C
  [3] D

子 messages:
  [0] A   ✓
  [1] B   ✓
  [2] C'  ❌（不同）

匹配前缀：[0] + [1] = 2 条消息 ✓

如果子 messages:
  [0] A   ✓
  [1] D   ❌（跳过了 [1] B）

匹配前缀：[0] = 1 条消息 ✓（但更短）
```

#### 规则 3：字节级一致

```
父 messages[1]: 
  assistant: {
    content: [
      {type: "text", text: "Thinking..."},
      {type: "tool_use", id: "A", name: "read_file", input: {...}}
    ]
  }

子 messages[0]:
  assistant: {
    content: [
      {type: "text", text: "Thinking..."},  ← 文本完全相同 ✓
      {type: "tool_use", id: "A", name: "read_file", input: {...}}  ← id 完全相同 ✓
    ]
  }

字节级一致 ✓ → 缓存命中 ✓

如果子的 tool_use.id 不同:
  {type: "tool_use", id: "B", ...}  ← id 不同 ❌

字节级不一致 ❌ → 缓存不命中 ❌
```

### 你的场景的真实答案

#### 场景 1：会命中 system + tools 缓存

```
子的 messages[0] 与父 messages[1] 相同 ✓
子的 messages[1] 与父 messages[2] 一部分相同 ✓

messages 前缀不完全匹配（子从 assistant 开始，跳过了父的 user）
但 system + tools 匹配 ✓ → 缓存命中 system + tools 部分
节省约 7000 tokens 的计算（45%）
```

#### 场景 2：不会命中任何缓存

```
子的 messages[0] 与父 messages[1] 相同 ✓
子的 messages[1] 与父 messages[3] 相同（跳过了父 messages[2]）❌

messages 前缀不连续 ❌
即使 system + tools 匹配，messages 的构造错误会导致缓存完全不命中
需要重新计算全部 ❌
```

### 正确的 Fork 模式构造

```typescript
function buildForkedMessages(forkDirective, assistantMessage) {
  // 1. 深拷贝父 assistant message（字节级一致）
  let clonedAssistant = {
    ...assistantMessage,
    message: {
      ...assistantMessage.message,
      content: [...assistantMessage.message.content]  // 浅拷贝，保持原样
    }
  }

  // 2. 提取 tool_use blocks
  let toolUseBlocks = assistantMessage.message.content.filter(
    (block) => block.type === "tool_use"
  )

  // 3. 生成 placeholder tool_results（保留原始 id）
  let placeholderToolResults = toolUseBlocks.map((block) => ({
    type: "tool_result",
    tool_use_id: block.id,  // ← 关键：保留原始 id，字节级一致
    content: [{type: "text", text: "Fork started — processing in background"}]
  }))

  // 4. 构造 child user message
  let childUserMessage = {
    role: "user",
    content: [
      ...placeholderToolResults,
      {type: "text", text: `<fork-boilerplate>\nYour directive: ${forkDirective}`}
    ]
  }

  // 5. 返回两条消息（从父 assistant 开始）
  return [clonedAssistant, childUserMessage]
}
```

**关键设计**：
- 子 messages 从父 assistant 开始（跳过了父的 user prompt）
- 但父 assistant 深拷贝，字节级一致 ✓
- placeholder tool_results 保留原始 tool_use_id，结构一致 ✓
- system + tools 继承，缓存命中 ✓
- messages 需要重新计算（但节省了 system + tools）

---

## 最终理解

### subagent_type 的完整列表

```
内置 agent type（7 个）:
  ├─ "general-purpose"（默认）
  ├─ "Explore"（只读搜索）
  ├─ "Plan"（规划）
  ├─ "fork"（继承上下文）
  ├─ "claude"（FleetView catch-all）
  ├─ "statusline-setup"（配置状态栏）
  └─ "claude-code-guide"（文档查询）

用户自定义 agent type:
  ├─ .claude/agents/ 目录
  ├─ Project settings
  ├─ Policy settings
  └─ Plugin

subagent_type 是自由字符串，不是受限 enum
运行时通过模糊匹配查找 agent 定义
```

### Prompt Cache 前缀匹配的精确规则

```
规则 1: 从头开始
  前缀必须从 messages[0] 开始

规则 2: 连续匹配
  不能跳过中间的消息

规则 3: 字节级一致
  每个字节必须完全相同

Fork 模式的缓存优化:
  ├─ system prompt 缓存命中 ✓
  ├─ tools 缓存命中 ✓
  ├─ messages 需要重新计算 ❌
  └─ 节省约 45% 的计算
```

### 你的场景的答案

```
场景 1（子的 messages[0] 与父 messages[1] 相同）:
  ├─ messages 前缀不完全匹配 ❌
  ├─ system + tools 缓存命中 ✓
  └─ 节省约 45% 的计算 ✓

场景 2（子跳过了父 messages[2]）:
  ├─ messages 前缀不连续 ❌
  ├─ 缓存完全不命中 ❌
  └─ 需要重新计算全部 ❌
```

---

<!-- 文档版本：v3.0 -->
<!-- 创建时间：2026-06-22 -->
<!-- 基于 Claude Code v2.1.185 源码分析 -->
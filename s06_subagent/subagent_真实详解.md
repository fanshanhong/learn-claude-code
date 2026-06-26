# ClaudeCode Subagent 真实详解 —— 基于源码的深度解析

---

## 问题 1: subagent_type 是什么？谁来指定？

### 真实答案（基于源码）

**subagent_type 的定义**：

```typescript
// Agent 工具的 input_schema 定义
{
  "name": "Agent",
  "input_schema": {
    "type": "object",
    "properties": {
      "prompt": {"type": "string"},
      "subagent_type": {"type": "string", "enum": ["claude", "Explore", "general-purpose", "Plan", ...]},
      "run_in_background": {"type": "boolean"},
      ...
    }
  }
}
```

**谁来指定？**

答案是：**LLM 在调用 Agent 工具时指定**。

### 完整的调用流程

```
用户输入："分析这个项目的测试框架"
    ↓
主 Agent 收到用户输入
    ↓
主 Agent 分析任务："这需要读很多文件，应该用 subagent"
    ↓
主 Agent 决定调用 Agent 工具：
    tool_use: Agent
        input: {
            prompt: "Find what testing framework...",
            subagent_type: "Explore",  ← LLM 在这里指定！
            run_in_background: false
        }
    ↓
Agent 工具的 handler（AgentTool.tsx）收到 input
    ↓
根据 subagent_type 判断执行模式：
    if (input.subagent_type) → Normal Subagent
    elif (fork_gate) → Fork Subagent
    else → General-Purpose
```

### 三种执行模式的判断逻辑（真实代码）

```typescript
// AgentTool.tsx 中的核心判断逻辑
function executeAgentTool(input) {
  // 1. 检查是否有 subagent_type
  if (input.subagent_type) {
    // Normal Subagent 路径
    // 查找 subagent_type 对应的 agent 定义（如 "Explore"）
    let agentDef = findAgentDefinition(input.subagent_type)
    let messages = [{"role": "user", "content": input.prompt}]
    return runNormalAgent(agentDef, messages)
  }
  
  // 2. 检查 fork gate 是否开启
  else if (isForkSubagentEnabled()) {
    // Fork Subagent 路径
    // 使用父 Agent 的 assistant message 构造 cache-friendly 前缀
    let messages = buildForkedMessages(input.prompt, parentAssistantMessage)
    return runForkedAgent(messages)
  }
  
  // 3. 默认路径
  else {
    // General-Purpose 路径
    // 同 Normal，使用全新 messages
    let messages = [{"role": "user", "content": input.prompt}]
    return runGeneralAgent(messages)
  }
}
```

### subagent_type 的可选值

```typescript
// 可用的 subagent_type 值
const AVAILABLE_SUBAGENT_TYPES = [
  "claude",           // 通用 subagent（catch-all）
  "Explore",          // 只读探索 agent（只能读，不能写）
  "general-purpose",  // 通用 purpose agent
  "Plan",             // 规划 agent（只能规划，不能执行）
  "claude-code-guide",// Claude Code 指南查询 agent
  "statusline-setup", // 状态栏设置 agent
  ...
]
```

---

## 问题 2: Normal Subagent vs General-Purpose 的区别

### 你的观察：看上去没任何区别

**你的观察是对的！** 在上下文隔离的层面上，它们确实没有区别。

### 真实的区别在哪里？

区别在于 **Agent 的定义（system prompt、tools、限制）不同**，而不是上下文隔离方式不同。

```typescript
// Normal Subagent（指定 subagent_type）
let agentDef = {
  agentType: "Explore",
  systemPrompt: "You are a read-only exploration agent...",
  tools: ["read_file", "glob", "grep"],  // 只有读工具
  maxTurns: 50,
  ...
}

// General-Purpose（没指定 subagent_type）
let agentDef = {
  agentType: "general-purpose",
  systemPrompt: "You are a general-purpose agent...",
  tools: ["bash", "read_file", "write_file", "edit_file", "glob"],  // 有读写工具
  maxTurns: 200,
  ...
}
```

### 对比表（真实区别）

| 维度 | Normal Subagent（指定 subagent_type） | General-Purpose（没指定） |
|------|--------------------------------------|--------------------------|
| **上下文隔离方式** | ✅ 相同：全新 messages[] | ✅ 相同：全新 messages[] |
| **messages 初始值** | ✅ 相同：只有一条 prompt | ✅ 相同：只有一条 prompt |
| **触发条件** | ❌ 不同：LLM 指定了 subagent_type | ❌ 不同：没指定 + fork gate 关闭 |
| **Agent 定义** | ❌ 不同：根据 subagent_type 定制 | ❌ 不同：默认通用定义 |
| **System Prompt** | ❌ 不同：定制 prompt | ❌ 不同：通用 prompt |
| **Tools** | ❌ 不同：定制工具集 | ❌ 不同：默认工具集 |
| **限制** | ❌ 不同：定制限制（如只读） | ❌ 不同：默认限制 |

### 实际例子

**例 1：Normal Subagent（Explore）**

```
用户："找出所有使用 pytest 的文件"

主 Agent：
  tool_use: Agent
    input: {
      prompt: "Find all files using pytest...",
      subagent_type: "Explore"  ← 指定了 Explore
    }
    
子 Agent（Explore）：
  system: "You are a read-only exploration agent. You can only read files, not modify."
  tools: ["read_file", "glob", "grep"]  ← 只有读工具
  messages: [{"role": "user", "content": "Find all files using pytest..."}]
  
执行：
  只能读文件，不能写文件
  只能搜索，不能修改
  完成后返回结论
```

**例 2：General-Purpose**

```
用户："创建一个测试文件"

主 Agent：
  tool_use: Agent
    input: {
      prompt: "Create test_auth.py with basic tests..."  ← 没指定 subagent_type
    }
    
子 Agent（General-Purpose）：
  system: "You are a general-purpose agent. Complete the task..."
  tools: ["bash", "read_file", "write_file", "edit_file", "glob"]  ← 有写工具
  messages: [{"role": "user", "content": "Create test_auth.py..."}]
  
执行：
  可以读文件，也可以写文件
  可以创建、修改
  完成后返回结论
```

### 核心结论

**上下文隔离方式完全相同**：都是全新 messages[]，只有一条 prompt。

**区别在于 Agent 的能力定制**：
- Normal Subagent：根据 `subagent_type` 选择预定义的 Agent（有不同的 system prompt、tools、限制）
- General-Purpose：使用默认的通用 Agent（标准的 system prompt、tools）

---

## 问题 3: Fork 模式的详细解释

### 你的误解："缓存命中每次结果都完全一样，这有什么用？"

**关键纠正**：缓存的是 **KV Cache（中间计算结果）**，不是 **最终输出**！

### Prompt Cache 的真实原理

```
LLM 的计算过程：
输入 → Token 序列 → KV Cache → 输出

KV Cache 是什么？
  ├─ Transformer 每一层的中间计算结果
  ├─ 缓存了 attention 的 Key-Value 矩阵
  ├─ 避免 repeated computation
  └─ 节省时间和计算成本

Prompt Cache 的工作方式：
  ├─ API 服务器缓存了前缀部分的 KV Cache
  ├─ 新请求如果前缀相同，直接使用缓存
  ├─ 只需要计算新增部分
  └─ 最终输出还是不同的！因为新增部分不同！
```

### 真实的例子（修正你的例子）

```
Request 1（父 Agent）:
  system: "You are a coding agent..." (5000 tokens)
  tools: [bash, read, write, edit, glob] (2000 tokens)
  messages: [
    {"role": "user", "content": "修 bug #123"} (100 tokens),
    {"role": "assistant", "content": "...", "tool_use": [...]} (500 tokens),
    {"role": "user", "content": [真实 tool_results]} (1000 tokens)
  ]
  
  API 处理：
    ├─ 全部计算（8600 tokens）
    ├─ KV Cache 存储前缀：system + tools + messages[0:2]
    ├─ 成本：$0.01
    ├─ 时间：2 秒
    └─ 输出："修复方案 A..."

──────────────────────────────────────────────────────────

Request 2（Fork 子 Agent）:
  system: "You are a coding agent..." (5000 tokens) ← 完全相同 ✓
  tools: [bash, read, write, edit, glob] (2000 tokens) ← 完全相同 ✓
  messages: [
    {"role": "assistant", "content": "...", "tool_use": [...]} (500 tokens) ← 完全相同 ✓
    {"role": "user", "content": [
      {"type": "tool_result", "tool_use_id": "A", "content": "Fork started..."}, ← placeholder
      {"type": "text", "text": "<fork-boilerplate>\nYour directive: 换个角度修复"} ← 新任务
    ]} (200 tokens) ← 新内容
  ]
  
  API 处理：
    ├─ 前缀命中缓存（7500 tokens）← 直接使用缓存的 KV Cache
    ├─ 只计算新增部分（1100 tokens）
    ├─ 成本：$0.001（节省 90%）
    ├─ 时间：0.2 秒（快 10 倍）
    └─ 输出："修复方案 B..." ← 输出不同！因为新增部分不同！
```

### 关键理解

**缓存的是什么？**
- 缓存的是 **KV Cache**（Transformer 的中间计算结果）
- 不是缓存最终输出文本
- 不是缓存完整的推理过程

**为什么输出不同？**
- 前缀部分虽然相同，使用缓存的 KV Cache
- 但 **新增部分不同**（placeholder + 新任务）
- 所以最终输出不同

类比：
```
就像做数学题：
  
题目 1: "已知 x=5, y=3, 求 x+y+z=? (z=10)"
  ├─ 计算 x+y = 8（缓存这个中间结果）
  ├─ 计算 8+z = 18
  └─ 输出：18
  
题目 2: "已知 x=5, y=3, 求 x+y+w=? (w=20)"
  ├─ x+y = 8（使用缓存，不需要重新计算）
  ├─ 计算 8+w = 28
  └─ 输出：28 ← 输出不同！
  
缓存的是 "x+y=8"（中间结果），不是最终答案
```

### Fork 模式构造的 messages（真实结构）

```typescript
function buildForkedMessages(forkDirective: string, assistantMessage: Message): Message[] {
  // 1. 深拷贝父 assistant message（保持内容完全一致）
  let clonedAssistant = {
    ...assistantMessage,
    uuid: crypto.randomUUID(),  // 只改 uuid
    message: {
      ...assistantMessage.message,
      content: [...assistantMessage.message.content]  // 浅拷贝 content 数组
    }
  }
  
  // 2. 从 assistant message 中提取所有 tool_use blocks
  let toolUseBlocks = assistantMessage.message.content.filter(
    (block) => block.type === "tool_use"
  )
  
  // 3. 生成 placeholder tool_results
  let placeholderToolResults = toolUseBlocks.map((block) => ({
    type: "tool_result",
    tool_use_id: block.id,  // ← 关键：保留原始 tool_use_id
    content: [
      {type: "text", text: "Fork started — processing in background"}
    ]
  }))
  
  // 4. 构造 child user message
  let childUserMessage = {
    role: "user",
    content: [
      ...placeholderToolResults,
      {type: "text", text: `<fork-boilerplate>\nYour directive: ${forkDirective}`}
    ]
  }
  
  // 5. 返回两条消息
  return [clonedAssistant, childUserMessage]
}
```

### 前缀相同的真实含义

**前缀** = messages 数组的**前面部分**，需要与父 Agent 的 messages 前缀**字节级一致**。

```
父 Agent 的 messages（完整）:
  [0] user:     "修 bug"                    ← 父的原始 prompt
  [1] assistant: [...text..., tool_use(id=A), tool_use(id=B)] ← 父的回复
  [2] user:     [tool_result(id=A, 真实输出), tool_result(id=B, 真实输出)] ← 真实结果
  
Fork 子 Agent 的 messages（构造后）:
  [0] assistant: [...text..., tool_use(id=A), tool_use(id=B)] ← 深拷贝，完全一致 ✓
  [1] user:     [tool_result(id=A, "Fork started..."), tool_result(id=B, "Fork started..."),
                {text: "<fork-boilerplate>\nYour directive: 换个角度修复"}] ← 新构造
  
注意：
  ├─ 子 Agent 的 messages 从 [0] assistant 开始（没有父的 [0] user）
  ├─ [0] assistant 与父的 [1] assistant 字节级一致 ✓
  ├─ [1] user 的结构：
  │   ├─ tool_result(id=A, placeholder) ← id 相同，结构相同，但内容不同
  │   ├─ tool_result(id=B, placeholder) ← id 相同，结构相同，但内容不同
  │   └─ {text: "<fork-boilerplate>\nYour directive: ..."} ← 新任务
  └─ 前缀 = [0] assistant（字节级一致）
```

**关键**：
- 子 Agent 的 messages **不包含父的原始 prompt**（父的 [0] user）
- 子 Agent 的 messages 从 **父的 assistant message** 开始
- 这样父子共享相同的 assistant message 前缀，prompt cache 可以命中

### 缓存的要求（字节级一致）

**为什么要求字节级一致？**

因为 Prompt Cache 是基于 **Token 序列的哈希** 匹配的。

```
Token 序列:
  system prompt → tokens: [S1, S2, S3, ..., S5000]
  tools → tokens: [T1, T2, T3, ..., T2000]
  messages → tokens: [M1, M2, M3, ...]
  
KV Cache 存储:
  ├─ 每个 token 的 KV 矩阵
  ├─ 按 token 序列的哈希索引
  └─ 哈希值必须完全相同才能命中
  
如果字节不同:
  ├─ Token 序列不同
  ├─ 哈希值不同
  ├─ Cache miss
  └─ 需要重新计算全部
```

**五个关键组件必须字节级一致**：

```typescript
// forkedAgent.ts:57-68 的检查逻辑
function checkCacheHit(parentContext, childContext) {
  return (
    parentContext.systemPrompt === childContext.systemPrompt &&  // system prompt 相同
    parentContext.tools === childContext.tools &&                // tools 相同
    parentContext.model === childContext.model &&                // model 相同
    parentContext.messages[0] === childContext.messages[0] &&    // messages 前缀相同
    parentContext.thinkingConfig === childContext.thinkingConfig // thinking config 相同
  )
}
```

### Fork 模式的挑战

**挑战 1：必须精确构造 cache-friendly 消息前缀**

```typescript
// 错误示例（cache miss）
let wrongMessages = [
  {
    role: "assistant",
    content: [...assistantMessage.content, {type: "text", text: "额外文本"}]  ← 添加了额外内容
  }
]
// ❌ content 被修改，字节级不一致，cache miss

// 正确示例（cache hit）
let correctMessages = [
  {
    role: "assistant",
    content: [...assistantMessage.content]  ← 浅拷贝，保持原样
  }
]
// ✓ content 完全一致，cache hit
```

**挑战 2：必须保持父 assistant message 完全一致**

```typescript
// 错误示例
let clonedAssistant = {
  ...assistantMessage,
  message: {
    ...assistantMessage.message,
    content: assistantMessage.message.content.map(block => {
      if (block.type === "tool_use") {
        return {...block, id: crypto.randomUUID()}  ← ❌ 改了 tool_use_id
      }
      return block
    })
  }
}
// ❌ tool_use_id 被修改，字节级不一致，cache miss

// 正确示例
let clonedAssistant = {
  ...assistantMessage,
  uuid: crypto.randomUUID(),  // 只改 uuid（uuid 不在 content 中，不影响 cache）
  message: {
    ...assistantMessage.message,
    content: [...assistantMessage.message.content]  ← ✓ 浅拷贝，保持原样
  }
}
// ✓ tool_use_id 保持不变，cache hit
```

**挑战 3：必须生成 placeholder tool_results 保持结构一致**

```typescript
// 错误示例
let wrongPlaceholder = {
  type: "tool_result",
  tool_use_id: crypto.randomUUID(),  ← ❌ 新生成的 id，与父 tool_use.id 不匹配
  content: "Fork started..."
}
// ❌ tool_use_id 不匹配，结构不一致，cache miss

// 正确示例
let correctPlaceholder = {
  type: "tool_result",
  tool_use_id: block.id,  ← ✓ 使用父 tool_use block 的原始 id
  content: [{type: "text", text: "Fork started — processing in background"}]
}
// ✓ tool_use_id 与父一致，结构一致，cache hit
```

---

## 问题 4: Context Isolate 的粒度（上下文隔离的精确粒度）

### 真实的源码实现（createSubagentContext）

```typescript
function createSubagentContext(parentContext, options) {
  return {
    // 1. 完全隔离的字段
    messageQueue: parentContext.messageQueue,  ← 共享
    nestedMemoryAttachmentTriggers: [],        ← 新建空数组
    loadedNestedMemoryPaths: {},               ← 新建空对象
    dynamicSkillDirTriggers: [],               ← 新建空数组
    memorySelector: createNewMemorySelector(), ← 新建空 selector
    toolDecisions: undefined,                  ← 新建 undefined
    
    // 2. readFileState：从父克隆（关键！）
    readFileState: cloneLRUCache(parentContext.readFileState), ← 克隆
    
    // 3. abortController：新建，但父信号向下传播
    abortController: options.abortController 
      ?? (options.shareAbortController 
        ? parentContext.abortController        ← 共享
        : createLinkedAbortController(parentContext.abortController)), ← 新建但关联
    
    // 4. getAppState：根据选项处理
    getAppState: options.getAppState 
      ?? (options.shareAbortController 
        ? parentContext.getAppState            ← 共享
        : createWrappedGetAppState(parentContext)), ← 包装，只传递特定字段
    
    // 5. permissionLayers：合并
    permissionLayers: [
      ...parentContext.permissionLayers ?? [],
      ...options.permissionLayers ?? [],
      ...(options.shareAbortController ? [] : [{kind: "avoid_prompts"}])
    ],
    
    // 6. setAppState：根据选项处理
    setAppState: options.shareSetAppState 
      ? parentContext.setAppState              ← 共享
      : createWrappedSetAppState(parentContext), ← 包装，只传递特定字段
    
    // 7. queryTracking：新建，但记录深度关系
    queryTracking: {
      chainId: crypto.randomUUID(),            ← 新 UUID
      depth: (parentContext.queryTracking?.depth ?? -1) + 1  ← 深度递增
    },
    
    // 8. 其他字段
    agentId: options.agentId ?? crypto.randomUUID(),  ← 新 agentId
    localDenialTracking: options.shareSetAppState 
      ? parentContext.localDenialTracking      ← 共享
      : {consecutiveDenials: 0, totalDenials: 0}, ← 新建
    
    ...  // 其他字段
  }
}
```

### 逐个字段详解

#### 1. readFileState：从父克隆

**为什么克隆而不是新建？**

```
父 Agent 已经读过：
  ├─ package.json (已缓存)
  ├─ config.py (已缓存)
  └─ README.md (已缓存)

如果子 Agent 新建 readFileState:
  ├─ 子 Agent 需要重新读 package.json ← 浪费 token
  ├─ 子 Agent 需要重新读 config.py ← 浪费 token
  └─ 浪费时间和成本

如果子 Agent 克隆 readFileState:
  ├─ 子 Agent 直接使用父已缓存的文件内容 ✓
  ├─ 不需要重新读取
  └─ 节省 token 和时间
```

**克隆的实现（LRU Cache 的 dump/load）**：

```typescript
function cloneLRUCache(cache) {
  let newCache = new LRU(cache.max, cache.maxSize)  // 创建同规格的新 cache
  newCache.load(cache.dump())                       // 将父 cache 数据导入
  return newCache
}
```

**关键**：
- 子 Agent 的 readFileState 是父的**独立副本**
- 子 Agent 修改 readFileState 不影响父的 readFileState
- 但初始状态继承了父已读取的文件缓存

#### 2. abortController：新建，但父信号向下传播

**新建但关联**：

```typescript
function createLinkedAbortController(parentAbortController) {
  let childAbortController = new AbortController()
  
  // 单向联动：父 abort → 子 abort
  if (parentAbortController.signal.aborted) {
    childAbortController.abort(parentAbortController.signal.reason)  // 父已 abort，立即 abort 子
  } else {
    parentAbortController.signal.addEventListener("abort", () => {
      childAbortController.abort(parentAbortController.signal.reason)  // 父 abort 时，abort 子
    }, {once: true})
  }
  
  return childAbortController
}
```

**设计意义**：
- 子 Agent 有自己的 abortController（可以单独控制）
- 但父 Agent abort 时，子 Agent 也会 abort（单向传播）
- 子 Agent abort 不会影响父 Agent（单向联动）

**类比**：
```
父 Agent：主进程
子 Agent：子进程

父进程 kill → 子进程也被 kill ✓（单向传播）
子进程 kill → 父进程不受影响 ✓（单向隔离）
```

#### 3. getAppState：包装，只传递特定字段

**包装函数的实现**：

```typescript
function createWrappedGetAppState(parentContext) {
  return () => {
    let parentState = parentContext.getAppState()
    if (parentState.toolPermissionContext.shouldAvoidPermissionPrompts) {
      return parentState  // 如果父避免权限弹窗，直接返回父状态
    }
    return {
      ...parentState,
      toolPermissionContext: {
        ...parentState.toolPermissionContext,
        shouldAvoidPermissionPrompts: true  // 子 Agent 默认避免权限弹窗
      }
    }
  }
}
```

**关键**：
- 子 Agent 的 getAppState 可以读取父的 appState
- 但子 Agent 默认避免权限弹窗（shouldAvoidPermissionPrompts: true）
- 这意味着子 Agent 的权限请求会冒泡到父终端（Permission Bubbling）

#### 4. setAppState：包装，只传递特定字段

**包装函数的实现**：

```typescript
function createWrappedSetAppState(parentContext) {
  return (newStateUpdater) => {
    parentContext.setAppState((oldState) => {
      let newState = newStateUpdater(oldState)
      if (newState === oldState) return oldState  // 无变化
      
      // 只允许特定字段传播到父
      let propagatedFields = {}
      let hasChanges = false
      for (let key of ASYNC_SHARED_APP_STATE_KEYS) {  // ASYNC_SHARED_APP_STATE_KEYS = ["frameUrls"]
        if (newState[key] !== oldState[key]) {
          propagatedFields[key] = newState[key]
          hasChanges = true
        }
      }
      
      return hasChanges ? {...oldState, ...propagatedFields} : oldState
    })
  }
}
```

**关键**：
- 子 Agent 的 setAppState 只能修改 **frameUrls** 字段
- 其他字段（如 toolPermissionContext）的修改**不会传播到父**
- 这是为了防止子 Agent 的内部状态污染父 Agent

**ASYNC_SHARED_APP_STATE_KEYS 的定义**：

```typescript
const ASYNC_SHARED_APP_STATE_KEYS = ["frameUrls"]  // 只有 frameUrls 字段可以传播
```

#### 5. queryTracking：新建，但记录深度关系

```typescript
queryTracking: {
  chainId: crypto.randomUUID(),            // 新 UUID（新追踪链）
  depth: (parentContext.queryTracking?.depth ?? -1) + 1  // 深度递增
}
```

**设计意义**：
- 每个子 Agent 启动一条新的追踪链（chainId 是新 UUID）
- 但记录深度关系（depth 递增）
- 用于遥测和日志分析

**深度示例**：

```
主 Agent: depth = -1（表示主线程）
  ├─ Subagent #1: depth = 0
  │   ├─ Subagent #1.1: depth = 1
  │   └─ Subagent #1.2: depth = 1
  ├─ Subagent #2: depth = 0
  └─ Subagent #3: depth = 0
```

#### 6. localDenialTracking：新建或共享

```typescript
localDenialTracking: options.shareSetAppState 
  ? parentContext.localDenialTracking      // 共享（记录父和子的拒绝）
  : {consecutiveDenials: 0, totalDenials: 0}  // 新建（只记录子的拒绝）
```

**设计意义**：
- localDenialTracking 用于记录权限拒绝次数
- 如果 shareSetAppState（同步 agent），共享父的拒绝记录
- 否则，新建记录，只记录子 Agent 的拒绝

---

## 总结：Context Isolate 的精确粒度

### 三个层次

```
完全隔离（新建，不共享）:
  ├─ messages（对话历史）← 这是上下文隔离的核心
  ├─ nestedMemoryAttachmentTriggers
  ├─ loadedNestedMemoryPaths
  ├─ dynamicSkillDirTriggers
  ├─ memorySelector
  ├─ toolDecisions
  ├─ queryTracking（新 chainId）
  └─ agentId

部分共享（克隆或关联）:
  ├─ readFileState（从父克隆）← 避免重复读文件
  ├─ abortController（新建，但父信号向下传播）
  └─ permissionLayers（合并父和子的）

灵活共享（根据选项决定）:
  ├─ getAppState（默认包装，只读父状态）
  ├─ setAppState（默认包装，只传播特定字段）
  ├─ localDenialTracking（根据 shareSetAppState 决定）
  └─ messageQueue（总是共享）
```

### 设计哲学

**对话历史隔离**（messages）：
- 这是上下文隔离的核心
- 子 Agent 有全新的 messages，不污染主 Agent 的对话历史

**工作状态共享**（readFileState）：
- 文件读取状态共享，避免重复读文件
- 节省 token 和时间

**控制信号单向传播**（abortController）：
- 父 abort → 子 abort（单向）
- 子 abort 不影响父

**UI 状态精确隔离**（setAppState）：
- 只允许特定字段（frameUrls）传播
- 其他字段隔离，防止污染

---

## 完整对比表

| 字段 | 行为 | 原因 |
|------|------|------|
| **messages** | 完全隔离 | 🔑 **核心！避免上下文污染** |
| **readFileState** | 从父克隆 | 🔑 **避免重复读文件，节省 token** |
| **abortController** | 新建但关联 | 父信号向下传播，但子信号不影响父 |
| **getAppState** | 包装 | 可以读父状态，但子默认避免权限弹窗 |
| **setAppState** | 包装 | 只允许特定字段（frameUrls）传播 |
| **queryTracking** | 新建 | 新追踪链，但记录深度关系 |
| **localDenialTracking** | 根据选项 | shareSetAppState 时共享，否则新建 |
| **messageQueue** | 共享 | 总是共享，用于通知机制 |

---

## 最终理解

**Context Isolate 的粒度**：
- 不是"完全隔离"，而是"精确隔离"
- 隔离的是"对话历史"（messages），避免上下文污染
- 共享的是"工作状态"（readFileState），避免重复工作
- 单向传播的是"控制信号"（abortController），父控制子
- 精确传播的是"UI 状态"（setAppState），只允许特定字段

**类比**：
```
Context Isolate 就像"独立房间但共享设施":

独立房间（完全隔离）:
  ├─ messages（对话历史）← 你的私人对话
  ├─ memorySelector ← 你的私人记忆
  └─ agentId ← 你的身份

共享设施（部分共享）:
  ├─ readFileState（文件缓存）← 共享图书馆，避免重复买书
  ├─ messageQueue（通知队列）← 共享公告板
  └─ permissionLayers（权限层）← 合并父和子的权限

单向控制（单向传播）:
  ├─ abortController ← 父关掉总电源，子房间也会断电
  └─ 但子房间关掉自己的灯，不影响父房间

精确传播（只传播特定字段）:
  ├─ setAppState ← 子房间只能调整"公共灯光"（frameUrls）
  └─ 其他设置（温度、噪音）不传播到父房间
```

---

<!-- 文档版本：v2.0 -->
<!-- 创建时间：2026-06-22 -->
<!-- 基于 Claude Code v2.1.185 源码分析 -->
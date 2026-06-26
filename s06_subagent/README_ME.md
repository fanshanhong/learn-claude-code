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

---

## 二、三种执行模式（这是教学版没讲的核心）

### 教学版的简化

教学版（s06）只讲了"全新的 messages[]"这一种模式。但 ClaudeCode 实际有**三种执行模式**：

| 模式 | 触发条件 | 上下文特点 | 核心目的 |
|------|---------|-----------|---------|
| **Normal Subagent** | 指定了 `subagent_type` | 全新 messages[]，只有 prompt | 完全隔离，适合独立任务 |
| **Fork Subagent** | 没指定 `subagent_type`，fork gate 开启 | cache-friendly 前缀，共享 prompt cache | 性能优化，减少 API 成本 |
| **General-Purpose** | 没指定 `subagent_type`，fork gate 关闭 | 同 Normal | 默认通用模式 |

### 为什么需要三种模式？

**场景 1：完全独立的任务**
- 例：分析一个完全不相关的日志文件
- 用 Normal Subagent：全新上下文，完全隔离

**场景 2：相关但需要性能优化**
- 例：继续修同一个 bug，但换个角度
- 用 Fork Subagent：共享 Prompt Cache，减少成本

**场景 3：默认通用任务**
- 例：不确定是否需要隔离
- 用 General-Purpose：默认行为，同 Normal

---

## 三、subagent_type 完整列表

### 3.1 subagent_type 是什么？谁来指定？

**真实答案（基于源码）**：

```
subagent_type 不是受限 enum，是自由字符串字段！

Agent 工具的 input_schema：
  {
    "name": "Agent",
    "input_schema": {
      "type": "object",
      "properties": {
        "prompt": {"type": "string"},
        "subagent_type": {"type": "string"},  ← 自由字符串
        ...
      }
    }
  }
```

**谁来指定？**

答案是：**LLM 在调用 Agent 工具时指定**。

```
完整的调用流程：

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
        }
    ↓
Agent 工具的 handler（AgentTool.tsx）收到 input
    ↓
根据 subagent_type 判断执行模式：
    if (input.subagent_type) → Normal Subagent
    elif (fork_gate) → Fork Subagent
    else → General-Purpose
```

### 3.2 内置 agent type 完整列表（7 个）

| agentType | 用途 | 工具 | 模型 | 说明 |
|-----------|------|------|------|------|
| **"general-purpose"** | 通用任务（默认） | 所有工具 | inherit | 默认 agent |
| **"Explore"** | 只读搜索 | 只读工具，不能写 | haiku | 快速定位代码 |
| **"Plan"** | 规划策略 | 只读工具，不能写 | inherit | 只规划，不执行 |
| **"fork"** | 继承父上下文 | 所有工具 | inherit | 缓存优化 |
| **"claude"** | FleetView 后台通用 | 所有工具 | inherit | 后台 catch-all |
| **"statusline-setup"** | 配置状态栏 | Read, Edit | sonnet | 配置专用 |
| **"claude-code-guide"** | 文档查询 | 搜索+联网 | haiku | 文档查询 |

### 3.3 各个 agent type 的详细说明

#### "general-purpose"

```typescript
const GENERAL_PURPOSE_AGENT = {
  agentType: "general-purpose",
  tools: ["*"],  // 所有工具
  model: "inherit",  // 继承父 agent 的模型
  maxTurns: 200,
  permissionMode: "bubble",  // 权限冒泡到父
}
```

**特点**：
- ✅ 所有工具可用（bash、read、write、edit、glob、grep、Agent 等）
- ✅ 继承父 agent 的模型
- 🔑 **默认 agent**（没指定 subagent_type 时使用）

#### "Explore"

```typescript
const EXPLORE_AGENT = {
  agentType: "Explore",
  tools: ["*"],
  disallowedTools: ["Agent", "TodoWrite", "FileEdit", "FileWrite"],
  model: "haiku",  // 默认 haiku，可升级
  omitClaudeMd: true,  // 不加载 CLAUDE.md
}
```

**特点**：
- ✅ 只读工具可用（read、glob、grep、bash）
- ❌ **不能写文件**
- ❌ 不能再 spawn Agent
- 🔑 **只读搜索**，用于快速定位代码

#### "Plan"

```typescript
const PLAN_AGENT = {
  agentType: "Plan",
  tools: ["*"],
  disallowedTools: ["Agent", "TodoWrite", "FileEdit", "FileWrite"],
  model: "inherit",
  omitClaudeMd: true,
}
```

**特点**：
- ✅ 同 Explore（只读工具）
- 🔑 **规划策略**，不能执行

#### "fork"

```typescript
const FORK_AGENT = {
  agentType: "fork",
  tools: ["*"],  // 继承父所有工具
  model: "inherit",
  getSystemPrompt: () => "",  // 空字符串，继承父 system prompt
  permissionMode: "bubble",
}
```

**特点**：
- ✅ 继承父 agent 的完整对话上下文
- ✅ 共享 prompt cache
- 🔑 **不是常规 agent**，是特殊的 Fork 模式

---

## 四、核心概念详解

### 4.1 Normal Subagent（标准子 Agent）

**实现方式**：
```python
messages = [{"role": "user", "content": description}]  # 全新 messages[]
# 只有这一个 prompt，完全干净
```

**特点**：
- ✅ 完全隔离：子 Agent 的所有中间过程不会污染主 Agent 的上下文
- ✅ 简单直观：就像开一个新终端，做完关掉
- ✅ 安全防护：子 Agent 不能递归 spawn 新的子 Agent（没有 task 工具）
- ⚠️ 性能成本：每次都是全新的 API 调用，没有缓存优化

**适用场景**：
- 完全独立的子任务
- 不需要共享父 Agent 的任何上下文
- 性能要求不高，成本不敏感

---

### 4.2 Fork 模式（分支模式）—— 核心是 Prompt Cache

**这是教学版没有讲的核心概念！**

#### Fork 模式的两个作用

```
作用 1: 提供上下文
  ├─ 子 Agent 继承父 assistant message
  ├─ 看到父的推理过程
  ├─ 不看到父的具体工具输出（placeholder 替换）
  └─ 然后接受新任务

作用 2: 节省 token
  ├─ 通过 Prompt Cache 命中 system + tools
  ├─ 节省 7000 tokens 的计算
  └─ 成本从 1x → 0.1x（缓存部分）
```

#### Fork 模式的 messages 构造

**真实构造（通过 buildForkedMessages()）**：

```
父 Agent 的 messages:
  [0] user: "修 bug"           ← messages[0] 是 user
  [1] assistant: [...]         ← messages[1] 是 assistant
  [2] user: [tool_results]     ← messages[2] 是 user

Fork 子 Agent 的 messages:
  [0] assistant: [...]         ← 深拷贝父 messages[1]，字节级一致 ✓
  [1] user: [placeholder, FORK_BOILERPLATE, directive] ← 新构造

关键：
  ├─ 子 messages 从 assistant 开始（跳过父的 user）
  ├─ 子 messages[0] ≠ 父 messages[0]
  ├─ messages 前缀不命中 ❌
  └─ 但 system + tools 前缀命中 ✓
```

#### buildForkedMessages() 的真实目的

**误解纠正**：

```
错误理解：
  buildForkedMessages() 的作用：
    ├─ 精确构造 cache-friendly 消息前缀
    ├─ 保留父 assistant message（完全一致）
    └─ 生成 placeholder tool_results（保持结构一致）

正确理解：
  buildForkedMessages() 的作用：
    ├─ 不是为了让 messages 前缀命中缓存 ❌
    ├─ 而是为了给子 Agent 提供上下文 ✓
    │   ├─ 子 Agent 可以看到父的推理过程
    │   ├─ 不看到父的具体工具输出（placeholder 替换）
    │   └─ 然后接受新任务
    └─ 同时，通过继承 system prompt、tools，来命中缓存
```

**类比理解**：

```
就像老师给学生布置任务：

老师（父 Agent）:
  ├─ 分析了问题（思考过程）
  ├─ 查了很多资料（工具输出）
  └─ 做出了决策

学生（子 Agent）:
  ├─ 看到老师的思考过程 ✓（继承 assistant message）
  ├─ 不需要看老师的所有资料 ❌（placeholder 替换）
  └─ 接受新任务 ✓（FORK_BOILERPLATE + directive）
```

---

### 4.3 General Purpose Agent（通用 Agent）

**定义**：没有指定 `subagent_type` 时，使用默认的通用 Agent 类型。

**特点**：
- 同 Normal Subagent
- 使用全新 messages[]
- 没有特殊的定制化提示

**适用场景**：
- 不确定任务性质
- 不需要特殊的 Agent 行为
- 默认通用行为足够

---

### 4.4 Prompt Cache（提示缓存）

#### 核心机制

**Anthropic API 的缓存策略**：

```
缓存的是什么？
  ├─ 缓存 system + tools + messages 的整体 token 序列
  ├─ 不是三个独立组件
  └─ 是一个整体序列

Token 序列拼接顺序：
  system_prompt → tools → messages

这是一个整体序列，前缀匹配从 system 的第一个 token 开始
```

#### 前缀匹配的真实规则

```
规则 1: 从整个序列的开头开始
  必须从 system prompt 的第一个 token 开始
  不是从 messages[0] 开始 ❌

规则 2: 连续匹配
  不能跳过中间的任何 token
  system → tools → messages 必须连续

规则 3: 字节级一致
  每个 token 必须完全相同
```

#### 缓存命中的关键要求

**字节级一致**：
```
要求：每个 token 必须完全相同

序列化成 token：
  {"role": "user", "content": "修 bug #123"}

  → tokens: [
    "{",        // T0
    "role",     // T1
    ":",        // T2
    "user",     // T3
    ",",        // T4
    "content",  // T5
    ":",        // T6
    "修",       // T7
    " bug",     // T8
    ...
  ]

如果字节不同：
  ├─ Token 序列不同
  ├─ 哈希值不同
  ├─ Cache miss
  └─ 需要重新计算全部
```

---

### 4.5 Context Isolate 的粒度（上下文隔离的精确粒度）

**关键理解**：Context Isolation 不是"完全隔离"，而是**有选择性的共享**。

#### createSubagentContext() 的设计

```typescript
function createSubagentContext(parentContext, options) {
  return {
    // 完全隔离的字段
    messageQueue: parentContext.messageQueue,  ← 共享
    nestedMemoryAttachmentTriggers: [],        ← 新建空数组
    memorySelector: createNewMemorySelector(), ← 新建空 selector
    
    // readFileState：从父克隆（关键！）
    readFileState: cloneLRUCache(parentContext.readFileState), ← 克隆
    
    // abortController：新建，但父信号向下传播
    abortController: createLinkedAbortController(parentContext.abortController),
    
    // getAppState：包装，只读父状态
    getAppState: createWrappedGetAppState(parentContext),
    
    // setAppState：包装，只传递特定字段
    setAppState: createWrappedSetAppState(parentContext),
    
    // queryTracking：新建，但记录深度关系
    queryTracking: {
      chainId: crypto.randomUUID(),  ← 新 UUID
      depth: (parentContext.queryTracking?.depth ?? -1) + 1  ← 深度递增
    },
    
    // agentId：新建
    agentId: crypto.randomUUID(),  ← 新 agentId
  }
}
```

#### 为什么 readFileState 要共享？

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

#### abortController：单向传播

```
设计：
  ├─ 子 Agent 有自己的 abortController（可以单独控制）
  ├─ 但父 Agent abort 时，子 Agent 也会 abort（单向传播）
  └─ 子 Agent abort 不会影响父 Agent（单向隔离）

类比：
  父 Agent：主进程
  子 Agent：子进程

  父进程 kill → 子进程也被 kill ✓（单向传播）
  子进程 kill → 父进程不受影响 ✓（单向隔离）
```

#### setAppState：精确传播

```
设计：
  ├─ 子 Agent 的 setAppState 只能修改 "frameUrls" 字段
  ├─ 其他字段的修改不会传播到父
  └─ 防止子 Agent 的内部状态污染父 Agent

ASYNC_SHARED_APP_STATE_KEYS = ["frameUrls"]

类比：
  子房间只能调整"公共灯光"（frameUrls）
  其他设置（温度、噪音）不传播到父房间
```

#### Context Isolation 的三个层次

```
完全隔离：messages[]（对话历史）
  ├─ 这是上下文隔离的核心
  └─ 子 Agent 有全新的对话历史

部分共享：readFileState（文件读取状态）
  ├─ 从父克隆，避免重复读文件
  └─ 节省 token 和时间

单向传播：abortController（控制信号）
  ├─ 父 abort → 子 abort（单向）
  └─ 子 abort → 父不受影响

精确传播：setAppState（UI 状态）
  ├─ 只允许特定字段（frameUrls）传播
  └─ 其他字段隔离，防止污染
```

---

## 五、缓存命中的真实情况

### 5.1 Fork 模式的缓存命中

#### System Prompt：命中 ✓

```
父 Agent:
  system: "You are a coding agent..." (5000 tokens)

Fork 子 Agent:
  system: "You are a coding agent..." (5000 tokens) ← 完全相同 ✓

原因：Fork Agent 的 getSystemPrompt: () => "" 确保与父完全一致
```

#### Tools：命中 ✓

```
父 Agent:
  tools: [bash, read, write, edit, glob, Agent] (2000 tokens)

Fork 子 Agent:
  tools: [bash, read, write, edit, glob, Agent] (2000 tokens) ← 完全相同 ✓

原因：Fork Agent 的 tools: ["*"] 继承父所有工具，包括 Agent

关键：
  ├─ Fork Agent 包含 Agent 工具（与父相同）
  ├─ 递归防护通过 isInForkChild() 实现，不是通过移除工具
  └─ Tools 序列相同 ✓
```

#### Messages：不命中 ❌

```
父 Agent 的 messages:
  [0] user: "修 bug"     ← messages[0] 是 user
  [1] assistant: [...]  ← messages[1] 是 assistant
  [2] user: [tool_results]

Fork 子 Agent 的 messages:
  [0] assistant: [...]  ← messages[0] 是 assistant（不是 user）
  [1] user: [placeholder, FORK_BOILERPLATE]

原因：
  ├─ 父 messages[0] 是 user
  ├─ 子 messages[0] 是 assistant
  ├─ messages 的第一个 token 就不同（user vs assistant）
  └─ 前缀匹配在 messages 开头就断裂 ❌
```

#### 真实节省计算

```
父 Request:
  system: 5000 tokens
  tools: 2000 tokens
  messages: 8600 tokens
  总计: 15600 tokens

Fork 子 Request:
  system: 5000 tokens ← 缓存命中 ✓
  tools: 2000 tokens ← 缓存命中 ✓
  messages: 700 tokens ← 全部重新计算 ❌
  总计: 7700 tokens 需要新计算

缓存命中的部分：
  system + tools = 7000 tokens
  这部分从 API 的缓存读取（成本 0.1x）

需要重新计算的部分：
  messages = 700+ tokens
  这部分全新计算（成本 1x）

真实节省：
  不使用缓存: 7700 * 1x = 7700 单位
  使用缓存: 7000 * 0.1x + 700 * 1x = 1400 单位
  节省: 82% ✓

但随着子对话增长：
  如果 messages 增长到 5000 tokens:
  不使用缓存: 7000 + 5000 = 12000 * 1x = 12000 单位
  使用缓存: 7000 * 0.1x + 5000 * 1x = 5700 单位
  节省: 52.5% ✓
```

---

### 5.2 Messages 缓存命中的可能性

#### Normal/GP Subagent

```
父 messages[0]: user "修 bug #123"
子 messages[0]: user "Find testing framework"

虽然都是 user，但 content 不同 ❌
字节级不一致
Messages 前缀不命中 ❌
```

#### Fork Subagent

```
父 messages[0]: user "修 bug #123"
子 messages[0]: assistant [...]

Role 不同 ❌
从第一个 token 就不同
Messages 前缀完全不命中 ❌
```

#### 理论上可能命中的情况

```
假设极端场景：
  父 messages[0]: user "分析项目"
  子 messages[0]: user "分析项目" ← 字节级一致 ✓

分析：
  ├─ 理论上可能命中 ✓
  ├─ 但真实场景下几乎不可能发生 ❌
  └─ 原因：
    ├─ 子任务描述总是与父输入不同
    ├─ 字节级一致的要求非常严格
    └─ Fork 模式跳过父 messages[0]
```

#### 最终结论

```
Messages 缓存命中的可能性：

理论上：
  ✅ 可能命中（极端情况，0.1%）

实际上：
  ❌ 几乎不可能命中（99.9% 不命中）

Claude Code 的设计中：
  ├─ Normal/GP: Messages 不命中 ❌
  ├─ Fork: Messages 不命中 ❌
  └─ 这是正常的，不是 bug ✓
```

---

### 5.3 Tools 缓存命中

#### 教学版（s06 code.py）

```python
# 明确的两套工具定义
TOOLS = [..., "task"]      # 主 Agent 有 task
SUB_TOOLS = [...]          # 子 Agent 没有 task

结果：
  ├─ Tools 序列完全不同 ❌
  ├─ System + Tools 都不命中 ❌
  └─ 这是教学版的简化，不是生产版的真实实现 ❌
```

#### 生产版 Fork Agent

```typescript
// Fork Agent 的定义
FORK_AGENT = {
  tools: ["*"],  // 继承父所有工具，包括 Agent
  disallowedTools: [],  // 没有禁用
}

结果：
  ├─ Tools 序列相同 ✓（继承）
  ├─ System + Tools 都命中 ✓
  └─ 递归防护通过 isInForkChild() 实现，不是移除工具 ✓
```

#### 生产版 Explore Agent

```typescript
// Explore Agent 的定义
EXPLORE_AGENT = {
  tools: ["*"],  // 声明继承
  disallowedTools: ["Agent", ...],  // 但禁用
}

关键问题：
  ├─ 序列化时是否过滤禁用工具？
  ├─ 如果过滤：Tools 不命中 ❌
  ├─ 如果不过滤：Tools 命中 ✓
  └─ 需要源码确认 ❓
```

---

## 六、完整的缓存命中总结

### Fork 模式

| 组件 | 是否命中 | 原因 |
|------|---------|------|
| **System** | ✓ 命中 | `getSystemPrompt: () => ""` 继承父 |
| **Tools** | ✓ 命中 | `tools: ["*"]` 继承所有工具 |
| **Messages** | ❌ 不命中 | 子 messages[0] ≠ 父 messages[0] |

**节省**：System + Tools = 7000 tokens（45%-82%）

### Normal/GP 模式

| 组件 | 是否命中 | 原因 |
|------|---------|------|
| **System** | ❓ 可能 | 取决于 SUB_SYSTEM 是否与 SYSTEM 相同 |
| **Tools** | ❌ 不命中 | 教学版明确两套定义 |
| **Messages** | ❌ 不命中 | 子 prompt ≠ 父输入 |

### Explore 模式

| 组件 | 是否命中 | 原因 |
|------|---------|------|
| **System** | ❌ 不命中 | Explore 有自己的 system prompt |
| **Tools** | ❓ 待确认 | 取决于序列化时是否过滤 |
| **Messages** | ❌ 不命中 | 子 prompt ≠ 父输入 |

---

## 七、完整执行流程

### spawn_subagent 的实现

```python
def spawn_subagent(description: str) -> str:
    # 1. 决定执行模式（Normal / Fork / General-Purpose）
    if subagent_type:
        messages = [{"role": "user", "content": description}]  # Normal
    elif fork_gate:
        messages = buildForkedMessages(parent_messages, description)  # Fork
    else:
        messages = [{"role": "user", "content": description}]  # General-Purpose
    
    # 2. 创建子 Agent 上下文（选择性共享）
    sub_context = createSubagentContext(parent_context)
    # readFileState 从父克隆，abortController 新建
    
    # 3. 子 Agent 运行循环（最多 30 轮）
    for _ in range(30):
        response = client.messages.create(
            model=MODEL, system=SUB_SYSTEM,
            messages=messages, tools=SUB_TOOLS, max_tokens=8000,
        )
        messages.append({"role": "assistant", "content": response.content})
        
        # 4. 安全防护：工具调用经过 hook
        if response.stop_reason != "tool_use":
            break
        for block in response.content:
            if block.type == "tool_use":
                blocked = trigger_hooks("PreToolUse", block)
                if blocked:
                    continue  # 权限拦截
                output = handler(**block.input)
                trigger_hooks("PostToolUse", block, output)
    
    # 5. 只返回最后的文本结论，中间过程全部丢弃
    return extract_text(messages[-1]["content"])
```

### 完整执行流程示例

```
用户输入："分析这个项目使用了什么测试框架"
    ↓
主 Agent 循环开始
    ↓
LLM 分析任务："这需要读很多文件来追踪"
    ↓
决定调用 task 工具
    ↓
tool_use: task
    description = "Find testing framework..."
    ↓
主 Agent 执行 spawn_subagent(description)
    ↓
┌─────────────────────────────────────────────┐
│ Subagent 开始                                │
│                                              │
│ messages = [{"role": "user", "content": ...}]│
│                                              │
│ Subagent 循环（最多 30 轮）：                 │
│                                              │
│ Round 1:                                     │
│     LLM 调用：tool_use: read_file            │
│     ↓                                        │
│     trigger_hooks("PreToolUse", block)       │
│     ↓                                        │
│     output = run_read("package.json")        │
│     ↓                                        │
│     trigger_hooks("PostToolUse", block)      │
│     ↓                                        │
│     messages.append(tool_result)             │
│                                              │
│ Round 2:                                     │
│     LLM 调用：tool_use: glob                 │
│     ↓                                        │
│     messages.append(tool_result)             │
│                                              │
│ Round 3:                                     │
│     LLM 分析完成：                            │
│         text: "项目使用 pytest..."            │
│     ↓                                        │
│     stop_reason = "end_turn"                 │
│     ↓                                        │
│     break（退出循环）                         │
│                                              │
│ 提取结论：                                    │
│     result = extract_text(messages[-1])      │
│                                              │
│ return result                                │
│                                              │
│ messages 被丢弃                              │
└─────────────────────────────────────────────┘
    ↓
主 Agent 收到 tool_result：
    content = "项目使用 pytest..."
    ↓
主 Agent 继续：
    messages.append(tool_result)
    主 messages 只增加了一条摘要消息
    ↓
主 Agent 继续处理...
```

---

## 八、关键设计决策

```
决策 1：上下文隔离
   ├─ 选择：全新 messages[]
   ├─ 原因：子 Agent 的中间过程不污染主 Agent 的上下文
   └─ 实现：messages = [{"role": "user", "content": description}]

决策 2：只回传结论
   ├─ 选择：extract_text(last_message)
   ├─ 原因：不是回传整个 messages 列表
   └─ 实现：return extract_text(messages[-1]["content"])

决策 3：禁止递归
   ├─ 选择：子 Agent 无 task 工具（教学版）
   ├─ 选择：多重防护（生产版：禁用集合 + Fork 标记 + teammate 特殊处理）
   ├─ 原因：防止子 Agent 再 spawn 新的子 Agent
   └─ 实现：SUB_TOOLS 不包含 "task" 或 isInForkChild()

决策 4：安全策略不跳过
   ├─ 选择：子 Agent 工具调用也走 PreToolUse hook
   ├─ 原因：上下文隔离不代表权限隔离
   └─ 实现：trigger_hooks("PreToolUse", block) 在子循环中

决策 5：有选择性共享
   ├─ 选择：readFileState 从父克隆
   ├─ 原因：避免重复读文件，节省 token
   └─ 实现：cloneLRUCache(parentContext.readFileState)
```

---

## 九、教学版 vs 生产版对比

| 方面 | 教学版（s06） | 生产版（ClaudeCode） |
|------|--------------|-------------------|
| 执行模式 | 只有一种（全新 messages） | 三种（Normal / Fork / General-Purpose） |
| Prompt Cache | 不涉及 | Fork 模式的核心优化 |
| 递归防护 | 简单"无 task 工具" | 多重防护（禁用集合 + Fork 标记 + teammate 特殊处理） |
| Context Isolation | 完全隔离 | 有选择性共享（readFileState） |
| Tools 处理 | 明确两套定义 | 继承 + 禁用机制 |
| Async vs Sync | 只展示同步 | 支持异步路径（run_in_background） |

**教学版的简化是刻意的**：
- 三种模式 → 一种：概念清晰
- Prompt Cache → 省略：教学版不涉及 API 层优化
- 递归防护 → 简化：先理解核心模型
- Tools → 两套定义：教学清晰
- Async → 留给后续章节

---

## 十、最终理解与澄清

### Fork 模式的核心误解纠正

#### 误解 1：messages 前缀可以命中

**错误理解**：
```
理想情况下 messages 前缀相同，节省 90%
```

**正确理解**：
```
不存在"理想情况下 messages 前缀相同"
Fork 模式的设计就是 messages 不命中
Messages 不命中不是因为"真实使用中不命中"
而是因为"Fork 模式构造的 messages 就是与父不同"
```

#### 误解 2：buildForkedMessages() 是为了缓存命中

**错误理解**：
```
buildForkedMessages() 的作用：
  ├─ 精确构造 cache-friendly 消息前缀
  └─ 保留父 assistant message（缓存命中）
```

**正确理解**：
```
buildForkedMessages() 的作用：
  ├─ 不是为了让 messages 缓存命中 ❌
  ├─ 而是为了给子 Agent 提供上下文 ✓
  │   ├─ 子 Agent 看到父的推理过程
  │   ├─ 不看到父的具体工具输出
  │   └─ 接受新任务
  └─ 缓存命中靠的是 system + tools ✓
```

### 真实的 Fork 模式

```
目的：
  1. 提供上下文 ✓（继承父 assistant message）
  2. 节省 token ✓（System + Tools 缓存命中）

实现：
  ├─ System prompt: 继承 ✓ → 缓存命中 ✓
  ├─ Tools: 继承 ✓ → 缓存命中 ✓
  ├─ Messages: 从 assistant 开始 ❌ → 缓存不命中 ❌
  └─ 节省：System + Tools = 7000 tokens（45%-82%）

Messages 的作用：
  ├─ 不是为了缓存命中 ❌
  ├─ 而是为了提供上下文 ✓
  │   ├─ 看到父的推理过程
  │   ├─ 不看到具体工具输出
  │   └─ 接受新任务
  └─ 这是设计的一部分 ✓
```

### 用户理解的正确与修正

#### 正确的部分 ✓

```
1. Fork 模式的两个作用：
   ✓ 提供上下文（继承父 assistant message）
   ✓ 节省 token（通过 Prompt Cache）

2. Prompt Cache 的原理：
   ✓ 如果完全相同 → 完全命中
   ✓ 如果部分相同 → 只计算新增部分

3. 最终结论：
   ✓ "99.9% 不可能出现 messages 前缀相同"
```

#### 需要修正的部分 ❌

```
误解：理想情况下 messages 前缀相同

修正：
  ├─ 不存在"理想情况下 messages 前缀相同"
  ├─ Fork 模式的 messages 从 assistant 开始
  ├─ 父 messages 从 user 开始
  ├─ messages 前缀不可能相同 ❌
  └─ 这是设计的一部分 ✓
```

---

## 十一、核心要点总结

1. **三种执行模式**：Normal、Fork、General-Purpose，根据触发条件选择

2. **Fork 模式的核心**：
   - 提供上下文（继承父 assistant message）
   - 节省 token（System + Tools 缓存命中）

3. **Prompt Cache 的机制**：
   - 缓存 system + tools + messages 的整体序列
   - 前缀匹配从 system 开始（不是 messages[0]）
   - 字节级一致、连续匹配

4. **Messages 缓存命中**：
   - 理论上可能（0.1%）
   - 实际上几乎不可能（99.9% 不命中）
   - Fork 模式设计就是 messages 不命中

5. **Context Isolation 的粒度**：
   - 完全隔离：messages（对话历史）
   - 部分共享：readFileState（文件读取状态）
   - 单向传播：abortController（控制信号）
   - 精确传播：setAppState（UI 状态）

6. **安全防护多重**：
   - 工具禁用 + Fork 标记 + teammate 特殊处理

7. **性能优化关键**：
   - Fork 模式：System + Tools 缓存命中（45%-82%）

---

## 十二、类比理解总结

```
Normal Subagent：
  像"开一个新终端"，做完关掉，结果写回原终端

Fork Subagent：
  像"Git branch"，共享主干历史，但有自己的分支
  更重要的是：让 API 的"缓存系统"生效，节省成本

Context Isolation：
  像"进程隔离"，但共享"文件缓存"
  对话历史隔离，但文件读取状态共享

Prompt Cache：
  像"浏览器缓存"
  相同的内容不需要重新下载（计算）
  节省时间、节省成本

buildForkedMessages()：
  像"老师给学生布置任务"
  学生看到老师的思考过程，不看具体资料
```

---

## 十三、关键代码文件（基于 CC 源码）

```
AgentTool.tsx         - Agent 工具的定义和三种模式的判断
runAgent.ts           - Agent 运行循环，sync agent 的 shareSetAppState
forkSubagent.ts       - Fork 模式的核心实现，buildForkedMessages()
forkedAgent.ts        - Fork Agent 的上下文创建，createSubagentContext()
agentToolUtils.ts     - 递归防护和 teammate 场景的特殊处理
constants/tools.ts    - Agent 工具的默认禁用配置
```

---

**最终理解**：

Subagent 不是简单的"开新终端"，而是一个精心设计的系统：
- 三种模式适应不同场景
- Fork 模式优化性能成本
- 精确隔离对话历史，智能共享工作状态
- 多重安全防护，权限不跳过
- 异步支持，后台运行

**核心哲学**：
```
上下文隔离 + 只保留结论 + 有选择性共享 + 性能优化 + 安全不跳过
```

这就是 ClaudeCode Subagent 的完整设计理念。

---

<!-- 文档版本：v8.0 - 最终整合版 -->
<!-- 创建时间：2026-06-22 -->
<!-- 整合所有分析文档，系统化、全面化 -->
# Messages 缓存命中的真实可能性分析

---

## 用户的关键问题

**问题**：主 agent 的 messages[0] 是 user，子 agent 的 messages[0] 也是 user（Normal/GP），或者 messages[0] 是 assistant（Fork）。那 messages 永远无法命中缓存吗？

---

## 逐个场景分析

### 场景 1: Normal Subagent / General-Purpose

```typescript
// 主 Agent 的 messages
messages = [
  {"role": "user", "content": "修 bug #123"},  // messages[0]
  {"role": "assistant", "content": [...]},
  {"role": "user", "content": [...]},
  ...
]

// 子 Agent 的 messages（Normal/GP）
messages = [
  {"role": "user", "content": "Find testing framework"},  // messages[0]
  // 只有这一条，全新的 prompt
]
```

**分析**：
- 父 messages[0]: `user: "修 bug #123"`
- 子 messages[0]: `user: "Find testing framework"`
- Role 相同（都是 user） ✓
- Content 不同 ❌（"修 bug" vs "Find testing framework")
- **字节级不一致 ❌**
- **Messages 前缀不命中 ❌**

**关键**：Prompt Cache 要求字节级一致，包括 content 的每个字符。"修 bug" 和 "Find testing framework" 完全不同，所以不命中。

---

### 场景 2: Fork Subagent

```typescript
// 主 Agent 的 messages
messages = [
  {"role": "user", "content": "修 bug #123"},  // messages[0] - user
  {"role": "assistant", "content": [...]},     // messages[1]
  {"role": "user", "content": [...]},          // messages[2]
  ...
]

// Fork 子 Agent 的 messages
messages = [
  {"role": "assistant", "content": [...]},     // messages[0] - assistant
  {"role": "user", "content": [...]},          // messages[1]
  ...
]
```

**分析**：
- 父 messages[0]: `user`
- 子 messages[0]: `assistant`
- Role 不同 ❌（user vs assistant）
- **从第一个 token 就不同 ❌**
- **Messages 前缀完全不命中 ❌**

---

### 场景 3: 理论上可能命中的情况

**假设一个极端场景**：

```typescript
// 主 Agent 的 messages
messages = [
  {"role": "user", "content": "分析项目"},
  {"role": "assistant", "content": "好的，我开始分析..."},
  {"role": "user", "content": "继续"},
]

// 子 Agent 的 messages（如果子任务与父任务完全相同）
messages = [
  {"role": "user", "content": "分析项目"},  // 与父 messages[0] 完全相同 ✓
  {"role": "assistant", "content": "好的，我开始分析..."},  // 与父 messages[1] 完全相同 ✓
  {"role": "user", "content": "换个角度继续"},  // 与父 messages[2] 不同 ❌
]
```

**分析**：
- 父 messages[0]: `user: "分析项目"`
- 子 messages[0]: `user: "分析项目"` ← **字节级一致 ✓**
- 父 messages[1]: `assistant: "好的，我开始分析..."`
- 子 messages[1]: `assistant: "好的，我开始分析..."` ← **字节级一致 ✓**
- 父 messages[2]: `user: "继续"`
- 子 messages[2]: `user: "换个角度继续"` ← **不同 ❌**

**结果**：
- Messages 前缀命中 [0] + [1] = 2 条消息 ✓
- System + Tools + Messages[0:2] 缓存命中 ✓

---

### 场景 4: 真实场景下会不会发生？

**问题**：这种"子任务与父任务完全相同"的情况会发生吗？

**答案：几乎不可能。**

**原因**：

#### 1. Normal/GP Subagent 的设计

```typescript
// Normal/GP 的 messages 构造
messages = [{"role": "user", "content": description}]

// description 是子任务的描述，总是与父的原始输入不同
// 例如：
// 父 messages[0]: "修 bug #123"
// 子 messages[0]: "Find testing framework"（完全不同的任务）
```

#### 2. Fork Subagent 的设计

```typescript
// Fork 的 messages 构造
messages = buildForkedMessages(forkDirective, parentAssistantMessage)

// buildForkedMessages 返回：
// [0] assistant（深拷贝父 messages[1]）
// [1] user（placeholder + FORK_BOILERPLATE + forkDirective）

// 子 messages 从 assistant 开始，跳过了父 messages[0]（user）
// 所以 messages 前缀完全不匹配
```

#### 3. Claude Code 的实际使用场景

```
用户输入："修 bug #123"

主 Agent 分析：
  ├─ "这需要先找测试框架" → spawn 子 Agent
  ├─ 调用 Agent 工具：
  │   tool_use: Agent
  │     input: {
  │       prompt: "Find testing framework...",  ← 新任务，与父输入不同
  │       subagent_type: "Explore"
  │     }
  └─ 子 Agent 的 messages[0] = "Find testing framework..." ← 与父 messages[0] 不同

──────────────────────────────────────────────────────────

用户输入："分析项目"

主 Agent 分析：
  ├─ "需要深入分析" → Fork 子 Agent
  ├─ 调用 Agent 工具：
  │   tool_use: Agent
  │     input: {
  │       prompt: "换个角度分析",  ← Fork directive
  │     }
  └─ buildForkedMessages() 构造：
  │     messages = [
  │       assistant（继承父 messages[1]），← 不是 user
  │       user（FORK_BOILERPLATE + directive）
  │     ]
  └─ 子 messages[0] 是 assistant ← 与父 messages[0]（user）不同
```

---

## 逐个字节级分析

### 为什么字节级一致这么难？

**Prompt Cache 的精确要求**：

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
    " #",       // T9
    "123",      // T10
    "}",        // T11
  ]
  
如果子的 messages[0] 是：
  {"role": "user", "content": "Find testing framework"}
  
  → tokens: [
    "{",        // T0' ✓ 相同
    "role",     // T1' ✓ 相同
    ":",        // T2' ✓ 相同
    "user",     // T3' ✓ 相同
    ",",        // T4' ✓ 相同
    "content",  // T5' ✓ 相同
    ":",        // T6' ✓ 相同
    "Find",     // T7' ❌ 不同（vs "修")
    " testing", // T8' ❌ 不同（vs " bug")
    ...
  ]
  
从 T7 开始就不同 ❌
前缀匹配断裂 ❌
Messages 不命中 ❌
```

---

## 理论上 messages 能命中吗？

### 可能的场景（理论上）

**必须满足的条件**：

```
条件 1: 子 messages[0] 与父 messages[0] 字节级一致
  ├─ role 相同 ✓
  ├─ content 每个字符相同 ✓
  └─ 整个 JSON 结构相同 ✓

条件 2: 子 messages[1] 与父 messages[1] 字节级一致（如果存在）
  ├─ role 相同 ✓
  ├─ content 每个字符相同 ✓
  └─ tool_use_id 相同（如果有 tool_use） ✓

条件 3: 连续匹配
  ├─ 不能跳过中间的消息 ✓
  └─ 必须从头开始连续匹配 ✓
```

### 真实场景下不可能的原因

```
原因 1: 子任务的描述总是与父输入不同
  ├─ 父输入："修 bug #123"
  ├─ 子任务："Find testing framework"
  └─ 完全不同的内容 ❌

原因 2: Fork 模式跳过父 messages[0]
  ├─ 子 messages 从 assistant 开始
  ├─ 父 messages 从 user 开始
  └─ role 不同 ❌

原因 3: 即使内容相似，也不可能字节级一致
  ├─ "修 bug #123" vs "修 bug #124"
  ├─ 只有一个字符不同（#123 vs #124）
  └─ 字节级不一致 ❌
```

---

## 特殊情况：同一个请求的多次调用

### 可能命中的特殊情况

**场景**：同一个子任务被多次调用

```typescript
// 第一次调用子 Agent
messages_1 = [
  {"role": "user", "content": "Find testing framework"},
]

// 第二次调用相同的子 Agent（完全相同的 prompt）
messages_2 = [
  {"role": "user", "content": "Find testing framework"},  ← 与 messages_1[0] 完全相同 ✓
]
```

**分析**：
- messages_2[0] 与 messages_1[0] 字节级一致 ✓
- System + Tools + Messages[0] 缓存命中 ✓

**但这种情况在 Claude Code 中几乎不会发生**：
- 因为每次子任务都有不同的 context
- 即使 prompt 相同，system prompt 或 tools 可能不同
- 或者 messages 后续不同

---

## 最终答案

### Messages 缓存命中的可能性

**理论上**：
- ✅ **可能命中**，如果子 messages 前几条与父 messages 前几条字节级一致

**实际上**：
- ❌ **几乎不可能命中**，因为：
  1. Normal/GP：子 prompt 与父输入总是不同
  2. Fork：子 messages 从 assistant 开始，跳过父 messages[0]
  3. 字节级一致的要求非常严格

### Claude Code 的真实情况

```
Normal/GP Subagent:
  ├─ System + Tools 缓存命中 ✓（如果相同）
  ├─ Messages 缓存不命中 ❌（prompt 不同）
  └─ 节省约 45%（System + Tools）

Fork Subagent:
  ├─ System + Tools 缓存命中 ✓
  ├─ Messages 缓存不命中 ❌（从 assistant 开始）
  └─ 节省约 45%-82%（取决于子对话长度）
```

### 用户的理解是否正确？

**用户问**："那 messages 永远无法命中缓存？"

**答案**：
- **理论上不是"永远"**，有极端情况可能命中
- **实际上"几乎永远"不命中**，99.9% 的场景不命中
- **Claude Code 的设计中，messages 不命中是正常的**

---

## Claude Code 的设计哲学

### 为什么 messages 不命中也没关系？

**原因**：
```
System + Tools 占大头：
  ├─ System: 5000 tokens
  ├─ Tools: 2000 tokens
  ├─ Messages: 100-8600 tokens（变化）
  └─ System + Tools = 7000 tokens（稳定）

System + Tools 缓存命中：
  ├─ 节省 7000 tokens 的计算
  ├─ 成本从 1x → 0.1x
  └─ 已经节省了大部分成本

Messages 不命中：
  ├─ Messages 是变化的部分
  ├─ 本来就应该重新计算
  └─ 这是设计的一部分
```

**类比**：
```
就像编译代码：

编译过程：
  ├─ 预处理（加载库）← 缓存命中 ✓（System + Tools）
  ├─ 编译源代码 ← 重新计算 ❌（Messages）
  └─ 链接 ← 缓存命中 ✓（如果相同）

库文件（System + Tools）：
  ├─ 很大（7000 tokens）
  ├─ 很稳定（不变化）
  └─ 缓存命中效果好 ✓

源代码（Messages）：
  ├─ 变化（每次不同）
  ├─ 本来就应该重新编译
  └─ 不缓存是正常的 ❌
```

---

## 总结

### Messages 缓存命中的可能性

| 场景 | Messages 前缀命中 | 原因 |
|------|------------------|------|
| **Normal/GP** | ❌ 不命中 | 子 prompt ≠ 父输入（内容不同） |
| **Fork** | ❌ 不命中 | 子 messages[0] ≠ 父 messages[0]（role 不同） |
| **理论上极端情况** | ✓ 可能命中 | 子 messages 前几条与父字节级一致 |
| **实际场景** | ❌ 几乎不命中 | 99.9% 的场景不命中 |

### Claude Code 的设计

```
缓存命中策略：
  ├─ System + Tools 缓存命中 ✓（大头，稳定）
  ├─ Messages 不命中 ❌（变化，本来就应该重新计算）
  └─ 已经节省了大部分成本 ✓

设计哲学：
  ├─ 缓存稳定部分（System + Tools）
  ├─ 重新计算变化部分（Messages）
  └─ 这是最优的缓存策略 ✓
```

---

<!-- 文档版本：v5.0 -->
<!-- 创建时间：2026-06-22 -->
<!-- 深度分析 Messages 缓存命中的可能性 -->
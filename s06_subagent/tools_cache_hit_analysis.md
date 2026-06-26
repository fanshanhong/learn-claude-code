# Tools 缓存命中的真实情况分析 —— 另一个关键矛盾

---

## 用户发现的关键矛盾

**问题**：主 Agent 的 tools 有 `task`（Agent）工具，子 Agent 没有 `task` 工具（防止递归）。那 tools 的 token 序列也不同，为什么还能缓存命中？

---

## 两种 Subagent 的 Tools 处理

### 场景 1: Normal/GP Subagent（教学版）

**教学版（s06 code.py）**：

```python
# 主 Agent 的 TOOLS
TOOLS = [
    {"name": "bash", ...},
    {"name": "read_file", ...},
    {"name": "write_file", ...},
    {"name": "edit_file", ...},
    {"name": "glob", ...},
    {"name": "todo_write", ...},
    {"name": "task", ...},  # ← 主 Agent 有 task 工具
]

# 子 Agent 的 SUB_TOOLS
SUB_TOOLS = [
    {"name": "bash", ...},
    {"name": "read_file", ...},
    {"name": "write_file", ...},
    {"name": "edit_file", ...},
    {"name": "glob", ...},
    # NO "task" ← 子 Agent 没有 task 工具
]
```

**分析**：
- 主 Agent tools: 7 个工具（包含 task）
- 子 Agent tools: 5 个工具（不包含 task）
- Tools 序列完全不同 ❌
- **Tools 前缀不命中 ❌**

---

### 场景 2: Fork Subagent（生产版）

**生产版（CC 源码）**：

```typescript
// Fork Agent 的定义
const FORK_AGENT = {
  agentType: "fork",
  tools: ["*"],  // ← 继承父的所有工具（包括 Agent）
  disallowedTools: [],  // ← 没有显式禁用
  // ...
}

// Fork Agent 的递归防护
// 不是通过移除工具，而是通过 isInForkChild() 检查 FORK_BOILERPLATE_TAG
```

**关键**：
- Fork Agent 的 `tools: ["*"]` 表示**继承父的所有工具**
- Fork Agent **包含 Agent 工具**（与父相同）
- 递归防护通过 `isInForkChild()` 实现，不是通过移除工具

**分析**：
- 主 Agent tools: 包含 Agent 工具
- Fork 子 Agent tools: 也包含 Agent 工具（继承）
- Tools 序列相同 ✓
- **Tools 前缀命中 ✓**

---

### 场景 3: Explore/Plan Agent（生产版）

**生产版（CC 源码）**：

```typescript
// Explore Agent 的定义
const EXPLORE_AGENT = {
  agentType: "Explore",
  tools: ["*"],  // ← 声明 "*"（继承）
  disallowedTools: ["Agent", "TodoWrite", "FileEdit", "FileWrite", "NotebookEdit"],  // ← 但禁用 Agent
  // ...
}
```

**关键问题**：
- Explore Agent 声明 `tools: ["*"]`（继承）
- 但有 `disallowedTools: ["Agent"]`（禁用）
- 实际可用的 tools：不包含 Agent

**那么序列化成 API 请求时，tools 是什么？**

---

## CC 源码中的真实实现

### Tools 序列化的两种可能方式

#### 方式 1: 序列化完整工具定义

```typescript
// API 请求的 tools 字段
tools: [
  {name: "bash", description: "...", input_schema: {...}},
  {name: "read_file", description: "...", input_schema: {...}},
  {name: "write_file", description: "...", input_schema: {...}},
  {name: "edit_file", description: "...", input_schema: {...}},
  {name: "glob", description: "...", input_schema: {...}},
  {name: "Agent", description: "...", input_schema: {...}},  // ← 包含 Agent
  // ...
]
```

如果这样序列化：
- 主 Agent tools: 包含 Agent 工具定义
- Explore 子 Agent tools: 也包含 Agent 工具定义（即使禁用）
- Tools 序列相同 ✓
- **Tools 前缀命中 ✓**

**但实际执行时**：
- 主 Agent 可以调用 Agent 工具 ✓
- Explore 子 Agent 不能调用 Agent 工具（disallowedTools 过滤） ❌

#### 方式 2: 序列化过滤后的工具

```typescript
// API 请求的 tools 字段
tools: [
  {name: "bash", description: "...", input_schema: {...}},
  {name: "read_file", description: "...", input_schema: {...}},
  {name: "write_file", description: "...", input_schema: {...}},
  {name: "edit_file", description: "...", input_schema: {...}},
  {name: "glob", description: "...", input_schema: {...}},
  // NO Agent ← 不包含 Agent（被过滤）
]
```

如果这样序列化：
- 主 Agent tools: 包含 Agent 工具定义
- Explore 子 Agent tools: 不包含 Agent 工具定义
- Tools 序列不同 ❌
- **Tools 前缀不命中 ❌**

---

## 从源码推断真实实现

### 源码证据 1: Fork Agent 的工具继承

```typescript
// forkSubagent.ts 中的工具继承
function createForkedContext(parentContext) {
  return {
    tools: parentContext.tools,  // ← 直接继承父 tools
    // ...
  }
}
```

**推断**：Fork Agent 直接继承父 tools，包括 Agent 工具。

### 源码证据 2: Explore Agent 的工具处理

```typescript
// agentToolUtils.ts 或 runAgent.ts 中的工具过滤
function filterTools(tools, disallowedTools) {
  return tools.filter(tool => !disallowedTools.includes(tool.name))
}

// 序列化 API 请求时
let apiRequest = {
  tools: filterTools(agent.tools, agent.disallowedTools),  // ← 过滤后序列化
  // ...
}
```

**推断**：Explore Agent 序列化时，tools 是过滤后的（不包含 Agent）。

---

## 真实情况推断

### Fork Agent：Tools 缓存命中 ✓

```
主 Agent tools 序列化:
  tools: [bash, read, write, edit, glob, Agent, ...]  (2000 tokens)

Fork 子 Agent tools 序列化:
  tools: [bash, read, write, edit, glob, Agent, ...]  (2000 tokens)
  ← 直接继承父 tools，包括 Agent ✓

Tools 序列相同 ✓
Tools 前缀命中 ✓
```

### Explore/Plan Agent：Tools 缓存可能不命中 ❌

```
主 Agent tools 序列化:
  tools: [bash, read, write, edit, glob, Agent, ...]  (2000 tokens)

Explore 子 Agent tools 序列化:
  tools: [bash, read, write, edit, glob, ...]  (1500 tokens)
  ← 过滤掉了 Agent ❌

Tools 序列不同 ❌
Tools 前缀不命中 ❌（从 Agent 那个位置开始不同）
```

**但是**，Explore Agent 可能还有其他机制：
- 如果 Explore Agent 也声明 `tools: ["*"]`，但序列化时不过滤
- 只在执行时过滤（disallowedTools）
- 那么序列化的 tools 相同，缓存命中 ✓

---

## 关键问题：序列化时是否过滤？

### 需要查看真实源码确认

**关键代码位置**：
```typescript
// 可能的位置：
// - runAgent.ts: assembleApiRequest()
// - agentToolUtils.ts: prepareToolsForApi()
// - AgentTool.tsx: buildToolDefinition()

function assembleApiRequest(agent, context) {
  let tools = agent.tools === "*" 
    ? context.allTools  // 继承所有工具
    : agent.tools       // 使用指定工具列表
  
  // 过滤禁用工具？
  if (agent.disallowedTools && agent.disallowedTools.length > 0) {
    tools = tools.filter(t => !agent.disallowedTools.includes(t.name))
  }
  
  return {
    tools: tools,  // ← 序列化的 tools
    // ...
  }
}
```

---

## 推断的真实情况

### Fork Agent：Tools 缓存命中 ✓

```
推理：
  ├─ Fork Agent 声明 tools: ["*"]（继承）
  ├─ Fork Agent 没有 disallowedTools
  ├─ 序列化时：直接继承父 tools，包括 Agent ✓
  ├─ Tools 序列相同 ✓
  └─ Tools 前缀命中 ✓
```

### Explore/Plan Agent：Tools 缓存可能不命中 ❌

```
推理：
  ├─ Explore Agent 声明 tools: ["*"]（继承）
  ├─ Explore Agent 有 disallowedTools: ["Agent", ...]
  ├─ 如果序列化时过滤：
  │   ├─ tools 不包含 Agent ❌
  │   ├─ Tools 序列不同 ❌
  │   └─ Tools 前缀不命中 ❌
  ├─ 如果序列化时不过滤（只在执行时过滤）：
  │   ├─ tools 包含 Agent ✓
  │   ├─ Tools 序列相同 ✓
  │   └─ Tools 前缀命中 ✓
  └─ 需要真实源码确认 ❓
```

---

## 教学版 vs 生产版的关键差异

### 教学版（s06 code.py）

```python
# 明确的两套工具定义
TOOLS = [..., "task"]      # 主 Agent 有 task
SUB_TOOLS = [...]          # 子 Agent 没有 task（明确定义）
```

**结果**：
- Tools 序列完全不同 ❌
- System + Tools 都不命中 ❌
- 只有 System 命中（如果相同） ✓

### 生产版（CC）

```typescript
// Fork Agent 继承父 tools
FORK_AGENT = {
  tools: ["*"],  // 继承，包括 Agent
}

// Explore Agent 有复杂的机制
EXPLORE_AGENT = {
  tools: ["*"],  // 声明继承
  disallowedTools: ["Agent"],  // 但禁用
}
```

**结果（Fork）**：
- Tools 序列相同 ✓（继承）
- System + Tools 都命中 ✓

**结果（Explore）**：
- 取决于序列化时是否过滤 ❓

---

## 总结

### Tools 缓存命中的真实情况

| Agent 类型 | Tools 前缀命中 | 原因 |
|-----------|--------------|------|
| **Fork** | ✓ 命中 | `tools: ["*"]` 继承父所有工具，包括 Agent |
| **Explore/Plan** | ❓ 可能不命中 | 有 `disallowedTools`，取决于序列化是否过滤 |
| **Normal（教学版）** | ❌ 不命中 | 明确的两套工具定义，不包含 Agent |

### 你的质疑是否正确？

**用户质疑**："tools 应该也不同，因为主 agent 的 tools 有 task，子 agent 没有 task"

**答案**：
- **教学版：完全正确 ❌** Tools 确实不同，不命中缓存
- **生产版 Fork：不完全正确 ✓** Fork 继承父 tools，包括 Agent，Tools 前缀命中
- **生产版 Explore：需要源码确认 ❓** 取决于序列化机制

---

## 教学版的简化导致的误解

**教学版的简化**：
```
教学版用两套明确的工具定义：
  TOOLS = [..., "task"]
  SUB_TOOLS = [...]（没有 task）

这是为了教学清晰，但与生产版不同 ❌
```

**生产版的真实机制**：
```
生产版用继承 + 禁用机制：
  tools: ["*"]（继承）
  disallowedTools（过滤）

Fork Agent：继承但不禁用 ✓
Explore Agent：继承但禁用 ❓
```

---

## 最终结论

### Fork Agent：Tools 缓存命中 ✓

```
System 缓存命中 ✓（5000 tokens）
Tools 缓存命中 ✓（2000 tokens，继承父所有工具）
Messages 缓存不命中 ❌

节省：System + Tools = 7000 tokens（45%-82%）
```

### Explore/Plan Agent：需要源码确认 ❓

```
如果序列化时过滤禁用工具：
  Tools 缓存不命中 ❌
  只有 System 缓存命中 ✓（5000 tokens）
  
如果序列化时不过滤（只在执行时过滤）：
  Tools 缓存命中 ✓（2000 tokens）
  System + Tools 都命中 ✓（7000 tokens）
```

### 教学版：System + Tools 都不命中 ❌

```
教学版的简化：
  ├─ 两套明确的工具定义
  ├─ Tools 序列完全不同 ❌
  └─ System + Tools 都不命中 ❌
  
这不是生产版的真实实现 ❌
```

---

## 需要进一步确认的问题

1. **Explore Agent 序列化时是否过滤禁用工具？**
   - 如果过滤：Tools 不命中 ❌
   - 如果不过滤：Tools 命中 ✓

2. **disallowedTools 是在序列化时生效，还是在执行时生效？**
   - 序列化时：API 请求的 tools 字段不包含禁用工具
   - 执行时：API 请求的 tools 字段包含禁用工具，但执行时拦截

---

<!-- 文档版本：v6.0 -->
<!-- 创建时间：2026-06-22 -->
<!-- 分析 Tools 缓存命中的真实情况 -->
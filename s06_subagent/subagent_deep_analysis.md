# ClaudeCode Subagent 深度解析 —— 从设计理念到实现细节

## 一、宏观视角：Subagent 的核心设计理念

### 问题根源：上下文污染

想象你正在修一个复杂的 bug：
1. 你读了 30 个文件来追踪调用链
2. 中间尝试了多种修复方案，失败了 3 次
3. 查了 10 次文档，运行了 15 次测试
4. messages 列表涨到 120 条

**问题**：这 120 条对话中，大部分是"追踪调用链"的中间过程，和"修 bug"这个最终目标无关。这些中间过程占着上下文位置，让你越来越"健忘"——记不住最初的问题是什么了。

### 解决方案：开一个"新终端"

**人类的工作方式**：
- 在修 bug 时，开一个**新终端**来追踪调用链
- 追踪完了，终端关掉，结果写进笔记
- 回到原来的终端继续修 bug

**Agent 的工作方式**：
- 在修 bug 时，spawn 一个**子 Agent** 来追踪调用链
- 子 Agent 用全新的 messages[]
- 追踪完了，只把结论回传给主 Agent
- 子 Agent 的整个对话历史被丢弃

**核心设计理念**：
```
上下文隔离 + 只保留结论 + 安全策略不跳过
```

---

## 二、三种执行模式：不是一种，是三种

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

## 三、核心概念详解

### 1. Normal Subagent（标准子 Agent）

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

### 2. Fork 模式（分支模式）—— 核心是 Prompt Cache

**这是教学版没有讲的核心概念！**

#### 什么是 Prompt Cache？

Anthropic API 有一个特性：**Prompt Cache**
- 如果多个请求的 system prompt、tools、messages 前缀完全一致
- API 服务器不需要重新计算，直接使用缓存
- 成本降低 90%，速度提升 10 倍

#### Fork 模式的核心设计

**不是创建全新上下文，而是构造 cache-friendly 前缀**：

```
父 Agent 的 messages:
[
  {"role": "user", "content": "修 bug"},
  {"role": "assistant", "content": "...", "tool_use": [...]},
  {"role": "user", "content": [tool_results]},
  {"role": "assistant", "content": "..."},
]

Fork 子 Agent 的 messages (通过 buildForkedMessages() 构造):
[
  {"role": "user", "content": "修 bug"},                    # 相同
  {"role": "assistant", "content": "...", "tool_use": [...]}, # 相同
  {"role": "user", "content": [placeholder_tool_results]},   # 占位符
  {"role": "user", "content": "FORK_BOILERPLATE_TAG"},       # Fork 标记
  {"role": "user", "content": "新任务描述"},                  # 新任务
]
```

#### 缓存命中的五个关键组件

必须**字节级一致**：
1. **System prompt**：完全相同
2. **Tools**：完全相同
3. **Model**：完全相同
4. **Messages 前缀**：父 assistant message 完全相同
5. **Thinking config**：完全相同

#### Placeholder Tool Results 的作用

**问题**：父 Agent 可能已经调用了很多工具，子 Agent 不需要这些结果

**解决**：
- 生成占位符 tool_results："Result not shown in fork"
- 这些占位符的目的是让 messages 结构保持一致
- 子 Agent 不会看到父 Agent 的实际工具输出

#### Fork 模式的优势

- ✅ **性能优化**：Prompt Cache 命中，成本降低 90%
- ✅ **上下文共享**：保留父 Agent 的推理过程（但不包含具体结果）
- ✅ **速度提升**：API 响应更快
- ⚠️ **复杂度高**：需要精确构造 cache-friendly 消息前缀
- ⚠️ **限制多**：必须保证五个组件字节级一致

**适用场景**：
- 子任务与父任务相关
- 需要性能优化、成本控制
- 父 Agent 的推理过程有价值（但不需要具体结果）

---

### 3. Context Isolate 的粒度（上下文隔离的精确粒度）

**关键理解**：Context Isolation 不是"完全隔离"，而是**有选择性的共享**。

#### createSubagentContext() 的设计

| 字段 | 行为 | 说明 |
|------|------|------|
| `abortController` | 新的 child controller | 父 abort 向下传播，但子有自己的控制 |
| `setAppState` | 默认 no-op | UI 状态不共享，但 sync agent 通过 shareSetAppState 可以共享 |
| `readFileState` | **从父克隆** | 🔑 **关键！文件读取状态共享，避免重复读相同文件** |
| `queryTracking` | 新 chainId，depth = parentDepth + 1 | 新的追踪链，但记录深度 |

#### 为什么 readFileState 要共享？

**场景**：
- 父 Agent 已经读过 `config.py`
- 子 Agent 也需要读 `config.py`
- 如果不共享，子 Agent 会重新读取，浪费时间和 token

**解决**：
- `readFileState` 从父 Agent 克隆
- 子 Agent 直接使用父 Agent 已经读过的文件内容
- 不需要重新读取

#### Context Isolation 的三个层次

```
完全隔离：messages[]（对话历史）
部分共享：readFileState（文件读取状态）
灵活共享：setAppState（UI 状态，根据执行路径决定）
```

**设计哲学**：
- **对话历史隔离**：避免上下文污染
- **文件状态共享**：避免重复工作
- **UI 状态灵活**：根据需要决定是否共享

---

### 4. General Purpose Agent（通用 Agent）

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

### 5. Prompt Cache（提示缓存）

#### 核心机制

**Anthropic API 的缓存策略**：
```
Request 1:
  system: "You are a coding agent..." (5000 tokens)
  tools: [bash, read, write, edit, glob, task] (2000 tokens)
  messages: [prompt] (1000 tokens)
  
Request 2 (使用 Fork 模式):
  system: "You are a coding agent..." (5000 tokens) ← 完全相同，缓存命中
  tools: [bash, read, write, edit, glob, task] (2000 tokens) ← 完全相同，缓存命中
  messages: [prompt, placeholder, new_task] (2000 tokens) ← 前缀相同，缓存命中部分
  
结果：
  Request 1: 全部计算，成本 $X
  Request 2: 只计算新增部分，成本 $X/10（节省 90%）
```

#### 缓存的要求

**字节级一致**：
- 不能有任何字符差异
- 不能有任何顺序差异
- 不能有任何格式差异

**Fork 模式的挑战**：
- 必须精确构造 cache-friendly 消息前缀
- 必须保持父 assistant message 完全一致
- 必须生成 placeholder tool_results 保持结构一致

---

## 四、如何实现 Subagent？

### 实现架构

```
主 Agent                        子 Agent
+------------------+           +------------------+
| messages=[...]   |           | messages=[task]  | ← fresh or forked
|                  |  dispatch |                  |
| tool: task       | --------> | own while loop   |
|   prompt="..."   |           |   bash/read/...  |
|                  |  summary  |   (max 30 turns) |
| result = "..."   | <-------- | return last text |
+------------------+           +------------------+
       ^                              |
       |   intermediate DISCARDED     |
       +------------------------------+
```

### 核心代码流程

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

### 安全防护机制

**递归防护**：
- 子 Agent 没有 `task` 工具（简单防护）
- `isInForkChild()` 检查 `FORK_BOILERPLATE_TAG`（Fork 防护）
- `Agent` 工具默认在禁用集合（默认防护）

**权限冒泡**：
- Fork Agent 的 `permissionMode: 'bubble'`
- 子 Agent 的权限弹窗冒泡到父终端
- 用户在主终端里审批子 Agent 的操作

**Hook 不跳过**：
- 子 Agent 的工具调用也走 PreToolUse hook
- 上下文隔离不代表权限隔离

---

## 五、三种模式的实际应用场景

### 场景对比

| 场景 | 推荐模式 | 原因 |
|------|---------|------|
| 分析不相关的日志文件 | Normal Subagent | 完全独立，不需要共享上下文 |
| 继续修同一个 bug，换个角度 | Fork Subagent | 相关任务，需要 Prompt Cache 优化 |
| 不确定任务性质 | General-Purpose | 默认行为，通用处理 |
| 需要父 Agent 已读的文件 | Fork 或 Normal + readFileState 共享 | readFileState 自动共享，无需额外处理 |

---

## 六、总结：Subagent 的设计哲学

### 核心原则

```
1. 上下文隔离：子 Agent 有自己的对话历史，不污染主 Agent
2. 只保留结论：中间过程全部丢弃，只回传最后的文本
3. 有选择性共享：readFileState 共享，避免重复工作
4. 性能优化：Fork 模式共享 Prompt Cache，降低成本
5. 安全不跳过：子 Agent 的工具调用也经过权限检查
6. 禁止递归：多重防护，防止无限 spawn
```

### 类比理解

**Normal Subagent**：
- 像"开一个新终端"，做完关掉，结果写回原终端

**Fork Subagent**：
- 像"Git branch"，共享主干历史，但有自己的分支
- 更重要的是：让 API 的"缓存系统"生效，节省成本

**Context Isolation**：
- 像"进程隔离"，但共享"文件缓存"
- 对话历史隔离，但文件读取状态共享

**Prompt Cache**：
- 像"浏览器缓存"
- 相同的内容不需要重新下载（计算）
- 节省时间、节省成本

---

## 七、关键代码文件（基于 CC 源码）

```
AgentTool.tsx         - Agent 工具的定义和三种模式的判断
runAgent.ts           - Agent 运行循环，sync agent 的 shareSetAppState
forkSubagent.ts       - Fork 模式的核心实现，buildForkedMessages()
forkedAgent.ts        - Fork Agent 的上下文创建，createSubagentContext()
agentToolUtils.ts     - 递归防护和 teammate 场景的特殊处理
constants/tools.ts    - Agent 工具的默认禁用配置
```

---

## 八、教学版 vs 生产版的差异

| 方面 | 教学版（s06） | 生产版（ClaudeCode） |
|------|--------------|-------------------|
| 执行模式 | 只有一种（全新 messages） | 三种（Normal / Fork / General-Purpose） |
| Prompt Cache | 不涉及 | Fork 模式的核心优化 |
| 递归防护 | 简单"无 task 工具" | 多重防护（禁用集合 + Fork 标记 + teammate 特殊处理） |
| Context Isolation | 完全隔离 | 有选择性共享（readFileState） |
| Async vs Sync | 只展示同步 | 支持异步路径（run_in_background） |

**教学版的简化是刻意的**：
- 三种模式 → 一种：概念清晰
- Prompt Cache → 省略：不涉及 API 层优化
- 递归防护 → 简化：先理解核心模型
- Async → 留给后续章节

---

## 九、深入理解要点

### 1. Fork 模式不是为了"共享上下文"，而是为了"共享缓存"

很多人误解 Fork 模式是为了让子 Agent 共享父 Agent 的上下文。**这是错的！**

**Fork 模式的真正目的**：
- 让 Anthropic API 的 Prompt Cache 命中
- 降低 API 成本（节省 90%）
- 提升 API 响应速度（提升 10 倍）

**副作用**：
- 子 Agent 可以看到父 Agent 的推理过程（通过保留的 assistant message）
- 但看不到父 Agent 的具体工具结果（通过 placeholder tool_results）

### 2. Context Isolation 不是"完全隔离"，而是"精确隔离"

**隔离什么**：
- messages[]（对话历史）—— 完全隔离
- setAppState（UI 状态）—— 默认隔离，但可共享
- abortController（控制信号）—— 新建，但父信号向下传播

**共享什么**：
- readFileState（文件读取状态）—— 自动共享，避免重复读文件
- queryTracking（追踪链）—— 新建，但记录深度关系

**设计哲学**：
- 隔离的是"对话历史"，避免上下文污染
- 共享的是"工作状态"，避免重复工作

### 3. Prompt Cache 是 Fork 模式的核心技术

**关键要求**：字节级一致
- System prompt 不能有任何差异
- Tools 不能有任何差异
- Model 不能有任何差异
- Messages 前缀不能有任何差异
- Thinking config 不能有任何差异

**buildForkedMessages() 的作用**：
- 精确构造 cache-friendly 消息前缀
- 保留父 assistant message（完全一致）
- 生成 placeholder tool_results（保持结构一致）
- 添加 FORK_BOILERPLATE_TAG（标记 Fork，用于递归防护）

---

## 十、实际应用建议

### 何时使用 Normal Subagent？

**适用场景**：
- 子任务完全独立，不需要父 Agent 的任何上下文
- 性能要求不高，成本不敏感
- 简单直观，易于理解

**实际案例**：
```
用户：分析 logs/error.log 文件，找出最近 10 个错误

主 Agent：
  spawn Normal Subagent，prompt="分析 logs/error.log..."
  
子 Agent：
  全新 messages=[]
  读取文件，分析，返回结论
  
主 Agent：
  收到结论，继续工作
```

### 何时使用 Fork Subagent？

**适用场景**：
- 子任务与父任务相关
- 需要性能优化、成本控制
- 父 Agent 的推理过程有价值

**实际案例**：
```
用户：修 bug #123，先追踪调用链，再修复

主 Agent：
  spawn Fork Subagent，prompt="追踪 bug #123 的调用链"
  
子 Agent（Fork 模式）：
  共享父 Agent 的 system prompt、tools
  共享父 Agent 的 assistant message（推理过程）
  不共享父 Agent 的具体工具结果（placeholder）
  追踪调用链，返回结论
  
主 Agent：
  收到调用链结论，基于这个结论继续修复
```

### 何时使用 General-Purpose？

**适用场景**：
- 不确定任务性质
- 不需要特殊的 Agent 行为
- 默认通用行为足够

---

## 十一、核心要点总结

1. **三种执行模式**：Normal、Fork、General-Purpose，根据触发条件选择

2. **Fork 模式的核心**：Prompt Cache 优化，不是共享上下文

3. **Context Isolation 的粒度**：对话历史隔离，文件状态共享

4. **安全防护多重**：工具禁用 + Fork 标记 + teammate 特殊处理

5. **权限冒泡**：子 Agent 的权限弹窗到父终端

6. **性能优化关键**：Prompt Cache 的字节级一致要求

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
# LLM 的决策机制：如何处理后台任务顺序依赖

## 核心问题

**LLM 到底会采用哪种方案？**
1. 提示让用户输入"继续"？
2. 使用 Task 系统管理依赖？
3. 还是不确定，随机选择？

---

## 答案：不确定！取决于 System Prompt 的指导

### System Prompt 的关键作用

```python
# 教学版的 System Prompt（s13/code.py）
PROMPT_SECTIONS = {
    "identity": "You are a coding agent. Act, don't explain.",
    "tools": "Available tools: bash, read_file, write_file, "
             "create_task, list_tasks, get_task, claim_task, complete_task.",
    "workspace": f"Working directory: {WORKDIR}",
    "memory": "Relevant memories are injected below when available.",
}
```

**关键点**：
- System Prompt 只列出了可用工具
- ❌ 没有指导 LLM 如何处理后台任务顺序依赖
- ❌ 没有指导 LLM 是否使用 Task 系统
- ❌ 没有指导 LLM 如何告知用户

**结果**：
- LLM 需要自己决策
- 行为不确定
- 可能多种方案

---

## LLM 的可能决策路径

### 决策因素

```
LLM 决策依据：
  ① 用户请求的具体内容
  ② System Prompt 的指导（当前很弱）
  ③ 工具列表（Task 系统可用）
  ④ 过去对话历史（如果有）
  ⑤ LLM 的训练知识（常识推理）
```

---

## 场景分析：LLM 可能的三种行为

### 场景 1：用户请求很明确

```bash
s13 >> 先 npm install，完成后读取 package.json

# 用户的"完成后"暗示顺序依赖
```

#### 可能行为 A：直接执行（并行）

```
LLM 思考：
  "用户要求先 npm install 再读 package.json"
  "但 read_file 不依赖 npm install 的结果"
  "我可以同时执行，提高效率"
  
LLM 输出：
  [
    tool_use: bash "npm install" (run_in_background=true),
    tool_use: read_file "package.json"
  ]
  
stop_reason: "tool_use"
```

**适用条件**：
- read_file 不需要 npm install 的结果
- LLM 认为并行执行更高效
- 这是教学版当前最常见的行为

---

#### 可能行为 B：告知用户（顺序）

```
LLM 思考：
  "用户明确要求顺序执行"
  "我需要等 npm install 完成"
  "但后台任务何时完成我不知道"
  "我应该告知用户"
  
LLM 输出：
  "我会先在后台运行 npm install（预计 3 分钟）"
  "完成后我会继续读取 package.json"
  "请稍等片刻，然后输入'继续'"
  
  [
    tool_use: bash "npm install" (run_in_background=true)
  ]
  
stop_reason: "end_turn"
```

**适用条件**：
- LLM 认为 read_file 需要 npm install 完成
- LLM 主动告知用户
- 用户驱动后续操作

---

#### 可能行为 C：使用 Task 系统

```
LLM 思考：
  "用户要求顺序执行"
  "我可以用 Task 系统管理依赖"
  "blockedBy 参数可以表达顺序"
  
LLM 输出：
  "我会创建两个有依赖的任务"
  
  [
    tool_use: create_task(subject="Install dependencies", blockedBy=[]),
    tool_use: create_task(subject="Read package.json", blockedBy=["task_001"])
  ]
  
stop_reason: "tool_use"
```

**适用条件**：
- LLM 注意到 Task 系统可用
- LLM 认为依赖关系重要
- LLM 希望用系统化方法管理

---

### 场景 2：用户请求模糊

```bash
s13 >> npm install 并读取 package.json

# 没有明确的"完成后"暗示
```

#### 可能行为：并行执行（默认）

```
LLM 思考：
  "用户要求两个操作"
  "没有明确顺序依赖"
  "我同时执行，提高效率"
  
LLM 输出：
  [
    tool_use: bash "npm install" (run_in_background=true),
    tool_use: read_file "package.json"
  ]
```

**这是教学版当前最常见的行为**

---

## 实战验证：教学版实际行为

### 测试场景 1

```bash
cd learn-claude-code
python s13_background_tasks/code.py

s13 >> npm install 并读取 package.json

# 观察 LLM 的实际行为
```

**可能结果 A（最常见）**：
```
Turn 1:
  LLM 输出：
    [
      tool_use: bash "npm install" (run_in_background=true),
      tool_use: read_file "package.json"
    ]
  
  # LLM 认为两个操作可以并行
  # 教学版的 System Prompt 没有明确指导顺序处理
```

**可能结果 B（较少）**：
```
Turn 1:
  LLM 输出：
    "我会先 npm install，然后读 package.json"
    
    [
      tool_use: bash "npm install" (run_in_background=true)
    ]
  
Turn 2:
  LLM 输出：
    "npm install 正在后台运行..."
```

**可能结果 C（最少）**：
```
Turn 1:
  LLM 输出：
    "我会创建两个任务"
    
    [
      tool_use: create_task(subject="Install"),
      tool_use: create_task(subject="Read", blockedBy=["task_001"])
    ]
```

---

## 影响因素分析

### 因素 1：System Prompt 的指导强度

```python
# 当前 System Prompt（弱指导）
"Available tools: bash, read_file, write_file, "
"create_task, list_tasks, get_task, claim_task, complete_task."

# 结果：
# - LLM 只知道工具可用
# - 不知道何时使用 Task 系统
# - 不知道如何处理后台任务顺序
```

**改进建议**：

```python
# 强化 System Prompt（强指导）
PROMPT_SECTIONS = {
    "identity": "You are a coding agent. Act, don't explain.",
    
    "tools": """Available tools: 
      - bash: Run shell commands (use run_in_background for slow operations)
      - read_file, write_file: File operations
      - Task system: create_task, list_tasks, get_task, claim_task, complete_task
      
    Task system usage:
      - Use create_task for multi-step workflows with dependencies
      - Use blockedBy parameter to enforce order: 
        Example: create_task("Step 2", blockedBy=["task_001"])
      - For background tasks: Tell user "Background task running, please type 'continue' when ready"
    """,
    
    "workflow": """When user requests sequential operations:
      1. If operations are independent: Execute in parallel (faster)
      2. If operations have dependencies: Use Task system or tell user
      3. Background tasks: Always use run_in_background for slow commands
    """,
}
```

**效果**：
- LLM 有明确指导
- 行为更确定
- 符合预期

---

### 因素 2：用户的措辞

```bash
# 措辞 A：明确顺序
s13 >> 先 npm install，完成后读取 package.json

# LLM 更可能：顺序处理（告知用户或 Task 系统）

# 措辞 B：模糊
s13 >> npm install 并读取 package.json

# LLM 更可能：并行执行

# 措辞 C：依赖暗示
s13 >> npm install 后分析 package.json

# LLM 更可能：顺序处理（因为有"后分析"）
```

---

### 因素 3：工具是否在 package.json 中

```bash
# 如果 package.json 包含 npm install 会安装的工具
s13 >> npm install 并读取 package.json 来查看安装的工具

# LLM 思考：
#   "读取 package.json 是为了查看安装的工具"
#   "所以必须等 npm install 完成"
#   
# LLM 更可能：顺序处理

# 如果只是读取配置
s13 >> npm install 并读取 package.json 看看配置

# LLM 思考：
#   "读取配置不需要等安装完成"
#   
# LLM 更可能：并行执行
```

---

### 因素 4：LLM 的训练知识

```
LLM 的常识推理：
  "npm install 安装依赖"
  "package.json 定义依赖"
  "读取 package.json 不需要等安装完成"
  
默认推理：
  - package.json 是配置文件，读取不依赖安装
  - 可以并行执行
  
除非：
  - 用户明确要求顺序
  - 后续操作依赖安装结果
```

---

## Claude Code 生产版的 System Prompt（推测）

```typescript
// 生产版可能有更详细的指导（推测）
const SYSTEM_PROMPT = `
You are Claude Code, a coding agent.

## Background Tasks
- Use run_in_background for commands that take > 30s
- Examples: npm install, docker build, pip install
- Fast commands (< 30s) should run synchronously

## Sequential Dependencies
- If user requests "X then Y", check if Y depends on X's result
- Independent: Execute in parallel (use background for slow ones)
- Dependent: Use Task system with blockedBy, or inform user

## Task System
- Use create_task for multi-step workflows
- Use blockedBy to enforce order
- Example: create_task("Test", blockedBy=["install_task"])

## User Communication
- For long background tasks (> 2min): 
  Tell user "Background task running (~3min). Type 'continue' when ready."
- For short tasks (< 2min):
  Wait automatically, notify when complete
`
```

**效果**：
- 明确指导何时使用后台
- 明确指导如何处理顺序依赖
- 明确指导如何与用户沟通
- LLM 行为更确定

---

## 教学版的实际问题

### 问题 1：System Prompt 太简单

```python
# 教学版只列出工具
"Available tools: bash, read_file, write_file, create_task..."

# LLM 不知道：
# - 何时使用 Task 系统
# - 如何处理后台任务顺序
# - 是否应该告知用户
```

**结果**：
- LLM 行为不确定
- 可能并行，可能顺序
- 可能告知用户，可能不告知

---

### 问题 2：没有后台任务指导

```python
# 教学版没有指导
# LLM 不知道后台任务完成后如何继续

# 生产版可能有：
"Background tasks: 
  - Use run_in_background for slow commands
  - Tell user to type 'continue' when ready
  - Or use Task system to manage dependencies"
```

---

## 实战测试：三种可能的 LLM 行为

### 测试 1：并行执行（最常见）

```bash
s13 >> npm install 并读取 package.json

Turn 1:
  LLM 输出：
    [
      bash "npm install" (run_in_background=true),
      read_file "package.json"
    ]
  
  # Agent Loop 执行
  # - npm install 后台（bg_0001）
  # - read_file 同步
  
Turn 2:
  LLM 收到：
    - 占位：bg_0001 已启动
    - package.json 内容
  
  LLM 输出：
    "我看到 package.json 里定义了 react, typescript..."
    "npm install 正在后台运行..."
    
  stop_reason: "end_turn"

用户输入:
s13 >> 继续

Turn 3:
  LLM 收到：<task_notification>bg_0001 完成
  
  LLM 输出：
    "npm install 也完成了，共安装了 1423 个包"
```

**这是最常见的行为**（70% 可能）

---

### 测试 2：顺序处理 + 告知用户（较少）

```bash
s13 >> 先 npm install，完成后读取 package.json

Turn 1:
  LLM 输出：
    "我会先 npm install（预计 3 分钟），然后读取 package.json"
    "请稍等片刻，然后输入'继续'"
    
    [
      bash "npm install" (run_in_background=true)
    ]

Turn 2:
  LLM 收到：占位
  
  LLM 输出：
    "npm install 正在后台运行..."
    
  stop_reason: "end_turn"

用户等待 3 分钟...

用户输入:
s13 >> 继续

Turn 3:
  LLM 收到：<task_notification>bg_0001 完成
  
  LLM 输出：
    "npm install 完成了！现在读取 package.json"
    
    [
      read_file "package.json"
    ]

Turn 4:
  LLM 收到：package.json
  
  LLM 输出：
    "我看到 package.json 里..."
```

**这种行为较少**（20% 可能，取决于用户措辞）

---

### 测试 3：使用 Task 系统（最少）

```bash
s13 >> 先 npm install，完成后读取 package.json

Turn 1:
  LLM 输出：
    "我会创建两个有依赖的任务"
    
    [
      create_task(subject="Install dependencies", blockedBy=[]),
      create_task(subject="Read package.json", blockedBy=["task_001"])
    ]

Turn 2:
  LLM 输出：
    "开始第一个任务"
    
    [
      claim_task(task_id="task_001"),
      bash "npm install" (run_in_background=true)
    ]

# ... 后续多轮
# Task 系统管理依赖
```

**这种行为最少**（10% 可能，取决于 LLM 是否注意到 Task 工具）

---

## 如何让 LLM 行为更确定？

### 方案 1：强化 System Prompt

```python
PROMPT_SECTIONS = {
    "identity": "You are a coding agent. Act, don't explain.",
    
    "tools": """Available tools and usage guidelines:

## Background Tasks
- Use run_in_background=true for commands taking > 30s
- Examples: npm install, pip install, docker build, make
- Fast commands: Run synchronously (default)

## Sequential Dependencies
When user requests "X then Y" or "X before Y":

**Option A: Independent operations** (most common)
  - Execute in parallel for efficiency
  - Example: npm install + read package.json → parallel
  
**Option B: Dependent operations** (rare)
  - Use Task system: create_task("Y", blockedBy=["task_X"])
  - Or inform user: "Background task running. Type 'continue' when ready."

## Task System
- Use for multi-step workflows with explicit dependencies
- Use blockedBy parameter: create_task("Step 2", blockedBy=["task_001"])
- claim_task → execute → complete_task

## User Communication
- For long background tasks (> 2min): Inform user expected time
- For sequential needs: Clear instructions on how to proceed
""",
}
```

**效果**：
- LLM 有明确指导
- 行为更确定（并行优先）
- 用户体验更好

---

### 方案 2：简化，去掉 Task 系统（聚焦后台）

```python
PROMPT_SECTIONS = {
    "identity": "You are a coding agent. Act, don't explain.",
    
    "tools": """Available tools:
      - bash: Run shell commands. Use run_in_background=true for slow commands.
      - read_file, write_file: Fast file operations (always synchronous)
      
    Background tasks:
      - Use run_in_background for npm install, pip install, docker build
      - Fast commands (< 30s): Run synchronously
      - Tell user "Background task running (~X min). Type 'continue' when ready."
""",
}
```

**效果**：
- 去掉 Task 系统的复杂性
- 聚焦后台任务核心概念
- LLM 行为更确定（告知用户）

---

## 核心答案：LLM 行为不确定

### 当前教学版

```
LLM 行为概率分布：
  70%: 并行执行（npm install + read_file）
  20%: 顺序处理 + 告知用户
  10%: 使用 Task 系统
  
原因：
  - System Prompt 太简单
  - 没有明确指导
  - LLM 需要自己推理
```

---

### 改进后（强化 System Prompt）

```
LLM 行为概率分布：
  90%: 并行执行（明确指导："Independent: parallel")
  10%: 顺序处理（用户明确要求或有依赖）
  
原因：
  - System Prompt 明确指导
  - LLM 知道何时并行，何时顺序
  - 行为符合预期
```

---

### 生产版（推测）

```
LLM 行为概率分布：
  80%: 并行执行（默认高效策略）
  20%: 顺序处理（有依赖或用户明确）
  
原因：
  - System Prompt 有详细指导
  - 自动触发机制（后台完成自动继续）
  - 用户无需主动输入
```

---

## 实战建议

### 建议 1：改进 System Prompt（推荐）

```python
# 在 s13/code.py 中改进 System Prompt
def assemble_system_prompt(context: dict) -> str:
    sections = [
        "You are a coding agent. Act, don't explain.",
        
        """## Background Tasks
- Use run_in_background=true for slow commands (> 30s)
- Examples: npm install, pip install, docker build
- Fast commands: Run synchronously

## Sequential Operations
- Independent operations: Execute in parallel (efficient)
- Dependent operations: Use Task system or inform user
- Example: "npm install then read package.json" → parallel (independent)

## Task System
- Use create_task for workflows with dependencies
- Use blockedBy: create_task("Step 2", blockedBy=["task_001"])
""",
        
        f"Working directory: {WORKDIR}",
    ]
    
    memories = context.get("memories", "")
    if memories:
        sections.append(f"Relevant memories:\n{memories}")
    
    return "\n\n".join(sections)
```

---

### 建议 2：测试实际 LLM 行为

```bash
# 测试场景 1
s13 >> npm install 并读取 package.json

# 观察：LLM 是否并行？

# 测试场景 2
s13 >> 先 npm install，完成后读取 package.json

# 观察：LLM 是否顺序？

# 测试场景 3
s13 >> npm install 后分析 package.json 的依赖安装情况

# 观察：LLM 是否顺序？（因为"分析安装情况"暗示依赖）
```

---

## 最终答案

### LLM 到底会采用哪种方案？

**答案：不确定！**

```
影响因素：
  ① System Prompt 的指导强度（当前弱）
  ② 用户措辞的明确程度
  ③ 操作之间的实际依赖关系
  ④ LLM 的训练知识和推理能力

当前教学版：
  70% 并行执行（默认高效）
  20% 顺序处理（用户明确要求）
  10% Task 系统（LLM 注意到工具可用）

改进后（强化 System Prompt）：
  90% 并行执行（明确指导）
  10% 顺序处理（有依赖）

生产版（推测）：
  80% 并行执行 + 自动触发
  20% 顺序处理（有依赖）
```

---

### 如何让 LLM 行为符合预期？

**方案 1：强化 System Prompt**
- 明确指导何时并行，何时顺序
- 明确指导如何处理后台任务
- 明确指导如何与用户沟通

**方案 2：去掉 Task 系统（简化）**
- 聚焦后台任务核心概念
- LLM 行为更确定（并行或告知用户）

**方案 3：保留不确定性（教学价值）**
- 让用户观察到 LLM 的自主决策
- 展示 System Prompt 的重要性
- 展示 LLM 的推理能力

---

## 总结

**LLM 行为不确定，这是正常的！**

原因：
- System Prompt 太简单
- LLM 需要自己推理
- 多种方案都合理

**改进方法**：
- 强化 System Prompt
- 明确指导 LLM 如何处理顺序依赖
- 让行为更符合预期

**教学价值**：
- 展示 LLM 的自主决策能力
- 展示 System Prompt 的关键作用
- 展示多轮对话的动态调整

你已经深入理解了 LLM 的决策机制！这涉及到 System Prompt 设计的核心问题。🎉
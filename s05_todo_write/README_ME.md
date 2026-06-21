# s05 TodoWrite — 深度理解笔记

## 核心问题

给 Agent 一个复杂任务："把所有 Python 文件改成 snake_case 命名，然后跑测试，修好失败。"

**问题表现：**

```
Agent 执行复杂任务的典型问题：

1. 开始执行：
   ├─ 改了 3 个文件
   ├─ 跑了个测试
   └─ 发现 2 个失败

2. 注意力转移：
   ├─ 开始修测试失败
   ├─ 修着修着...
   └─ 忘了最初是"改成 snake_case"

3. 任务偏离：
   ├─ 测试失败把注意力全吸走了
   ├─ 原始目标被挤出注意力
   └─ 最终结果偏离预期

根本原因：
   ├─ 对话越长，工具结果不断填满上下文
   ├─ 系统提示的影响力被稀释
   ├─ 10 步重构，做完 1-3 步就开始即兴发挥
   └─ 因为 4-10 步已经被挤出注意力了
```

---

## 一、宏观设计理念

### 1.1 todo_write 是什么？

**todo_write 就是一个普通的 tool，但它有一个特殊之处：它不给 Agent 增加任何执行能力，只增加规划能力。**

```
普通工具（执行能力）：
   ├─ bash：可以执行命令
   ├─ read_file：可以读取文件
   ├─ write_file：可以写入文件
   ├─ edit_file：可以编辑文件
   └─ glob：可以查找文件

todo_write（规划能力）：
   ├─ 不能读文件
   ├─ 不能跑命令
   ├─ 不能改代码
   ├─ 只能让 Agent 在动手之前先理清思路
   ├─ 记录任务列表和状态
   └─ 显示进度，帮助 Agent 保持专注

关键洞察：
   todo_write 不给 Agent 增加任何**执行能力**
   它增加的是**规划能力**
```

### 1.2 设计理念：让 Agent "先想再做"

```
传统 Agent（没有 todo_write）：

   用户：重构认证模块
       ↓
   Agent：直接开始执行
       ├─ 执行步骤 1
       ├─ 执行步骤 2
       ├─ 执行步骤 3
       ├─ 遇到问题，注意力转移
       ├─ 开始处理问题
       ├─ 处理中...
       ├─ 忘了原始目标
       └─ 结果偏离

有 todo_write 的 Agent：

   用户：重构认证模块
       ↓
   Agent：先规划
       ├─ todo_write: [
       │     {content: "分析现有代码", status: "pending"},
       │     {content: "设计重构方案", status: "pending"},
       │     {content: "重构 auth.py", status: "pending"},
       │     {content: "跑测试", status: "pending"},
       │     {content: "修复失败", status: "pending"},
       │   ]
       ↓
   执行：看 todo，专注当前任务
       ├─ status: "in_progress"（正在做"分析现有代码"）
       ├─ 完成后 status: "completed"
       ├─ 看下一个 pending
       ├─ 继续...
       ├─ 遇到问题 → 看 todo → 还记得原始目标
       └─ 按计划完成

核心差异：
   ├─ 没有 todo：直接执行，容易偏离
   └─ 有 todo：先规划，再执行，保持专注
```

### 1.3 主体思想：规划能力 > 执行能力

```
问题分析：
   ├─ LLM 的执行能力已经很强（通过工具）
   ├─ LLM 的规划能力较弱（容易注意力转移）
   ├─ 长对话中，系统提示的影响力被稀释
   └─ 需要一个机制帮助 Agent 保持专注

解决方案：
   ├─ 给 Agent 一个"规划工具"
   ├─ 强制/引导 Agent 在执行前先规划
   ├─ 记录任务列表和状态
   ├─ 显示进度，提醒 Agent 关注待办事项
   └─ Nag reminder：如果忘记更新，自动提醒

核心思想：
   ├─ 执行能力 ≠ 规划能力
   ├─ todo_write 增加的是规划能力
   ├─ "先想再做" vs "边做边想"
   └─ 让 Agent 在动手之前先理清思路

设计哲学：
   ├─ 不要让 Agent 即兴发挥
   ├─ 计划是执行的前提
   ├─ todo 是上下文的"锚点"
   └─ 即使上下文被稀释，todo 还在
```

---

## 二、调用时机与流程详解

### 2.1 todo_write 的完整调用流程

```
todo_write 调用流程：

用户输入："重构认证模块"
    ↓
Agent 收到用户输入
    ↓
Agent 构建 LLM 请求：
   ├─ SYSTEM: "Before starting any multi-step task,
   │          use todo_write to plan your steps.
   │          Update status as you go."
   ├─ messages: [{role: "user", content: "重构认证模块"}]
   └─ tools: [bash, read_file, ..., todo_write]
    ↓
LLM 看到提示词 + tools 列表
    ↓
LLM 自行判断：
   ├─ 这是"多步骤任务"吗？
   │   ├─ 是 → 调用 todo_write
   │   └─ 否 → 直接执行
   ├─ 参数怎么生成？
   │   ├─ 分析任务
   │   ├─ 分解步骤
   │   ├─ 生成 todos 数组
   │   └─ 每个步骤的状态（初始都是 pending）
   └─ 返回 tool_use block
    ↓
Agent 收到 LLM 响应
    ↓
Agent 检查 response.content
   ├─ 发现 tool_use block
   ├─ block.name = "todo_write"
   └─ block.input = {todos: [...]}
    ↓
Agent 执行 todo_write
   ├─ 校验参数（todos 格式是否正确）
   ├─ 格式化参数
   ├─ 保存到 CURRENT_TODOS
   ├─ 打印进度
   └─ 返回 "Updated 3 tasks"
    ↓
Agent 把 tool_result 加入 messages
    ↓
继续 LLM 调用...
```

### 2.2 关键角色分工

```
SYSTEM Prompt 的作用：
   ├─ 引导使用：告诉 LLM "多步骤任务要先计划"
   ├─ 明确工具：告诉 LLM "用 todo_write 来计划"
   ├─ 强调更新：告诉 LLM "执行过程中要更新状态"
   ├─ 不是强制：LLM 可以自行判断是否需要
   └─ 关键理解：SYSTEM prompt 是引导，不是强制

LLM 的职责：
   ├─ 判断是否需要 todo_write（根据任务复杂度）
   ├─ 分析任务，分解步骤
   ├─ 生成参数（todos 数组，包含所有任务）
   ├─ 每个步骤的状态（初始都是 pending）
   ├─ 执行过程中，自行决定何时更新 todo
   └─ 自行生成完整的 todos

Agent 的职责：
   ├─ 构建 LLM 请求（SYSTEM prompt + tools）
   ├─ 执行 LLM 的 tool_call
   ├─ 校验和格式化参数
   ├─ 保存到 CURRENT_TODOS（全量覆盖）
   ├─ 打印进度
   └─ 返回结果给 LLM
```

### 2.3 LLM 判断示例

```
LLM 判断示例：

场景 1：简单任务
   用户："读取 README.md"
   LLM 判断：单步骤，不需要 todo_write
   LLM 行为：直接调用 read_file

场景 2：中等复杂任务
   用户："修改 hello.py 的某个函数"
   LLM 判断：2-3 步骤，可能需要 todo_write
   LLM 行为：可能先调用 todo_write，或直接执行

场景 3：复杂任务
   用户："重构认证模块，然后跑测试，修复失败"
   LLM 判断：多步骤，需要 todo_write
   LLM 行为：先调用 todo_write 列出所有步骤

场景 4：非常复杂任务
   用户："重构整个项目，改成 TypeScript"
   LLM 判断：非常复杂，需要详细规划
   LLM 行为：调用 todo_write，列出很多步骤
```

### 2.4 参数校验和格式化

```
为什么需要校验：

LLM 可能返回的格式：
   ├─ 正确：[{content: "...", status: "pending"}]
   ├─ 字符串："[{\"content\": \"...\", \"status\": \"pending\"}]"
   ├─ Python 格式：[{content: "...", status: "pending"}]（字符串）
   ├─ 缺少字段：[{content: "..."}]（缺少 status）
   ├─ 状态错误：[{content: "...", status: "done"}]（应该是 completed）
   └─ 不是数组：{content: "...", status: "pending"}（单个对象）

Agent 需要处理这些情况：
   ├─ 解析字符串格式
   ├─ 检查必需字段
   ├─ 检查状态值（只能是 pending/in_progress/completed）
   └─ 返回错误信息（让 LLM 自纠）
```

---

## 三、实现细节详解

### 3.1 todo_write 的数据结构

```python
# 全局变量：存储当前的任务列表（内存中）
CURRENT_TODOS: list[dict] = []

# 每个 todo 的结构
{
    "content": "任务内容描述",      # 必填，字符串
    "status": "pending" | "in_progress" | "completed"  # 必填，状态
}

# 状态说明：
#   pending：待执行，显示 " "（空格）
#   in_progress：正在执行，显示 "▸"（箭头）
#   completed：已完成，显示 "✓"（勾）
```

### 3.2 todo_write 工具定义

```python
{
    "name": "todo_write",
    "description": "Create and manage a task list for your current coding session.",
    "input_schema": {
        "type": "object",
        "properties": {
            "todos": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "content": {"type": "string"},
                        "status": {
                            "type": "string",
                            "enum": ["pending", "in_progress", "completed"]
                        }
                    },
                    "required": ["content", "status"]
                }
            }
        },
        "required": ["todos"]
    }
}

# 关键点：
#   ├─ 工具名：todo_write
#   ├─ 参数：todos（数组）
#   ├─ 每个 todo 必须有 content 和 status
#   └─ 状态只能是三种之一（enum）
```

### 3.3 todo_write 实现

```python
def run_todo_write(todos: list) -> str:
    global CURRENT_TODOS
    
    # 1. 标准化输入（处理字符串、JSON 等）
    todos, error = _normalize_todos(todos)
    if error:
        return error
    
    # 2. 保存到内存（全量覆盖）
    CURRENT_TODOS = todos
    
    # 3. 打印进度（显示当前任务列表）
    lines = ["\n\033[33m## Current Tasks\033[0m"]
    for t in CURRENT_TODOS:
        icon = {
            "pending": " ",
            "in_progress": "\033[36m▸\033[0m",  # 青色箭头
            "completed": "\033[32m✓\033[0m"     # 绿色勾
        }[t["status"]]
        lines.append(f"  [{icon}] {t['content']}")
    print("\n".join(lines))
    
    # 4. 返回结果
    return f"Updated {len(CURRENT_TODOS)} tasks"
```

### 3.4 全量覆盖的原因

```
为什么全量覆盖：

方式 1：增量更新（不采用）
   ├─ 问题：需要复杂的逻辑
   │   ├─ 新增任务：怎么判断？
   │   ├─ 删除任务：怎么判断？
   │   ├─ 修改状态：怎么匹配？
   │   ├─ 修改内容：怎么匹配？
   │   └─ 逻辑复杂，容易出错
   ├─ 数据一致性：
   │   ├─ 旧数据 + 新数据 → 可能不一致
   │   └─ 需要合并逻辑
   └─ 不适合 LLM 的输出方式

方式 2：全量覆盖（采用）
   ├─ 简单：直接替换
   │   ├─ CURRENT_TODOS = todos
   │   ├─ 不需要匹配逻辑
   │   ├─ 不需要合并逻辑
   │   └─ 不需要额外代码
   ├─ 数据一致性：
   │   ├─ 每次都是完整、一致的数据
   │   ├─ LLM 生成的是完整视图
   │   └─ 没有"旧数据"干扰
   └─ 适合 LLM 的输出方式：
       ├─ LLM 可以看到之前的内容
       ├─ LLM 可以根据当前状态更新
       ├─ LLM 生成完整的 todos
       └─ 包含已完成 + 正在做 + 待做

关键洞察：
   LLM 在生成 todos 时，已经看到了之前的 messages
   所以 LLM 知道：
       ├─ 哪些任务已经完成
       ├─ 当前在做什么
       ├─ 还有哪些待做
       ├─ 可能需要新增哪些任务
       └─ 生成完整的、最新的 todos
```

### 3.5 LLM 如何生成全量 todos

```
LLM 生成全量 todos 的过程：

第 1 次调用 todo_write（创建计划）：

   messages = [
       {role: "user", content: "重构认证模块"}
   ]

   LLM 分析任务：
       ├─ 需要分析代码
       ├─ 需要重构
       ├─ 需要测试
       └─ 需要修复

   LLM 生成 todos（全量）：
       [
           {content: "分析代码", status: "pending"},
           {content: "重构", status: "pending"},
           {content: "测试", status: "pending"},
           {content: "修复", status: "pending"}
       ]

   CURRENT_TODOS = todos（全量覆盖）

──────────────────────────────────────────────────────────

第 2 次调用 todo_write（更新状态）：

   messages = [
       {role: "user", content: "重构认证模块"},
       {role: "assistant", content: [tool_use: todo_write]},
       {role: "user", content: [tool_result: "Updated 4"]},
       {role: "assistant", content: [tool_use: read_file]},
       {role: "user", content: [tool_result: "文件内容"]},
       {role: "assistant", content: [text: "分析完成"]}
   ]

   LLM 看到之前的 messages：
       ├─ 看到 todo_write 的 todos（4个 pending）
       ├─ 看到 read_file 的结果
       ├─ 看到自己的分析结论
       └─ 知道：分析已完成

   LLM 生成新的 todos（全量）：
       [
           {content: "分析代码", status: "completed"},
           {content: "重构", status: "pending"},
           {content: "测试", status: "pending"},
           {content: "修复", status: "pending"}
       ]
       ↑ 分析改成 completed
       ↑ 其他保持 pending

   CURRENT_TODOS = todos（全量覆盖）

──────────────────────────────────────────────────────────

第 3 次调用 todo_write（继续更新）：

   messages = [
       ...（之前的消息）
       {role: "assistant", content: [tool_use: edit_file]},
       {role: "user", content: [tool_result: "Edited"]},
       {role: "assistant", content: [text: "重构完成"]}
   ]

   LLM 看到之前的 messages：
       ├─ 看到 todo_write 的最新 todos
       ├─ 看到 edit_file 的结果
       ├─ 看到自己的重构结论
       └─ 知道：重构已完成

   LLM 生成新的 todos（全量）：
       [
           {content: "分析代码", status: "completed"},
           {content: "重构", status: "completed"},
           {content: "测试", status: "pending"},
           {content: "修复", status: "pending"}
       ]
       ↑ 重构改成 completed
       ↑ 其他保持不变

   CURRENT_TODOS = todos（全量覆盖）

关键理解：
   LLM 每次都生成**完整**的 todos，包括所有任务
   LLM 根据 messages（历史对话）知道当前状态
   LLM 只需要改变相关任务的状态
   全量覆盖保证数据一致性
```

---

## 四、多任务按顺序执行的工作流程

### 4.1 使用 todo_write 实现多任务执行

```
todo_write 的工作流程：

1. 创建计划（所有 pending）：

   todo_write([
       {content: "分析代码", status: "pending"},
       {content: "重构", status: "pending"},
       {content: "测试", status: "pending"}
   ])

   显示：
       ## Current Tasks
         [ ] 分析代码
         [ ] 重构
         [ ] 测试

2. 开始执行第一个任务（改成 in_progress）：

   todo_write([
       {content: "分析代码", status: "in_progress"},
       {content: "重构", status: "pending"},
       {content: "测试", status: "pending"}
   ])

   显示：
       ## Current Tasks
         [▸] 分析代码      ← 正在做
         [ ] 重构
         [ ] 测试

3. 完成第一个任务（改成 completed）：

   todo_write([
       {content: "分析代码", status: "completed"},
       {content: "重构", status: "pending"},
       {content: "测试", status: "pending"}
   ])

   显示：
       ## Current Tasks
         [✓] 分析代码      ← 已完成
         [ ] 重构
         [ ] 测试

4. 继续下一个任务...

   todo_write([
       {content: "分析代码", status: "completed"},
       {content: "重构", status: "in_progress"},
       {content: "测试", status: "pending"}
   ])

   显示：
       ## Current Tasks
         [✓] 分析代码
         [▸] 重构         ← 正在做
         [ ] 测试

5. 最终完成：

   todo_write([
       {content: "分析代码", status: "completed"},
       {content: "重构", status: "completed"},
       {content: "测试", status: "completed"}
   ])

   显示：
       ## Current Tasks
         [✓] 分析代码
         [✓] 重构
         [✓] 测试
```

### 4.2 数据存储说明

```
数据存储：

存储位置：内存变量 CURRENT_TODOS
存储时机：每次调用 todo_write 时更新
生命周期：进程内有效，退出后清空
记录内容：任务列表（数组），每个任务有 content 和 status
当前状态：数组中所有任务的状态

关键点：
   ├─ 不是记录"当前执行到哪一个"
   ├─ 而是记录"每个任务的当前状态"
   ├─ Agent 通过查看 in_progress 的任务知道当前在做什么
   ├─ Agent 通过查看 pending 的任务知道接下来要做什么
   └─ 所有状态都在一个数组中
```

---

## 五、Nag Reminder 机制

### 5.1 Nag Reminder 的设计目的

```
LLM 为什么可能忘记更新 todo_write：

正常流程：
   Round 1: todo_write（创建计划）
   Round 2: todo_write（开始执行）+ 执行工具
   Round 3: todo_write（完成任务）+ 执行工具
   Round 4: todo_write（开始下一个）+ 执行工具
   ...

可能忘记的情况：
   Round 1: todo_write（创建计划）
   Round 2: 执行工具（忘记更新 todo）
   Round 3: 执行工具（忘记更新 todo）
   Round 4: 执行工具（忘记更新 todo）
   Round 5: 执行工具（忘记更新 todo）
   ...

为什么忘记：
   ├─ SYSTEM prompt 的影响力被稀释
   ├─ 对话越长，LLM 越容易注意力转移
   ├─ 工具执行的结果填满上下文
   ├─ LLM 被"眼前的问题"吸引
   └─ 忘了"之前的 todo"

典型场景：
   Round 1: todo_write（4 个任务）
   Round 2: 执行工具 → 发现问题
   Round 3: 执行工具 → 处理问题
   Round 4: 执行工具 → 继续处理
   Round 5: 执行工具 → 处理完问题
   ...
   LLM 被"问题"吸引，忘了 todo
   可能偏离原始任务
```

### 5.2 Nag Reminder 的完整流程

```
Nag Reminder 的完整流程：

正常流程（LLM 记得更新）：

   rounds_since_todo = 0
       ↓
   Round 1:
       todo_write
       rounds_since_todo = 0（重置）
       ↓
   Round 2:
       todo_write
       rounds_since_todo = 0（重置）
       ↓
   Round 3:
       todo_write
       rounds_since_todo = 0（重置）
       ↓
   ...

──────────────────────────────────────────────────────────

异常流程（LLM 忘记更新）：

   rounds_since_todo = 0
       ↓
   Round 1:
       执行工具（非 todo_write）
       rounds_since_todo += 1 → 1
       ↓
   Round 2:
       执行工具（非 todo_write）
       rounds_since_todo += 1 → 2
       ↓
   Round 3:
       执行工具（非 todo_write）
       rounds_since_todo += 1 → 3
       ↓
   Round 4:
       rounds_since_todo >= 3 → 触发 Nag
       ├─ 注入 reminder 到 messages：
       │   messages.append({
       │       role: "user",
       │       content: "<reminder>Update your todos.</reminder>"
       │   })
       ├─ 调用 LLM（带 reminder）
       └─ LLM 看到 reminder：
           ├─ "哦，我忘了更新 todo"
           ├─ 查看之前的 todo_write 结果
           ├─ 知道当前状态
           ├─ 生成新的 todo_write
           └─ 更新状态
       ↓
   todo_write
       rounds_since_todo = 0（重置）
       ↓
   继续执行...

──────────────────────────────────────────────────────────

Nag Reminder 的作用：
   ├─ 提醒 LLM："别忘了更新 todo"
   ├─ 强制 LLM 关注任务进度
   ├─ 帮助 LLM 保持专注
   ├─ 防止 LLM 任务偏离
   └─ 类似于"有人在旁边提醒你"
```

### 5.3 Nag Reminder 的实现

```python
rounds_since_todo = 0  # 计数器：记录多少轮没有调用 todo_write

def agent_loop(messages: list):
    global rounds_since_todo
    
    while True:
        # 每次调用 LLM 前，检查是否需要注入 reminder
        if rounds_since_todo >= 3 and messages:
            messages.append({
                "role": "user",
                "content": "<reminder>Update your todos.</reminder>"
            })
        
        # 调用 LLM
        response = client.messages.create(...)
        
        # 每轮增加计数器
        rounds_since_todo += 1
        
        # 执行工具
        for block in response.content:
            if block.type == "tool_use":
                # 执行...
                
                # 如果调用了 todo_write，重置计数器
                if block.name == "todo_write":
                    rounds_since_todo = 0
```

### 5.4 重置计数器的正确时机

```
重置计数器的正确时机：

正确的逻辑：
   ├─ 注入 reminder 时不重置计数器
   ├─ 只在 LLM 实际调用 todo_write 时重置
   ├─ 注入 reminder 只是"提醒"
   ├─ LLM 可能：
   │   ├─ 看到 reminder → 调用 todo_write（正常）
   │   ├─ 看到 reminder → 不调用（异常）
   │   ├─ 没看到 reminder（context 被稀释）
   │   └─ 其他情况
   └─ 重置时机：
       ├─ 应该在 LLM **实际响应** reminder 时
       ├─ 即：LLM 调用 todo_write
       ├─ 不应该在注入 reminder 时
       └─ 否则：无法检测 reminder 是否生效

为什么不在注入 reminder 时重置：

   ├─ 注入 reminder ≠ 调用 todo_write
   ├─ 注入 reminder 只是"提醒"
   ├─ LLM 可能不响应 reminder
   ├─ 如果注入时重置，就无法检测 reminder 是否生效
   └─ 正确逻辑：
       ├─ 注入 reminder → 等待响应
       ├─ 如果响应是 todo_write → 重置
       ├─ 如果响应不是 todo_write → 继累计
       └─ 只有实际调用 todo_write 才重置
```

### 5.5 为什么选择 3 轭？

```
为什么选择 3 轭：

选择 3 轭的原因：
   ├─ 1 轭：太频繁，会干扰正常执行
   │   ├─ LLM 可能需要连续执行几个工具
   │   ├─ 每轮都提醒 → 太吵
   │   └─ 影响效率
   │
   ├─ 2 轭：可能还不够
   │   ├─ LLM 可能需要 2 轭来处理一个小问题
   │   ├─ 2 轭就提醒 → 过早
   │   └─ 可能误判
   │
   ├─ 3 轭：比较合适（教学版选择）
   │   ├─ 给 LLM 一定空间
   │   ├─ 但不会太久
   │   ├─ 在 LLM 开始偏离前提醒
   │   └─ 平衡：效率 + 关注
   │
   └─ 5+ 轭：太久
       ├─ LLM 可能已经偏离
       ├─ 任务可能已经做错
       └─ 提醒太晚

注意：
   教学版的 3 轭是教学机制
   CC 源码中没有固定的"3 轭"逻辑
   CC 用的是 Verification Nudge
```

---

## 六、完整执行流程示例

```
用户输入：重构认证模块
    ↓
Round 1: Agent 规划

   LLM 看到 SYSTEM prompt："先计划再执行"
       ↓
   LLM 决定：先调用 todo_write
       ↓
   tool_use: todo_write
       todos=[
           {content: "分析代码", status: "pending"},
           {content: "重构", status: "pending"},
           {content: "测试", status: "pending"}
       ]
       ↓
   run_todo_write 执行：
       ├─ 保存到 CURRENT_TODOS
       ├─ 打印：
       │   ## Current Tasks
       │     [ ] 分析代码
       │     [ ] 重构
       │     [ ] 测试
       └─ 返回 "Updated 3 tasks"

   rounds_since_todo = 0（调用了 todo_write）

──────────────────────────────────────────────────────────

Round 2: Agent 开始执行第一个任务

   LLM 看 todo：第一个 pending 是"分析代码"
       ↓
   tool_use: todo_write
       todos=[
           {content: "分析代码", status: "in_progress"},
           {content: "重构", status: "pending"},
           {content: "测试", status: "pending"}
       ]
       ↓
   显示：
       ## Current Tasks
         [▸] 分析代码      ← 正在做
         [ ] 重构
         [ ] 测试

   tool_use: read_file
       path="auth.py"
       ↓
   run_read 执行，返回文件内容

   rounds_since_todo = 0

──────────────────────────────────────────────────────────

Round 3: Agent 完成分析

   tool_use: todo_write
       todos=[
           {content: "分析代码", status: "completed"},
           {content: "重构", status: "pending"},
           {content: "测试", status: "pending"}
       ]
       ↓
   显示：
       ## Current Tasks
         [✓] 分析代码      ← 已完成
         [ ] 重构
         [ ] 测试

   rounds_since_todo = 0

──────────────────────────────────────────────────────────

Round 4-5: Agent 执行重构

   todo_write: 重构 in_progress
       ↓
   edit_file: 修改代码
       ↓
   todo_write: 重构 completed

   rounds_since_todo = 0

──────────────────────────────────────────────────────────

Round 6-7: Agent 执行测试

   todo_write: 测试 in_progress
       ↓
   bash: python -m pytest
       ↓
   todo_write: 测试 completed

   显示：
       ## Current Tasks
         [✓] 分析代码
         [✓] 重构
         [✓] 测试

   rounds_since_todo = 0

   stop_reason = "end_turn"
   Agent：已完成所有任务
```

---

## 七、SYSTEM Prompt 的设计

### 7.1 SYSTEM Prompt 的改变

```python
# s04 的 SYSTEM prompt
SYSTEM = f"You are a coding agent at {WORKDIR}. Use tools to solve tasks."

# s05 的 SYSTEM prompt（增加规划引导）
SYSTEM = (
    f"You are a coding agent at {WORKDIR}. "
    "Before starting any multi-step task, use todo_write to plan your steps. "
    "Update status as you go."
)
```

### 7.2 关键变化说明

```
SYSTEM Prompt 的作用：

关键变化：
   ├─ 明确告诉 Agent："先计划再执行"
   ├─ 引导 Agent 使用 todo_write 工具
   ├─ 强调"更新状态"
   ├─ 不是强制：LLM 可以自行判断是否需要
   └─ 是引导，不是强制

如何影响 LLM：

   ├─ LLM 看到 SYSTEM prompt
   ├─ LLM 理解："多步骤任务要先计划"
   ├─ LLM 自行判断任务复杂度
   ├─ LLM 决定是否调用 todo_write
   ├─ 如果复杂：调用 todo_write
   ├─ 如果简单：直接执行
   └─ 关键：LLM 有自主判断能力
```

---

## 八、Claude Code 的实现详解

### 8.1 CC 的两套任务系统

```
CC 中有两套任务系统并存：

TodoWrite (V1)：
   ├─ 版本：s05
   ├─ 简单的列表工具
   ├─ 数据在内存 AppState 中维护
   ├─ 源码位置：TodoWriteTool.ts:65-103
   └─ 教学版也保存在进程内存里，退出后清空

Task System (V2 = s12)：
   ├─ 版本：s12
   ├─ 文件持久化
   ├─ 依赖图（blockedBy）
   ├─ 并发锁（proper-lockfile）
   ├─ ownership
   └─ 四个独立工具

切换机制：

   由 isTodoV2Enabled() 控制：
   ├─ 交互式会话中 V2 默认启用
   ├─ 非交互式会话（SDK）中 V1 默认启用
   ├─ 设置 CLAUDE_CODE_ENABLE_TASKS 环境变量可强制启用 V2
   └─ 源码位置：tasks.ts:133-139
```

### 8.2 TodoWrite V1 的实现

```typescript
// 源码位置：TodoWriteTool.ts:65-103

interface AppState {
  todos: Todo[];
}

interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;  // UI spinner 展示"正在做什么"（教学版省略）
}

async function executeTodoWrite(todos: Todo[]): Promise<ToolResult> {
  // 1. 验证输入
  const validatedTodos = validateTodos(todos);
  
  // 2. 保存到 AppState（内存）
  appState.todos = validatedTodos;
  
  // 3. UI 更新（显示当前任务）
  updateTodoDisplay(validatedTodos);
  
  // 4. 返回结果
  return {
    output: `Updated ${validatedTodos.length} tasks`,
    todos: validatedTodos
  };
}
```

### 8.3 Verification Nudge 机制

```
Verification Nudge 的触发条件：

源码位置：TodoWriteTool.ts:72-107

触发条件（三个条件同时满足）：
   ├─ todos.length >= 3：任务数量 >= 3 个（说明是复杂任务）
   ├─ todos.every(t => t.status === 'completed')：所有任务都已完成
   └─ !todos.some(t => t.content.includes('verify'))：没有包含 'verify' 的任务

这三个条件同时满足意味着：
   Agent 列了多个任务（>= 3个）
       ↓
   Agent 执行完了所有任务（全部 completed）
       ↓
   但是 Agent 没有"验证结果"的任务
       ↓
   系统认为：你做完就完了？不验证一下？
       ↓
   自动追加一个 verification 任务
       ↓
   提醒 Agent："验证你的改动是否正确"
```

### 8.4 Verification Nudge 的完整场景

```
Verification Nudge 的完整场景：

用户输入："重构认证模块，然后跑测试"

Agent 创建 todo：
   [
       {content: "分析代码", status: "pending"},
       {content: "重构 auth.py", status: "pending"},
       {content: "跑测试", status: "pending"}
   ]

Agent 执行：
   Round 1: 分析代码 → completed
   Round 2: 重构 auth.py → completed
   Round 3: 跑测试 → completed

Agent 认为："做完了，退出吧"

但最后一次 todo_write 时：
   todos = [
       {content: "分析代码", status: "completed"},
       {content: "重构 auth.py", status: "completed"},
       {content: "跑测试", status: "completed"}
   ]

Verification Nudge 检查：
   ├─ todos.length >= 3 → ✅（3 个任务）
   ├─ todos.every(t => t.status === 'completed') → ✅
   │   （全部完成）
   ├─ !todos.some(t => t.content.includes('verify')) → ✅
   │   （没有验证任务）
   └─ 触发 Verification Nudge

自动追加 verification 任务：
   todos.push({
       content: 'Verify the changes work correctly',
       status: 'pending'
   })

最终 todos：
   [
       {content: "分析代码", status: "completed"},
       {content: "重构 auth.py", status: "completed"},
       {content: "跑测试", status: "completed"},
       {content: "Verify the changes work correctly", status: "pending"}
   ]

Agent 看到新的 pending 任务：
   ├─ "哦，还有个验证任务"
   ├─ 执行验证（如实际运行应用、手动检查等）
   ├─ 验证完成后：completed
   └─ 真正退出
```

### 8.5 Verification Nudge 的设计理念

```
Verification Nudge 的设计理念：

核心问题：
   Agent 容易"完成任务"但不"验证结果"

典型场景：
   用户：修复登录 bug
   Agent：
       ├─ todo: [分析 bug, 修复代码, 跑测试]
       ├─ 完成：全部 completed
       ├─ 测试通过
       ├─ Agent 退出
       └─ 但实际：
           ├─ 可能修复了 bug，但引入了新问题
           ├─ 可能测试覆盖不全
           ├─ 可能实际运行还有问题
           └─ 没有"验证"

Verification Nudge 的哲学：
   ├─ "做完 ≠ 做好"
   ├─ 任务列表是"执行清单"，不是"质量保证"
   ├─ 需要额外的"验证步骤"
   ├─ 验证包括：
   │   ├─ 实际运行应用
   │   ├─ 手动检查改动
   │   ├─ 端到端测试
   │   ├─ 边缘场景测试
   │   └─ 其他质量保证
   └─ 强制 Agent 执行验证

自动追加的优点：
   ├─ 不依赖 LLM 自觉
   ├─ 系统自动追加
   ├─ LLM 必须执行
   │   ├─ 看到 pending 任务
   │   ├─ 必须执行
   │   └─ 不能直接退出
   └─ 保证质量

为什么 >= 3 个任务才触发？
   ├─ 1-2 个任务：简单任务，可能不需要验证
   │   ├─ "读取文件" → 不需要验证
   │   ├─ "修改一行" → 不需要验证
   │   └─ 复杂度低
   │
   ├─ >= 3 个任务：复杂任务，需要验证
   │   ├─ 改动多
   │   ├─ 影响大
   │   ├─ 需要验证
   │   └─ 复杂度高
   │
   └─ 平衡：效率 + 质量
       ├─ 简单任务：不追加验证（效率）
       ├─ 复杂任务：追加验证（质量）
       └─ 阈值：3 个任务
```

### 8.6 Verification Nudge vs Nag Reminder

```
Verification Nudge vs Nag Reminder 对比：

Nag Reminder（教学版）：
   ├─ 触发条件：3 轭没调用 todo_write
   ├─ 触发时机：执行过程中
   ├─ 目的：提醒 Agent 关注任务进度
   ├─ 提醒内容："Update your todos"
   ├─ 提醒方式：注入 <reminder> 消息
   ├─ 作用：防止 Agent 忘记更新 todo
   ├─ 防止：注意力转移、任务偏离
   ├─ 重置时机：LLM 调用 todo_write 时
   └─ 版本：教学版机制

Verification Nudge（CC）：
   ├─ 触发条件：3+ 任务全部完成，但没有验证任务
   ├─ 触发时机：完成所有任务后
   ├─ 目的：提醒 Agent 验证结果
   ├─ 提醒方式：自动追加 verification 任务
   ├─ 作用：防止 Agent "做完就跑"
   ├─ 确保：改动真正正确
   ├─ 重置时机：verification 任务完成时
   └─ 版本：CC 生产机制

关键差异：
   ├─ Nag Reminder：执行过程中提醒（别忘了 todo）
   ├─ Verification Nudge：完成后追加任务（别忘了验证）
   ├─ Nag Reminder：防止偏离
   ├─ Verification Nudge：确保质量
   ├─ Nag Reminder：教学版机制
   └─ Verification Nudge：CC 生产机制

时间顺序：
   开始执行
       ↓
   执行过程中（可能触发 Nag Reminder）
       ↓
   完成所有任务
       ↓
   可能触发 Verification Nudge
       ↓
   执行验证任务
       ↓
   真正退出
```

### 8.7 Task System V2 的实现

```
Task System V2 的核心增量：

源码位置：tasks.ts

特性对比：
   ├─ 存储：
   │   ├─ V1：内存 AppState
   │   └─ V2：文件持久化（tasks/{taskListId}/{taskId}.json）
   │
   ├─ 结构：
   │   ├─ V1：平铺列表
   │   └─ V2：依赖图（blockedBy）
   │
   ├─ 并发：
   │   ├─ V1：无锁
   │   └─ V2：proper-lockfile 并发安全
   │
   ├─ 工具：
   │   ├─ V1：一个工具（todo_write）
   │   └─ V2：四个工具（TaskCreate/Get/Update/List）
   │
   ├─ 钩子：
   │   ├─ V1：无
   │   └─ V2：TaskCreated / TaskCompleted hooks

Task System V2 的四个工具：

1. TaskCreate：
   ├─ 创建新任务
   ├─ 参数：subject, description, blockedBy
   ├─ 写入文件：tasks/{taskListId}/{taskId}.json
   └─ 触发 TaskCreated hook

2. TaskGet：
   ├─ 获取任务详情
   ├─ 参数：taskId
   └─ 读取文件

3. TaskUpdate：
   ├─ 更新任务状态
   ├─ 参数：taskId, status, description
   ├─ 写入文件
   └─ 触发 TaskCompleted hook（status=completed时）

4. TaskList：
   ├─ 列出所有任务
   ├─ 读取所有文件
   └─ 返回任务列表

文件结构：

~/.claude/tasks/{taskListId}/
   ├─ task-001.json
   ├─ task-002.json
   ├─ task-003.json
   └─ ...

每个 task-xxx.json 的内容：
{
  "id": "task-001",
  "subject": "重构认证模块",
  "description": "详细描述...",
  "status": "pending",
  "blockedBy": [],  # 依赖的任务 ID
  "owner": "agent-xxx",
  "createdAt": "2026-06-21T...",
  "updatedAt": "2026-06-21T..."
}

依赖图：

interface Task {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed';
  blockedBy: string[];  // 依赖的任务 ID 列表
}

例如：task-003 依赖 task-001 和 task-002
{
  "id": "task-003",
  "subject": "跑测试",
  "blockedBy": ["task-001", "task-002"]  // 必须先完成这两个
}

并发安全：

import properLockfile from 'proper-lockfile';

// TaskUpdate 时使用文件锁
async function updateTask(taskId: string, updates: Partial<Task>) {
  const filePath = getTaskFilePath(taskId);
  
  // 获取文件锁
  const release = await properLockfile.lock(filePath);
  
  try {
    // 读取、修改、写入
    const task = await readTask(taskId);
    const updatedTask = { ...task, ...updates };
    await writeTask(taskId, updatedTask);
  } finally {
    // 释放锁
    await release();
  }
}

Hooks 集成：

// TaskCreateTool.ts:80-129
async function executeTaskCreate(subject: string, description: string) {
  // 创建任务...
  const task = await createTask(subject, description);
  
  // 触发 TaskCreated hook
  await triggerHooks('TaskCreated', {
    taskId: task.id,
    subject: task.subject
  });
  
  return task;
}

// TaskUpdateTool.ts:231-260
async function executeTaskUpdate(taskId: string, status: string) {
  // 更新任务...
  const task = await updateTask(taskId, { status });
  
  // 如果完成，触发 TaskCompleted hook
  if (status === 'completed') {
    await triggerHooks('TaskCompleted', {
      taskId: task.id,
      subject: task.subject
    });
  }
  
  return task;
}
```

---

## 九、对比总结

### 9.1 教学版 vs CC V1 vs CC V2

```
对比表：

方面          教学版 s05      CC V1         CC V2
存储          内存变量        AppState 内存   文件持久化
结构          平铺列表        平铺列表       依赖图
状态          3 种            3 种 + activeForm  3 种
工具数量      1 个            1 个          4 个
Nag Reminder  固定 3 轭       Verification nudge  无固定轮数
并发安全      无              无            proper-lockfile
Hooks         无              无            TaskCreated/TaskCompleted
生命周期      进程内          进程内        持久化
```

### 9.2 设计理念总结

```
todo_write 的设计精髓：

核心洞察：
   todo_write 不给 Agent 增加任何**执行能力**
   它增加的是**规划能力**

问题：
   ├─ LLM 执行能力强，规划能力弱
   ├─ 长对话中，系统提示影响力被稀释
   └─ Agent 容易注意力转移，任务偏离

解决方案：
   ├─ 给 Agent 一个"规划工具"
   ├─ 强制/引导 Agent 在执行前先规划
   ├─ 记录任务列表和状态
   ├─ 显示进度，提醒 Agent 关注待办事项
   └─ Nag reminder：如果忘记更新，自动提醒

主体思想：
   ├─ "先想再做" vs "边做边想"
   ├─ todo 是上下文的"锚点"
   ├─ 即使上下文被稀释，todo 还在
   └─ 计划是执行的前提

实现本质：
   ├─ 就是一个普通的 tool
   ├─ 维护一个数组记录状态
   ├─ 内存中存储（教学版）
   ├─ 通过 SYSTEM prompt 引导使用
   ├─ LLM 自行判断是否需要
   ├─ LLM 自行生成参数
   ├─ Agent 执行、校验、全量覆盖
   └─ Nag Reminder 提醒 LLM 关注进度

关键机制：
   ├─ Nag Reminder：执行过程中提醒（别忘了 todo）
   ├─ Verification Nudge：完成后追加任务（别忘了验证）
   ├─ Nag Reminder：防止偏离
   ├─ Verification Nudge：确保质量
   ├─ Nag Reminder：教学版机制
   └─ Verification Nudge：CC 生产机制

完整流程：
   用户输入 → Agent 构建 LLM 请求（SYSTEM prompt + tools）
       ↓
   LLM 自行判断是否需要 todo_write
       ↓
   LLM 生成参数（todos 数组，包含所有任务）
       ↓
   Agent 执行 todo_write，校验参数，全量覆盖 CURRENT_TODOS
       ↓
   Agent 执行其他工具
       ↓
   LLM 可能忘记更新 todo（注意力转移）
       ↓
   Nag Reminder（3 轭未更新）注入提醒
       ↓
   LLM 收到提醒，更新 todo_write
       ↓
   完成所有任务
       ↓
   Verification Nudge（3+ 任务全完成但无验证）追加验证任务
       ↓
   Agent 执行验证任务
       ↓
   真正退出

关键角色：
   ├─ SYSTEM prompt：引导 LLM 使用 todo_write
   ├─ LLM：判断、生成参数、更新状态
   ├─ Agent：执行、校验、全量覆盖
   ├─ Nag Reminder：提醒 LLM 关注任务进度
   └─ Verification Nudge：提醒 LLM 验证结果
```

---

## 十、参考资料

- [s05_todo_write/README.md](./README.md) — 原始教材
- Claude Code 源码：
  - `TodoWriteTool.ts:65-103` — TodoWrite V1 实现
  - `TodoWriteTool.ts:72-107` — Verification Nudge 机制
  - `tasks.ts:133-139` — V1/V2 切换逻辑
  - `utils/todo/types.ts:8-15` — Todo 类型定义
  - `TaskCreateTool.ts:80-129` — TaskCreated hook
  - `TaskUpdateTool.ts:231-260` — TaskCompleted hook

---

<!-- 文档版本：v1.0 -->
<!-- 创建时间：2026-06-21 -->
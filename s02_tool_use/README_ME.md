# s02 Tool Use — 深度理解笔记

## 核心改进

s01 只有一个 bash 工具，模型想"读文件"却要拼出 `cat path/to/file`，多了一层翻译，浪费 token，还容易拼错。

s02 的改进：**给模型专用工具，让它直接表达意图**。

| 场景 | s01 (bash) | s02 (专用工具) |
|------|-----------|---------------|
| 读文件 | `cat README.md` | `read_file(path="README.md")` |
| 写文件 | `echo "hello" > test.py` | `write_file(path="test.py", content="hello")` |
| 改文件 | `sed -i 's/old/new/g' file.py` | `edit_file(path="file.py", old_text="old", new_text="new")` |
| 找文件 | `find . -name "*.py"` | `glob(pattern="*.py")` |

---

## 工具分发架构

```
           TOOLS (JSON Schema)                    TOOL_HANDLERS (Python 函数)
          ┌─────────────────────┐                ┌─────────────────────┐
          │ "bash": {...}       │                │ "bash": run_bash    │
          │ "read_file": {...}  │                │ "read_file": run_read │
          │ "write_file": {...} │                │ "write_file": run_write│
LLM ──────│ "edit_file": {...}  │─────────────────│ "edit_file": run_edit │──→ 执行
 读取     │ "glob": {...}       │     查表分发    │ "glob": run_glob    │
          └─────────────────────┘                └─────────────────────┘
                ↑                                      ↑
            给 LLM 看                              给程序用
          "有哪些工具、参数是什么"              "工具名 → 执行函数"
```

---

## 问题 1：为什么有了 TOOLS 还需要 TOOL_HANDLERS？

**两者用途不同，分离设计！**

```python
# TOOLS: 给 LLM 看的 JSON Schema（告诉模型"我能做什么"）
TOOLS = [
    {"name": "bash", "description": "Run a shell command.",
     "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}}},
    # ...
]

# TOOL_HANDLERS: 给程序自己用的执行函数映射表
TOOL_HANDLERS = {
    "bash": run_bash,
    "read_file": run_read,
    # ...
}
```

| 对象 | 用途 | 使用者 | 内容 |
|------|------|--------|------|
| **TOOLS** | 告诉模型"有哪些工具可用、参数是什么" | **LLM** | JSON Schema（声明式） |
| **TOOL_HANDLERS** | 把工具名映射到实际执行函数 | **程序** | Python 函数（可执行） |

**为什么分离？**

1. **TOOLS 只是"说明书"**：模型只需要知道工具名、参数类型，不需要知道怎么实现
2. **TOOL_HANDLERS 是"执行器"**：程序收到 `block.name` 后，查表找到对应的函数执行
3. **解耦设计**：加工具只需两步 → TOOLS 加一条 + HANDLERS 加一行

---

## 问题 2：TOOLS 的 JSON Schema 标准

这是 **Anthropic Claude API 的 Tool Definition Schema**，遵循 JSON Schema 规范。

### 完整结构

```python
{
    "name": "工具名",           # 必填，字符串，模型调用时用这个名字
    "description": "工具描述",  # 必填，字符串，告诉模型这个工具干什么
    "input_schema": {           # 必填，JSON Schema 对象
        "type": "object",       # 必须是 object
        "properties": {         # 参数定义
            "参数名": {
                "type": "string" | "integer" | "boolean" | "array" | "object",
                "description": "参数描述（可选但推荐）",
                # 其他 JSON Schema 字段：
                "enum": ["选项1", "选项2"],  # 枚举值
                "default": "默认值",         # 默认值
                "minimum": 0,               # 数字最小值
                "maxLength": 100,           # 字符串最大长度
            }
        },
        "required": ["必填参数列表"],  # 必填参数数组
    }
}
```

### 新增工具的规则

| 规则 | 说明 |
|------|------|
| `name` | 字符串，模型调用时用 `block.name` 获取 |
| `description` | 重要！模型根据这个决定何时调用 |
| `input_schema.type` | 必须是 `"object"` |
| `input_schema.properties` | 定义所有参数的类型 |
| `input_schema.required` | 列出必填参数 |

### 示例：添加搜索工具

```python
# 1. TOOLS 加一条
TOOLS.append({
    "name": "search",
    "description": "Search for files containing specific text.",
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The text to search for"
            },
            "case_sensitive": {
                "type": "boolean",
                "description": "Whether to search case-sensitively",
                "default": False
            }
        },
        "required": ["query"]
    }
})

# 2. TOOL_HANDLERS 加一行
TOOL_HANDLERS["search"] = run_search

# 3. 实现函数
def run_search(query: str, case_sensitive: bool = False) -> str:
    # 实现搜索逻辑...
```

---

## 问题 3：Claude Code CLI 的工具来源

**两种来源：内置（硬编码）+ 动态（用户自定义）**

### 1. 内置工具（始终可用）

```
核心工具集：
├── Bash          # 执行 shell 命令
├── Read          # 读文件
├── Write         # 写文件
├── Edit          # 编辑文件
├── Glob          # 文件搜索
├── TaskCreate    # 创建任务
├── TaskUpdate    # 更新任务
├── NotebookEdit  # 编辑 Jupyter notebook
├── WebFetch      # 获取网页
├── WebSearch     # 搜索网络
├── Agent         # 启动子 agent
├── Workflow      # 执行工作流
├── Skill         # 执行 skill
├── ...
```

定义在 `src/tools.ts` 的 `getAllBaseTools()` 函数中。

### 2. 动态工具

| 来源 | 方式 |
|------|------|
| **Skills** | 用户定义的 `/skill` 命令，动态注册为工具 |
| **MCP Tools** | 通过 MCP Server 连接的外部工具，按需加载 |
| **Hooks** | 用户配置的 hooks 可以添加工具 |

---

## 问题 4：工具执行的串行与并发

### 教学版：串行执行

```python
for block in response.content:
    if block.type == "tool_use":
        handler = TOOL_HANDLERS[block.name]
        output = handler(**block.input)  # ← 串行执行
        results.append(...)
```

**为什么只考虑 `tool_use`？**

`response.content` 是一个数组，可能包含多种类型的 block：

| block.type | 说明 | 处理方式 |
|------------|------|---------|
| `"tool_use"` | 工具调用 | 执行工具，收集结果 |
| `"text"` | 文本内容 | 不需要执行，已在 messages 中 |
| `"thinking"` | 思考过程 | 不需要执行，已在 messages 中 |

**为什么 text 不需要处理？**

```python
# response.content 可能是：
[
    {"type": "text", "text": "我来帮你处理..."},      # ← 已添加到 messages
    {"type": "tool_use", "name": "read_file", ...},   # ← 需要执行
    {"type": "tool_use", "name": "glob", ...},        # ← 需要执行
]

# 整个 response.content 已经被添加到 messages：
messages.append({"role": "assistant", "content": response.content})

# 所以 text 块已经被记录了，只需要执行 tool_use 块
```

### Claude Code：并发执行详解

#### 为什么你的示例不能并行？

用户输入：`Create a file called test.py that prints "hello", then read it back`

```
第 1 轮: [write_file("test.py")]  ← 单独一个工具
第 2 轮: [read_file("test.py")]   ← 单独一个工具
```

**关键点：write 和 read 在不同轮次返回，不是同一轮！**

并行的前提是 **同一轮** 返回多个 tool_use。你的示例中：
- 第 1 轮只返回一个 write_file
- 第 2 轮只返回一个 read_file
- 天然串行，无法并发

#### 能并发的示例

```
# 能并发的示例
用户: "读 README.md 和 requirements.txt，列出所有 .py 文件"
LLM 第 1 轮返回: [read_file("README.md"), read_file("requirements.txt"), glob("*.py")]
                ↓ partitionToolCalls()
                ↓
              batch1 (并发): 三个工具同时执行

# 不能并发的示例（你的例子）
用户: "创建 test.py 然后读回来"
LLM 第 1 轮返回: [write_file("test.py")]  ← 只有 1 个
                ↓ 执行完
LLM 第 2 轮返回: [read_file("test.py")]   ← 只有 1 个
                ↓ 必须等 write 完成
```

#### CC 的分批算法：partitionToolCalls()

**核心思想：按连续块分批，不是简单分成两组**

```
[read A, read B, glob *.py, write X, read C, read D]
        ↓ partitionToolCalls() 分批
        ↓
┌─────────────────────────────────────────────────────────┐
│ batch1 (并发执行): [read A, read B, glob *.py]           │
│   - 都是 isConcurrencySafe=true                         │
│   - 连续的并发安全工具编入同一 batch                       │
│   - 可以同时跑，互不影响                                  │
└─────────────────────────────────────────────────────────┘
        ↓ 串行等待 batch1 完成
┌─────────────────────────────────────────────────────────┐
│ batch2 (串行执行): [write X]                             │
│   - isConcurrencySafe=false                             │
│   - 遇到不安全工具，断开 batch                            │
│   - 必须等 batch1 完成                                   │
└─────────────────────────────────────────────────────────┘
        ↓ 串行等待 batch2 完成
┌─────────────────────────────────────────────────────────┐
│ batch3 (并发执行): [read C, read D]                      │
│   - isConcurrencySafe=true                              │
│   - write 完成后，可以并发读取                           │
└─────────────────────────────────────────────────────────┘
```

#### isConcurrencySafe() 判断规则

CC 不是简单的"只读 vs 写"，而是根据**具体输入**判断：

| 工具 | isReadOnly | isConcurrencySafe | 原因 |
|------|------------|-------------------|------|
| read_file | true | **true** | 只读，不影响其他 |
| glob | true | **true** | 只读，不影响其他 |
| write_file | false | **false** | 可能影响后续 read |
| edit_file | false | **false** | 可能影响后续 read |
| bash `ls` | true | **true** | 只读命令 |
| bash `rm` | false | **false** | 写命令 |
| TaskCreate | false | **true** | 改状态但每次写不同文件，可并发 |

**Bash 的特殊处理：**

```typescript
// Bash tool 的 isConcurrencySafe 等于 isReadOnly
isConcurrencySafe(input) {
  return isReadOnly(input.command);  // 分析命令是读还是写
}

// 判断命令是否只读
function isReadOnly(command: string): boolean {
  const readOnlyPatterns = ['ls', 'cat', 'find', 'grep', 'head', 'tail', ...];
  const writePatterns = ['rm', 'mv', 'cp', 'echo >', 'sed -i', ...];
  // 分析命令内容...
}
```

**TaskCreate 的特殊并发：**

```
LLM 返回: [TaskCreate("任务1"), TaskCreate("任务2"), TaskCreate("任务3")]
         ↓ partitionToolCalls()
         ↓
batch1 (并发): [TaskCreate("任务1"), TaskCreate("任务2"), TaskCreate("任务3")]
         ↓ 可以并发！
         ↓ 原因：每个 TaskCreate 写不同的文件（task1.json, task2.json, task3.json）
         ↓ 不互相影响
```

#### 并发示例详解

**示例 1：全部并发**

```
用户: "读取 a.py, b.py, c.py 的内容"
LLM 返回: [read_file("a.py"), read_file("b.py"), read_file("c.py")]
         ↓ partitionToolCalls()
         ↓
batch1 (并发): [read_file("a.py"), read_file("b.py"), read_file("c.py")]
         ↓ 三个同时执行（假设并发上限是 10）
         ↓ 结果: [tool_result("内容A"), tool_result("内容B"), tool_result("内容C")]
```

**示例 2：写操作断开 batch**

```
用户: "读取 a.py 和 b.py，然后修改 c.py，最后再读 c.py"
LLM 返回: [read_file("a.py"), read_file("b.py"), edit_file("c.py"), read_file("c.py")]
         ↓ partitionToolCalls()
         ↓
┌─────────────────────────────────────────────────────────┐
│ batch1 (并发): [read_file("a.py"), read_file("b.py")]    │
│   - 连续的 isConcurrencySafe=true                       │
│   - 同时执行                                            │
└─────────────────────────────────────────────────────────┘
        ↓ 等待 batch1 完成
┌─────────────────────────────────────────────────────────┐
│ batch2 (串行): [edit_file("c.py")]                       │
│   - isConcurrencySafe=false                             │
│   - 断开并发，必须串行执行                               │
└─────────────────────────────────────────────────────────┘
        ↓ 等待 batch2 完成
┌─────────────────────────────────────────────────────────┐
│ batch3 (并发): [read_file("c.py")]                       │
│   - edit 完成后，可以并发（虽然只有一个）                 │
└─────────────────────────────────────────────────────────┘
```

#### 分批算法伪代码

```typescript
function partitionToolCalls(toolCalls: ToolCall[]): Batch[] {
  const batches: Batch[] = [];
  let currentBatch: ToolCall[] = [];
  
  for (const call of toolCalls) {
    const isSafe = isConcurrencySafe(call);
    
    if (isSafe) {
      // 并发安全：加入当前 batch
      currentBatch.push(call);
    } else {
      // 不并发安全：
      // 1. 先把当前 batch 提交（如果有内容）
      if (currentBatch.length > 0) {
        batches.push({ type: 'parallel', calls: currentBatch });
        currentBatch = [];
      }
      // 2. 把这个不安全的单独成 batch
      batches.push({ type: 'serial', calls: [call] });
    }
  }
  
  // 最后剩余的成 batch
  if (currentBatch.length > 0) {
    batches.push({ type: 'parallel', calls: currentBatch });
  }
  
  return batches;
}
```

#### 执行流程图

```
response.content = [read A, read B, write X, read C]
                    ↓
              partitionToolCalls()
                    ↓
    ┌───────────────────────────────────────┐
    │ batch1: [read A, read B] (parallel)    │
    └───────────────────────────────────────┘
                    ↓ await Promise.all()
    ┌───────────────────────────────────────┐
    │ batch2: [write X] (serial)             │
    └───────────────────────────────────────┘
                    ↓ await execute()
    ┌───────────────────────────────────────┐
    │ batch3: [read C] (parallel)            │
    └───────────────────────────────────────┘
                    ↓
              收集所有 results
                    ↓
              messages.append(user, results)
                    ↓
              继续下一轮 LLM 调用
```

---

## s02 新增内容详解

### 1. 安全路径校验 safe_path

```python
def safe_path(p: str) -> Path:
    path = (WORKDIR / p).resolve()
    if not path.is_relative_to(WORKDIR):
        raise ValueError(f"Path escapes workspace: {p}")
    return path
```

防止路径逃逸，确保所有文件操作都在工作目录内。

### 2. 四个新工具实现

```python
# 读文件（支持 limit 截断）
def run_read(path: str, limit: int | None = None) -> str:
    lines = safe_path(path).read_text().splitlines()
    if limit and limit < len(lines):
        lines = lines[:limit] + [f"... ({len(lines) - limit} more lines)"]
    return "\n".join(lines)

# 写文件（自动创建父目录）
def run_write(path: str, content: str) -> str:
    file_path = safe_path(path)
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(content)
    return f"Wrote {len(content)} bytes to {path}"

# 编辑文件（精确替换一次）
def run_edit(path: str, old_text: str, new_text: str) -> str:
    text = safe_path(path).read_text()
    if old_text not in text:
        return f"Error: text not found in {path}"
    safe_path(path).write_text(text.replace(old_text, new_text, 1))
    return f"Edited {path}"

# 文件搜索
def run_glob(pattern: str) -> str:
    import glob as g
    results = []
    for match in g.glob(pattern, root_dir=WORKDIR):
        if (WORKDIR / match).resolve().is_relative_to(WORKDIR):
            results.append(match)
    return "\n".join(results) if results else "(no matches)"
```

### 3. 工具分发查表

```python
# s01: 硬编码，只有一个工具
output = run_bash(block.input["command"])

# s02: 查表分发，支持多工具
handler = TOOL_HANDLERS.get(block.name)
output = handler(**block.input) if handler else f"Unknown: {block.name}"
```

---

## s01 → s02 改动对比

| 组件 | s01 | s02 |
|------|-----|-----|
| 工具数量 | 1 (bash) | 5 (+read, write, edit, glob) |
| 工具执行 | 硬编码 `run_bash()` | `TOOL_HANDLERS` 查表分发 |
| 路径安全 | 无 | `safe_path` 校验（仅 file tools） |
| 循环结构 | `while True` + `stop_reason` | **与 s01 完全一致** |

---

## 运行日志分析

### 实际运行示例

用户输入：`Create a file called test.py that prints "hello", then read it back`

```
第 1 轮内层循环:
┌─────────────────────────────────────────────────────────┐
│ LLM 返回                                                 │
│ response.content = [                                    │
│   ThinkingBlock(thinking='The user wants me to...'),    │
│   ToolUseBlock(name='write_file',                       │
│     input={path: 'test.py', content: 'print("hello")'}) │
│ ]                                                       │
│ stop_reason = "tool_use"                                │
└─────────────────────────────────────────────────────────┘
        ↓ 执行 write_file
        ↓ 输出: "Wrote 15 bytes to test.py"

第 2 轮内层循环:
┌─────────────────────────────────────────────────────────┐
│ LLM 返回                                                 │
│ response.content = [                                    │
│   ThinkingBlock(thinking=''),                           │
│   ToolUseBlock(name='read_file',                        │
│     input={path: 'test.py'})                            │
│ ]                                                       │
│ stop_reason = "tool_use"                                │
└─────────────────────────────────────────────────────────┘
        ↓ 执行 read_file
        ↓ 输出: "print("hello")"

第 3 轮内层循环:
┌─────────────────────────────────────────────────────────┐
│ LLM 返回                                                 │
│ response.content = [                                    │
│   ThinkingBlock(thinking=''),                           │
│   TextBlock(text='Done! Created test.py...')            │
│ ]                                                       │
│ stop_reason = "end_turn"  ← 不是 "tool_use"             │
└─────────────────────────────────────────────────────────┘
        ↓ 退出 agent_loop (return)
        ↓
┌─────────────────────────────────────────────────────────┐
│ main 函数第 187-189 行                                    │
│ for block in history[-1]["content"]:                    │
│     if block.type == "text":                            │
│         print(block.text)  ← 打印 "Done! Created..."    │
└─────────────────────────────────────────────────────────┘
```

### "Done! Created..." 打印位置分析

**关键代码位置：code.py 第 186-190 行**

```python
# 第 186 行：调用 agent_loop
agent_loop(history)

# 第 187-189 行：打印最终文本回复
for block in history[-1]["content"]:
    if getattr(block, "type", None) == "text":
        print(block.text)  # ← 这里打印 "Done! Created..."
```

**流程解析：**

1. `agent_loop(history)` 执行多轮工具调用
2. 最后一轮 LLM 返回 `TextBlock`，`stop_reason = "end_turn"`
3. `agent_loop` 执行 `return`，退出内层循环
4. 返回到 `main` 函数，执行第 187-189 行
5. 遍历 `history[-1]["content"]`（最后一条 assistant 消息）
6. 找到 `type == "text"` 的 block，打印其 `text` 内容

**为什么在 main 函数打印而不是 agent_loop？**

- `agent_loop` 只负责工具调用循环，不负责输出最终回复
- `main` 函数负责用户交互：接收输入 → 处理 → 输出回复
- 职责分离：`agent_loop` = 执行层，`main` = 交互层

---

## 完整执行流程示例

用户输入：`"读 README.md 和 requirements.txt，创建摘要"`

```
第 1 轮:
┌─────────────────────────────────────────────────────────┐
│ LLM 调用                                                 │
│ response.content = [                                     │
│   {type: "tool_use", name: "read_file",                  │
│    input: {path: "README.md"}},                          │
│   {type: "tool_use", name: "read_file",                  │
│    input: {path: "requirements.txt"}},                   │
│ ]                                                        │
│ stop_reason = "tool_use"                                 │
└─────────────────────────────────────────────────────────┘
        ↓ 执行两个 read_file（串行）
        ↓ results = [tool_result("内容A"), tool_result("内容B")]
        ↓ messages.append(user, results)

第 2 轮:
┌─────────────────────────────────────────────────────────┐
│ LLM 看到两个文件内容                                       │
│ response.content = [                                     │
│   {type: "tool_use", name: "write_file",                 │
│    input: {path: "summary.txt", content: "..."}},        │
│ ]                                                        │
└─────────────────────────────────────────────────────────┘
        ↓ 执行 write_file

第 3 轮:
┌─────────────────────────────────────────────────────────┐
│ response.content = [                                     │
│   {type: "text", text: "已创建摘要文件"},                  │
│ ]                                                        │
│ stop_reason = "end_turn" → 退出循环                       │
└─────────────────────────────────────────────────────────┘
```

---

## 总结

| 概念 | 核心要点 |
|------|---------|
| **TOOLS vs HANDLERS** | TOOLS 给 LLM 看（JSON Schema），HANDLERS 给程序用（执行函数） |
| **JSON Schema 标准** | Anthropic Tool Definition Schema，遵循 JSON Schema 规范 |
| **CC 工具来源** | 内置（硬编码）+ 动态（Skills/MCP） |
| **串行执行** | 教学版 for 循环串行，只处理 tool_use 块 |
| **并发执行** | CC 用 partitionToolCalls() 分批算法，并发安全的连续块并行 |
| **分批算法** | 不是简单两组，而是按连续块分批：遇到不安全工具断开 batch |
| **isConcurrencySafe** | 根据具体输入判断（Bash `ls` 可并发，Bash `rm` 不可） |
| **加工具** | TOOLS 加一条 + HANDLERS 加一行，循环不变 |
| **最终回复打印** | 在 main 函数中遍历 history[-1]["content"] 打印 text block |

---

## 参考资料

- [s02_tool_use/README.md](./README.md) — 原始教材
- Claude Code 源码 `src/tools.ts`、`toolOrchestration.ts`、`toolExecution.ts`
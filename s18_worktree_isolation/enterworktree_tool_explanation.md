# EnterWorktree 是什么？

> 本文档详细解释 EnterWorktree 的具体实现机制

---

## 目录

1. [EnterWorktree 不是解析 cd 命令](#一enterworktree-不是解析-cd-命令)
2. [EnterWorktree 是 CC 的一个 Tool](#二enterworktree-是-cc-的一个-tool)
3. [CC 的工具调用流程](#三cc-的工具调用流程)
4. [EnterWorktree 的具体实现](#四enterworktree-的具体实现)
5. [用户如何触发 EnterWorktree](#五用户如何触发-enterworktree)

---

## 一、EnterWorktree 不是解析 cd 命令

### 1.1 错误理解

```
错误理解：
EnterWorktree 是解析用户在 shell 中输入的 cd 命令

为什么错误？
- CC 不解析用户的 shell 命令
- CC 是一个 LLM Agent，不是 shell
- 用户在 CC 中输入的是自然语言 prompt，不是 shell 命令
```

### 1.2 正确理解

```
正确理解：
EnterWorktree 是 CC 提供的一个 Tool（工具）

- CC 是一个 LLM Agent（Claude Code CLI）
- 用户在 CC 中输入自然语言 prompt
- Claude 模型根据 prompt 决定调用哪个 Tool
- EnterWorktree 是其中一个 Tool
```

---

## 二、EnterWorktree 是 CC 的一个 Tool

### 2.1 CC 的 Tool 架构

```
CC 的 Tool 架构：

┌─────────────────────────────────────┐
│  Claude Code CLI                     │
│                                      │
│  用户输入：自然语言 prompt            │
│  ↓                                   │
│  Claude 模型推理                      │
│  ↓                                   │
│  决定调用哪个 Tool                    │
│  ↓                                   │
│  Tool 执行并返回结果                  │
│  ↓                                   │
│  Claude 模型继续推理                  │
│  ↓                                   │
│  返回回复给用户                       │
└─────────────────────────────────────┘

CC 的 Tools：
- BashTool：执行 shell 命令
- ReadTool：读取文件
- WriteTool：写入文件
- EditTool：编辑文件
- AgentTool：创建子 agent
- EnterWorktreeTool：切换到 worktree
- ExitWorktreeTool：退出 worktree
- GlobTool：搜索文件
- GrepTool：搜索内容
- TaskCreateTool：创建任务
- ...
```

### 2.2 EnterWorktreeTool 的定义

```
EnterWorktreeTool 是一个 Tool：

文件位置：EnterWorktreeTool.ts（真实 CC 源码）

Tool 定义：
{
    name: "EnterWorktree",
    description: "Enter a git worktree for isolated development",
    input_schema: {
        type: "object",
        properties: {
            name: {
                type: "string",
                description: "Name for the worktree"
            },
            path: {
                type: "string",
                description: "Path to an existing worktree"
            }
        }
    }
}

Tool 执行流程：
1. 用户输入自然语言 prompt（例如："switch to auth worktree"）
2. Claude 模型推理，决定调用 EnterWorktreeTool
3. EnterWorktreeTool 执行：
   - 创建 worktree（如果需要）
   - process.chdir(worktreePath)
   - 更新内部状态
4. Tool 返回结果给 Claude 模型
5. Claude 模型回复用户
```

---

## 三、CC 的工具调用流程

### 3.1 完整流程

```
CC 的工具调用流程：

Step 1: 用户输入 prompt
─────────────────────────
用户："帮我切换到 auth worktree"

Step 2: Claude 模型推理
─────────────────────────
Claude 模型接收 prompt + Tool 列表
推理：
- 用户想要切换 worktree
- 应该调用 EnterWorktreeTool
- 参数：name="auth"

Step 3: Claude 决定调用 Tool
─────────────────────────
Claude 返回：
{
    "type": "tool_use",
    "name": "EnterWorktree",
    "input": {"name": "auth"}
}

Step 4: CC 执行 Tool
─────────────────────────
EnterWorktreeTool 执行：
- git worktree add .claude/worktrees/auth -b worktree-auth HEAD
- process.chdir(".claude/worktrees/auth")
- setCwd(".claude/worktrees/auth")
- setOriginalCwd("/project")
- saveWorktreeState(...)

Step 5: Tool 返回结果
─────────────────────────
EnterWorktreeTool 返回：
{
    "type": "tool_result",
    "content": "Successfully entered worktree 'auth' at .claude/worktrees/auth"
}

Step 6: Claude 继续推理
─────────────────────────
Claude 模型接收 tool_result
推理：
- EnterWorktree 成功
- 现在在 auth worktree 中
- 回复用户

Step 7: Claude 回复用户
─────────────────────────
Claude 回复：
"我已经切换到 auth worktree。现在你可以在这里工作了。"
```

### 3.2 关键点

```
关键点：

1. 用户输入自然语言，不是 shell 命令
   - 用户："切换到 auth worktree"
   - 不是："cd .claude/worktrees/auth"

2. Claude 模型推理，决定调用哪个 Tool
   - Claude 模型理解用户意图
   - Claude 模型选择合适的 Tool
   - Claude 模型生成 Tool 调用参数

3. Tool 执行并返回结果
   - EnterWorktreeTool 执行
   - process.chdir() 改变进程 cwd
   - Tool 返回结果给 Claude 模型

4. Claude 模型继续推理
   - Claude 模型接收 tool_result
   - Claude 模型生成回复给用户

关键：
- CC 是一个 LLM Agent
- 不是 shell，不解析 shell 命令
- 用户输入自然语言 prompt
- Claude 模型决定调用哪个 Tool
- Tool 执行并返回结果
```

---

## 四、EnterWorktree 的具体实现

### 4.1 EnterWorktreeTool.ts 的代码

```typescript
// EnterWorktreeTool.ts（真实 CC 源码）

export async function enterWorktree(
    input: { name?: string; path?: string }
): Promise<string> {
    // Step 1: 获取或创建 worktree
    let worktreePath: string;
    let worktreeName: string;
    let worktreeBranch: string;

    if (input.path) {
        // 用户提供现有 worktree 的路径
        worktreePath = input.path;
        // 验证 worktree 存在
        const worktrees = await listWorktrees();
        const existing = worktrees.find(w => w.path === worktreePath);
        if (!existing) {
            throw new Error(`Worktree not found: ${worktreePath}`);
        }
        worktreeName = existing.name;
        worktreeBranch = existing.branch;
    } else if (input.name) {
        // 用户提供 worktree 名称，创建新 worktree
        worktreeName = input.name;
        worktreeBranch = `worktree-${input.name}`;
        worktreePath = `.claude/worktrees/${input.name}`;

        // 创建 worktree
        await exec(`git worktree add ${worktreePath} -b ${worktreeBranch} HEAD`);
    } else {
        // 没有提供 name 或 path，生成随机名称
        worktreeName = generateRandomName();
        worktreeBranch = `worktree-${worktreeName}`;
        worktreePath = `.claude/worktrees/${worktreeName}`;

        // 创建 worktree
        await exec(`git worktree add ${worktreePath} -b ${worktreeBranch} HEAD`);
    }

    // Step 2: 切换进程 cwd
    const originalCwd = process.cwd();
    process.chdir(worktreePath);         // ← 关键：改变整个进程的 cwd
    setCwd(worktreePath);                // ← 更新内部状态
    setOriginalCwd(originalCwd);         // ← 记录原始 cwd（用于恢复）
    saveWorktreeState({                  // ← 保存 worktree 状态
        originalCwd,
        worktreePath,
        worktreeName,
        worktreeBranch,
        sessionId: getCurrentSessionId()
    });

    // Step 3: 返回结果
    return `Successfully entered worktree '${worktreeName}' at ${worktreePath}`;
}

关键：
1. 用户可以提供 name 或 path
2. 如果提供 name，创建新 worktree
3. 如果提供 path，进入现有 worktree
4. process.chdir() 改变整个进程的 cwd
5. 保存原始 cwd 和 worktree 状态（用于恢复）
```

### 4.2 ExitWorktreeTool.ts 的代码

```typescript
// ExitWorktreeTool.ts（真实 CC 源码）

export async function exitWorktree(
    input: { action: "keep" | "remove" }
): Promise<string> {
    // Step 1: 获取 worktree 状态
    const worktreeState = getWorktreeState();
    if (!worktreeState) {
        return "Not in a worktree";
    }

    const { originalCwd, worktreePath, worktreeName } = worktreeState;

    // Step 2: 恢复进程 cwd
    process.chdir(originalCwd);          // ← 关键：恢复进程 cwd
    setCwd(originalCwd);                 // ← 更新内部状态
    clearWorktreeState();                // ← 清除 worktree 状态

    // Step 3: 处理 worktree（根据 action）
    if (input.action === "remove") {
        // 删除 worktree
        await exec(`git worktree remove ${worktreePath}`);
        return `Exited and removed worktree '${worktreeName}'`;
    } else {
        // 保留 worktree
        return `Exited worktree '${worktreeName}', worktree preserved`;
    }

    关键：
    1. process.chdir(originalCwd) 恢复进程 cwd
    2. 清除 worktree 状态
    3. 根据 action 决定是否删除 worktree
}
```

---

## 五、用户如何触发 EnterWorktree

### 5.1 通过自然语言 prompt

```
方式1：自然语言 prompt

用户："帮我切换到 auth worktree"
↓
Claude 模型推理
↓
Claude 决定调用 EnterWorktreeTool
↓
参数：{"name": "auth"}
↓
EnterWorktreeTool 执行
↓
创建 .claude/worktrees/auth worktree
↓
process.chdir(".claude/worktrees/auth")
↓
返回结果："Successfully entered worktree 'auth'"
↓
Claude 回复用户："我已经切换到 auth worktree"
```

### 5.2 通过 Tool name 直接调用

```
方式2：Tool name 直接调用（高级用户）

用户："EnterWorktree name=auth"
↓
Claude 模型识别这是 Tool 调用请求
↓
直接调用 EnterWorktreeTool
↓
参数：{"name": "auth"}
↓
EnterWorktreeTool 执行
↓
返回结果

注意：
- 这是高级用户的方式
- 直接指定 Tool name 和参数
- 不是 shell 命令，是 Tool 调用请求
```

### 5.3 通过斜杠命令

```
方式3：斜杠命令（如果 CC 支持）

用户："EnterWorktree auth"
↓
CC 解析斜杠命令
↓
直接调用 EnterWorktreeTool
↓
参数：{"name": "auth"}
↓
EnterWorktreeTool 执行
↓
返回结果

注意：
- 这取决于 CC 是否支持斜杠命令
- 不是 shell 命令，是 CC 的内部命令
- 类似 /help、/clear 等
```

---

## 六、总结

### 6.1 EnterWorktree 是什么？

```
EnterWorktree 是什么？

答案：
EnterWorktree 是 CC 提供的一个 Tool（工具）

不是：
- 不是解析用户的 cd 命令
- 不是 shell 命令
-不是 shell 的别名

是：
- 是 CC 的一个 Tool（EnterWorktreeTool）
- 是 Claude 模型可以调用的工具
- 是通过自然语言 prompt 触发的
- 是通过 Claude 模型推理决定调用的
```

### 6.2 用户如何触发 EnterWorktree？

```
用户触发 EnterWorktree 的方式：

1. 自然语言 prompt：
   用户："切换到 auth worktree"
   ↓ Claude 模型推理
   ↓ 调用 EnterWorktreeTool

2. Tool name 直接调用：
   用户："EnterWorktree name=auth"
   ↓ 直接调用 EnterWorktreeTool

3. 斜杠命令（如果支持）：
   用户："EnterWorktree auth"
   ↓ 直接调用 EnterWorktreeTool

关键：
- 用户输入的是自然语言或 Tool 调用请求
- 不是 shell 命令（不是 cd xxx）
- Claude 模型决定调用哪个 Tool
- Tool 执行并返回结果
```

### 6.3 EnterWorktree 的执行效果

```
EnterWorktree 的执行效果：

1. 创建 worktree（如果需要）：
   git worktree add .claude/worktrees/auth -b worktree-auth HEAD

2. 切换进程 cwd：
   process.chdir(".claude/worktrees/auth")

3. 更新内部状态：
   setCwd(worktreePath)
   setOriginalCwd(originalCwd)
   saveWorktreeState(...)

4. 效果：
   - 整个进程切换到 worktree
   - Lead Agent 也切换到 worktree
   - 所有 Promise 都在 worktree 执行
   - process.cwd() = .claude/worktrees/auth
   - 类似 cd xxx（但不是 cd 命令）
```

### 6.4 对比图

```
Shell vs CC 的对比：

Shell：
─────────────────────────
用户输入："cd /project/.worktrees/auth"
↓ Shell 解析 cd 命令
↓ Shell 执行 chdir("/project/.worktrees/auth")
↓ Shell 进程 cwd 改变
↓ 所有后续命令在 auth 执行

CC：
─────────────────────────
用户输入："切换到 auth worktree"（自然语言）
↓ Claude 模型推理
↓ Claude 决定调用 EnterWorktreeTool
↓ EnterWorktreeTool 执行
↓ process.chdir(".claude/worktrees/auth")
↓ Node.js 进程 cwd 改变
↓ 所有后续操作在 auth 执行

关键区别：
- Shell：用户输入 shell 命令，Shell 解析执行
- CC：用户输入自然语言，Claude 模型推理决定调用 Tool
- Shell：cd 命令是 shell 内置命令
- CC：EnterWorktree 是 CC 提供的 Tool
```

---

## 七、关键理解

```
关键理解：

1. EnterWorktree 是 Tool，不是 shell 命令
   - 是 CC 提供的工具
   - 是 Claude 模型可以调用的
   - 不是解析用户的 cd 命令

2. 用户输入自然语言，不是 shell 命令
   - 用户："切换到 auth worktree"
   - 不是："cd .claude/worktrees/auth"

3. Claude 模型决定调用哪个 Tool
   - Claude 模型推理用户意图
   - Claude 模型选择合适的 Tool
   - Claude 模型生成 Tool 调用参数

4. Tool 执行并返回结果
   - EnterWorktreeTool 执行
   - process.chdir() 改变进程 cwd
   - Tool 返回结果给 Claude 模型

5. 类似 cd xxx 的效果，但机制完全不同
   - 效果：进程 cwd 改变，所有后续操作在新目录执行
   - 机制：Tool 调用，不是 shell 命令解析
```
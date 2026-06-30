# Node.js 单线程与 process.chdir() 的矛盾解析

> 本文档解析 Node.js 单线程环境下 process.chdir() 的影响范围问题

---

## 目录

1. [用户的质疑](#一用户的质疑)
2. [关键矛盾](#二关键矛盾)
3. [真实 CC 的两种场景](#三真实-cc-的两种场景)
4. [AgentTool isolation 的真相](#四agenttool-isolation-的真相)
5. [结论](#五结论)

---

## 一、用户的质疑

```
用户的质疑：
"为什么 Node.js 是单线程就可以使用 process.chdir()？
 把整个进程的工作目录都切换了？
 那 subagent 或者 teammate 都会受到影响才对。"
```

这个质疑非常关键，揭示了 Node.js 单线程的本质矛盾。

---

## 二、关键矛盾

### 2.1 Node.js 单线程的本质

```
Node.js 的执行模型：

┌─────────────────────────────────────┐
│  Node.js 进程                        │
│  cwd = /project                      │ ← 进程的全局 cwd
│                                      │
│  Event Loop（单线程）                 │
│                                      │
│  ┌──────────────┬──────────────┐    │
│  │ Promise A    │ Promise B    │    │ ← 异步 Promise
│  │ (Alice)      │ (Bob)        │    │ ← 在同一个线程执行
│  │ cwd: ???     │ cwd: ???     │    │ ← cwd 是什么？
│  └──────────────┴──────────────┘    │
│                                      │
│  process.cwd() = /project           │ ← 所有 Promise 共享这个 cwd！
└─────────────────────────────────────┘

关键：
- Node.js 是单线程 Event Loop
- 所有 Promise 在同一个线程执行（交替执行）
- cwd 是进程的全局状态
- 所有 Promise 共享同一个 cwd！
```

### 2.2 process.chdir() 的影响范围

```javascript
// process.chdir() 会改变整个进程的 cwd

// 场景1：Alice 执行 process.chdir()
async function alice_promise() {
    process.chdir('/project/.worktrees/auth');  // ← 改变整个进程的 cwd
    await fs.readFile('config.py');             // ← 在 auth 目录读取
}

// 场景2：Bob 同时执行（实际上是交替执行）
async function bob_promise() {
    process.chdir('/project/.worktrees/ui');    // ← 改变整个进程的 cwd（覆盖 Alice 的）
    await fs.readFile('login.vue');             // ← 在 ui 目录读取
}

// 问题：
// 1. Alice 的 process.chdir() 改变进程 cwd 到 auth
// 2. Alice 执行 fs.readFile('config.py') → 在 auth 目录读取（正确）
// 3. Event Loop 切换到 Bob
// 4. Bob 的 process.chdir() 改变进程 cwd 到 ui（覆盖 Alice 的）
// 5. Bob 执行 fs.readFile('login.vue') → 在 ui 目录读取（正确）
// 6. Event Loop 切换回 Alice
// 7. Alice 继续执行... → cwd 已经是 ui（错误！）

关键矛盾：
- process.chdir() 是进程级操作，影响所有 Promise
- Alice 和 Bob 的 cwd 会互相干扰
- 单线程不意味着 cwd 隔离！
```

### 2.3 搜索结果的验证

根据搜索结果：

```
关键发现：

1. process.chdir() 在 worker threads 中不可用
   - 抛出 ERR_WORKER_NOT_SUPPORTED
   - 因为 worker threads 共享主进程的工作目录状态

2. process.chdir() 会影响整个进程
   - cwd 是 per-process resource（进程级资源）
   - 不是 per-thread 或 per-isolate

3. 这会导致竞态条件
   - 多个异步操作依赖不同的 cwd
   - process.chdir() 会影响所有异步操作

验证了用户的质疑：
- Node.js 单线程不意味着 cwd 隔离
- process.chdir() 会影响所有 Promise
```

---

## 三、真实 CC 的两种场景

### 3.1 场景1：EnterWorktree（用户主动切换）

```
EnterWorktree 的设计：

用户执行 EnterWorktree → 整个进程切换到 worktree

┌─────────────────────────────────────┐
│  Node.js 进程                        │
│                                      │
│  用户执行：EnterWorktree auth        │
│  ↓                                   │
│  process.chdir('/project/.worktrees/auth') │ ← 整个进程切换
│                                      │
│  Event Loop                          │
│  ┌──────────────┬──────────────┐    │
│  │ Promise A    │ Promise B    │    │ ← 所有 Promise 在 auth 执行
│  │ (Alice)      │ (Bob)        │    │ ← cwd 都是 auth
│  └──────────────┴──────────────┘    │
│                                      │
│  process.cwd() = /project/.worktrees/auth │
└─────────────────────────────────────┘

特点：
- 用户主动切换（明确的意图）
- 整个进程切换到 worktree
- 所有操作都在 worktree 执行
- 这是设计，不是 bug

类比：
- 用户在终端执行 cd /project/.worktrees/auth
- 所有后续命令都在 auth 目录执行
- 用户明确知道自己在 auth 目录
```

### 3.2 场景2：AgentTool isolation（子 agent 独立 worktree）

```
AgentTool isolation 的设计：

Lead Agent 在主仓库，子 agent 在 worktree

┌─────────────────────────────────────┐
│  Node.js 进程                        │
│                                      │
│  Lead Agent                          │
│  cwd = /project                      │ ← Lead 的 cwd
│                                      │
│  AgentTool.spawn("alice", isolation="worktree") │
│  ↓                                   │
│  子 agent Alice 在 worktree 执行      │
│  ↓                                   │
│  如何让 Alice 的 cwd 是 worktree？    │ ← 问题！
│  ↓                                   │
│  Lead 的 cwd 仍然是 /project？        │ ← 问题！
│                                      │
│  如果用 process.chdir()：             │
│  - Alice 的 cwd 变成 worktree         │
│  - Lead 的 cwd 也变成 worktree（错误）│ ← 不能用！
│                                      │
│  如果不用 process.chdir()：           │
│  - Alice 如何在 worktree 执行？       │ ← 用 cwdOverridePath！
│  - Lead 如何保持 /project？           │ ← cwdOverridePath 不影响进程 cwd
│                                      │
│  process.cwd() = /project            │ ← 进程 cwd 不变
└─────────────────────────────────────┘

关键：
- AgentTool isolation 不能用 process.chdir()
- 因为会影响 Lead Agent 的 cwd
- 需要用 cwdOverridePath（类似教学版的 wt_ctx）
```

---

## 四、AgentTool isolation 的真相

### 4.1 cwdOverridePath 的机制

```javascript
// AgentTool isolation 的 cwdOverridePath

// 不是 process.chdir()！
// 而是通过 cwdOverridePath 包住子 agent 的工具调用

// 类似教学版的 wt_ctx["path"]

// 子 agent 的工具调用时：
async function alice_promise() {
    // 子 agent 的 cwdOverridePath = '/project/.worktrees/auth'

    // 工具调用：read_file('config.py')
    const result = await readFile('config.py', {
        cwd: cwdOverridePath  // ← 传入 cwd 参数（类似 subprocess.cwd）
    });

    // 工具调用：bash('ls')
    const result = await execCommand('ls', {
        cwd: cwdOverridePath  // ← 传入 cwd 参数
    });

    // 效果：
    // - readFile 在 cwdOverridePath 执行
    // - execCommand 在 cwdOverridePath 执行
    // - process.cwd() 不变（仍然是 /project）
    // - Lead Agent 的 cwd 不受影响
}

关键：
- cwdOverridePath 不是 process.chdir()
- 是传入工具函数的 cwd 参数
- 类似 subprocess.run(cwd=...) 或 readFile(cwd=...)
- 不改变进程的 cwd
```

### 4.2 教学版的对应机制

```python
# 教学版的 wt_ctx["path"]

wt_ctx = {"path": None}  ← 闭包字典

def _run_bash(command: str) -> str:
    return subprocess.run(command, cwd=wt_ctx["path"])  ← 传入 cwd 参数

def _run_read(path: str) -> str:
    return safe_path(path, cwd=wt_ctx["path"])  ← 传入 cwd 参数

def _run_write(path: str, content: str) -> str:
    return safe_path(path, cwd=wt_ctx["path"])  ← 传入 cwd 参数

关键：
- wt_ctx["path"] 不改变进程 cwd
- 只是传入工具函数的 cwd 参数
- 类似真实 CC 的 cwdOverridePath
```

### 4.3 对比总结

```
机制对比：

┌─────────────────────────────────────┐
│  教学版（Python 多线程）             │
│                                      │
│  wt_ctx = {"path": None}             │ ← 线程局部变量（闭包）
│                                      │
│  Alice 线程：wt_ctx["path"] = auth   │ ← Alice 的 cwd
│  Bob 线程：wt_ctx["path"] = ui       │ ← Bob 的 cwd
│                                      │
│  工具调用：subprocess.run(cwd=wt_ctx["path"]) │ ← 传入 cwd 参数
│                                      │
│  os.getcwd() = /project              │ ← 进程 cwd 不变
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│  真实 CC（Node.js 单线程）            │
│                                      │
│  cwdOverridePath = null              │ ← 异步上下文变量
│                                      │
│  Alice Promise：cwdOverridePath = auth │ ← Alice 的 cwd
│  Bob Promise：cwdOverridePath = ui     │ ← Bob 的 cwd
│                                      │
│  工具调用：readFile(cwd=cwdOverridePath) │ ← 传入 cwd 参数
│                                      │
│  process.cwd() = /project            │ ← 进程 cwd 不变
└─────────────────────────────────────┘

关键：
- 教学版：wt_ctx（闭包）
- 真实 CC：cwdOverridePath（异步上下文）
- 都不改变进程 cwd
- 都是传入工具函数的 cwd 参数
```

---

## 五、结论

### 5.1 用户的质疑是对的

```
用户的质疑：
"Node.js 单线程就可以使用 process.chdir()？
 把整个进程的工作目录都切换了？
 那 subagent 或者 teammate 都会受到影响才对。"

答案：
✅ 是的！process.chdir() 会影响所有 Promise
✅ Node.js 单线程不意味着 cwd 隔离
✅ cwd 是进程级资源，所有 Promise 共享

所以：
❌ AgentTool isolation 不能用 process.chdir()
✅ AgentTool isolation 用 cwdOverridePath（类似 wt_ctx）
✅ cwdOverridePath 不改变进程 cwd
✅ cwdOverridePath 是传入工具函数的 cwd 参数
```

### 5.2 EnterWorktree 可以用 process.chdir()

```
EnterWorktree 的特殊情况：

用户执行 EnterWorktree → process.chdir(worktreePath)

为什么可以？
- 这是用户主动切换（明确的意图）
- 整个进程切换到 worktree
- 所有操作都在 worktree 执行
- Lead Agent 也切换到 worktree
- 这是设计，不是 bug

类比：
- 用户在终端执行 cd /project/.worktrees/auth
- 所有后续命令都在 auth 目录执行
- 用户明确知道自己在 auth 目录
```

### 5.3 AgentTool isolation 不能用 process.chdir()

```
AgentTool isolation 不能用 process.chdir()：

原因：
- 子 agent 在 worktree，Lead 在主仓库
- process.chdir() 会影响 Lead 的 cwd
- Lead 和子 agent 的 cwd 会互相干扰

解决方案：
- 用 cwdOverridePath（类似 wt_ctx）
- 不改变进程 cwd
- 传入工具函数的 cwd 参数
```

### 5.4 最终总结

```
Node.js 单线程的 cwd 问题：

┌─────────────────────────────────────────┐
│  process.chdir()                         │
│  - 进程级操作                             │
│  - 影响所有 Promise                       │
│  - 用于 EnterWorktree（用户主动切换）    │
│  - 不用于 AgentTool isolation            │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  cwdOverridePath                         │
│  - 异步上下文变量                         │
│  - 不改变进程 cwd                         │
│  - 传入工具函数的 cwd 参数                │
│  - 用于 AgentTool isolation              │
│  - 类似教学版的 wt_ctx                    │
└─────────────────────────────────────────┘

关键理解：
- Node.js 单线程不意味着 cwd 隔离
- cwd 是进程级资源，所有 Promise 共享
- process.chdir() 会影响所有 Promise
- cwdOverridePath 不改变进程 cwd
- cwdOverridePath 是传入工具函数的 cwd 参数
```

---

## 参考资料

- [Node.js process.chdir() Documentation](https://nodejs.org/api/process.html#process_process_chdir_directory)
- [Node.js Worker Threads and process.chdir()](https://nodejs.org/api/worker_threads.html)
- s15_agent_teams/README_ME2.md
- s18_worktree_isolation/code.py
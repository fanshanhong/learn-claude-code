# CC 架构与目录切换机制完整梳理

> 本文档基于之前的讨论，完整梳理真实 CC 的架构和目录切换机制

---

## 目录

1. [真实 CC 的架构：Promise 与单线程](#一真实-cc-的架构promise-与单线程)
2. [Worktree 的 cwd 机制：cwdOverridePath](#二worktree-的-cwd-机制cwdoverridepath)
3. [EnterWorktree 的含义](#三enterworktree-的含义)
4. [完整对比总结](#四完整对比总结)

---

## 一、真实 CC 的架构：Promise 与单线程

### 1.1 核心事实

```
真实 CC 的架构：

┌─────────────────────────────────────┐
│  Node.js 进程                        │
│  cwd = /project                      │ ← 进程的全局 cwd
│                                      │
│  Event Loop（单线程）                 │ ← 只有一个线程！
│                                      │
│  ┌──────────────┬──────────────┐    │
│  │ Promise A    │ Promise B    │    │ ← 异步 Promise
│  │ (subagent)   │ (teammate)   │    │ ← 不是线程，不是进程
│  │              │              │    │ ← 在同一个线程中交替执行
│  └──────────────┴──────────────┘    │
│                                      │
│  process.cwd() = /project           │ ← 所有 Promise 共享这个 cwd
└─────────────────────────────────────┘

关键事实：
1. Node.js 是单线程 Event Loop
2. subagent 和 teammate 都是异步 Promise
3. 不是多线程（Node.js 无法创建多线程）
4. 不是多进程（都在同一个 Node.js 进程）
5. 在同一个线程中交替执行（Event Loop 调度）
6. 共享同一个进程的 cwd
```

### 1.2 process.chdir() 的影响

```
process.chdir() 会影响所有 Promise：

原因：
- process.chdir() 是进程级操作
- cwd 是进程的全局状态
- 所有 Promise 共享同一个 cwd

如果 Alice 执行 process.chdir(worktreeA)：
- Lead Agent 的 cwd 变成 worktreeA
- Bob Promise 的 cwd 也变成 worktreeA
- 所有后续操作的 cwd 都是 worktreeA

这会导致：
- Lead Agent 和子 agent 的 cwd 互相干扰
- teammate 之间的 cwd 互相干扰
- 不能用 process.chdir() 来隔离 cwd
```

### 1.3 为什么 Node.js 不能创建多线程？

```
Node.js 的设计：

Node.js 主线程：
- 单线程 Event Loop
- 处理所有异步操作
- Promise、async/await 都在主线程执行

Worker Threads（Node.js 10+）：
- 可以创建 Worker Threads
- 但 Worker Threads 不支持 process.chdir()
  （会抛出 ERR_WORKER_NOT_SUPPORTED）
- Worker Threads 共享主进程的 cwd

所以：
- Node.js 主线程无法创建多线程
- Worker Threads 不是常规方案
- CC 使用 Promise（异步），不是多线程
```

---

## 二、Worktree 的 cwd 机制：cwdOverridePath

### 2.1 教学版的 wt_ctx

```python
# 教学版的 wt_ctx 机制

wt_ctx = {"path": None}  # ← 线程局部变量（闭包）

# Alice 线程
def alice_thread():
    wt_ctx["path"] = ".worktrees/auth"  # ← Alice 的 cwd
    
    # 工具调用
    subprocess.run("ls", cwd=wt_ctx["path"])  # ← 传入 cwd 参数
    # ↓ subprocess 在 .worktrees/auth 执行 ls
    # ↓ 子进程的 cwd = .worktrees/auth
    # ↓ 父进程的 cwd 不变（仍然是 /project）
    
    fp = safe_path("config.py", cwd=wt_ctx["path"])  # ← 传入 cwd 参数
    # ↓ 拼接路径：.worktrees/auth/config.py
    # ↓ 在 .worktrees/auth 读取文件
    # ↓ 父进程的 cwd 不变

关键：
- wt_ctx["path"] 不改变进程 cwd
- 只是传入工具函数的 cwd 参数
- subprocess.run(cwd=...)：子进程的 cwd 改变，父进程不变
- safe_path(cwd=...)：路径拼接，进程 cwd 不变
```

### 2.2 真实 CC 的 cwdOverridePath

```javascript
// 真实 CC 的 cwdOverridePath 机制

// AgentTool isolation
const cwdOverridePath = worktreePath;  // ← 子 agent 的 cwd（类似 wt_ctx）

// 子 agent 的工具调用
async function alice_promise() {
    // cwdOverridePath = '/project/.worktrees/auth'
    
    // 工具调用：bash
    const result = await execCommand('ls', {
        cwd: cwdOverridePath  // ← 传入 cwd 参数
    });
    // ↓ execCommand 在 .worktrees/auth 执行 ls
    // ↓ 类似 subprocess.run(cwd=...)
    // ↓ 子进程的 cwd = .worktrees/auth
    // ↓ 父进程的 cwd 不变
    
    // 工具调用：read_file
    const content = await readFile('config.py', {
        cwd: cwdOverridePath  // ← 传入 cwd 参数
    });
    // ↓ readFile 在 .worktrees/auth 读取文件
    // ↓ 类似 safe_path(cwd=...)
    // ↓ 路径拼接，进程 cwd 不变
}

关键：
- cwdOverridePath 不改变进程 cwd
- 是传入工具函数的 cwd 参数
- 类似教学版的 wt_ctx["path"]
- execCommand(cwd=...)：类似 subprocess.run(cwd=...)
- readFile(cwd=...)：类似 safe_path(cwd=...)
```

### 2.3 cwdOverridePath 是否传给 subprocess.run？

```
回答：是的，类似机制！

Node.js 中执行 shell 命令：

// child_process.exec/spawn（类似 Python 的 subprocess.run）
const { exec, spawn } = require('child_process');

// execCommand 的实现（类似 subprocess.run）
async function execCommand(command, options) {
    return new Promise((resolve, reject) => {
        exec(command, {
            cwd: options.cwd  // ← cwdOverridePath 传入这里！
        }, (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve(stdout);
        });
    });
}

效果：
- exec(command, {cwd: cwdOverridePath})
- 子进程的 cwd = cwdOverridePath
- 父进程的 cwd 不变
- 完全类似 Python 的 subprocess.run(command, cwd=wt_ctx["path"])

所以：
✅ cwdOverridePath 会传给 child_process.exec/spawn
✅ 影响子进程的 cwd，不影响父进程
✅ 完全类似教学版的 subprocess.run(cwd=wt_ctx["path"])
```

---

## 三、EnterWorktree 的含义

### 3.1 EnterWorktree 是什么？

```
EnterWorktree 的含义：

EnterWorktree = 用户主动切换整个进程到 worktree

类比：
- 用户在终端执行 cd /project/.worktrees/auth
- 所有后续命令都在 auth 目录执行
- 用户明确知道自己在 auth 目录

真实 CC 中：
- EnterWorktree 是一个工具（用户可以调用）
- 用户执行：EnterWorktree auth
- 整个进程切换到 .worktrees/auth
- 所有后续操作都在 auth 执行
- Lead Agent 也切换到 auth
- 所有 Promise 也都在 auth 执行

代码：
// EnterWorktreeTool.ts
process.chdir(worktreePath);  // ← 整个进程切换
setCwd(worktreePath);         // ← 更新内部状态
setOriginalCwd(originalCwd);  // ← 记录原始 cwd（用于恢复）
saveWorktreeState(...);       // ← 保存状态

效果：
- process.cwd() 变成 worktreePath
- 所有后续操作在 worktree 执行
- 这是用户主动切换（明确的意图）
```

### 3.2 EnterWorktree vs AgentTool isolation

```
关键区别：

EnterWorktree（用户主动切换）：
- 用户调用工具，明确切换
- process.chdir(worktreePath) ← 整个进程切换
- Lead Agent 也切换到 worktree
- 所有 Promise 都在 worktree 执行
- 这是设计，不是 bug
- 类似用户在终端执行 cd xxx

AgentTool isolation（子 agent 独立 worktree）：
- 子 agent 在 worktree，Lead 在主仓库
- 不能用 process.chdir() ← 会影响 Lead
- 用 cwdOverridePath ← 不改变进程 cwd
- cwdOverridePath 传给工具函数的 cwd 参数
- Lead 的 cwd 不变，子 agent 在 worktree 执行
- 类似教学版的 wt_ctx["path"]

对比：

┌─────────────────────────────────────┐
│  EnterWorktree                       │
│  - 用户主动切换                       │
│  - process.chdir(worktreePath)       │ ← 改变进程 cwd
│  - Lead 也切换到 worktree             │
│  - 所有 Promise 都在 worktree         │
│  - 类似 cd xxx                        │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│  AgentTool isolation                 │
│  - 子 agent 独立 worktree             │
│  - cwdOverridePath                   │ ← 不改变进程 cwd
│  - Lead 仍然在主仓库                  │
│  - 子 agent 在 worktree 执行          │
│  - 类似 wt_ctx                        │
└─────────────────────────────────────┘
```

### 3.3 ExitWorktree 的含义

```
ExitWorktree = 恢复到原始目录

类比：
- 用户在终端执行 cd /project（回到原始目录）

真实 CC 中：
- ExitWorktree 恢复到原始 cwd
- process.chdir(originalCwd) ← 恢复进程 cwd
- 清除 worktree 状态

代码：
// ExitWorktreeTool.ts
process.chdir(originalCwd);  // ← 恢复进程 cwd
clearWorktreeState(...);     // ← 清除状态

效果：
- process.cwd() 恢复到 originalCwd
- 所有后续操作在原始目录执行
- 类似 cd 回原始目录
```

---

## 四、完整对比总结

### 4.1 架构对比

```
| 维度 | 教学版（Python） | 真实 CC（Node.js） |
|------|----------------|-------------------|
| **执行单元** | threading.Thread | Promise（异步） |
| **真实线程** | ✅ 是 | ❌ 否（单线程） |
| **进程管理** | 同一个进程 | 同一个进程 |
| **cwd 共享** | 共享进程 cwd | 共享进程 cwd |
| **隔离机制** | wt_ctx（闭包） | cwdOverridePath（异步上下文） |
| **cwd 影响** | subprocess.run(cwd=...) | exec/spawn(cwd=...) |
```

### 4.2 目录切换对比

```
| 场景 | 教学版 | 真实 CC |
|------|--------|---------|
| **EnterWorktree** | 无此概念 | process.chdir()（用户主动切换） |
| **AgentTool isolation** | wt_ctx + subprocess.cwd | cwdOverridePath + exec.cwd |
| **Lead cwd** | 不变 | EnterWorktree：变<br>isolation：不变 |
```

### 4.3 完整流程图

```
教学版：

┌─────────────────────────────────────┐
│  Python 进程                         │
│  cwd = /project                      │ ← 进程 cwd
│                                      │
│  Lead 线程                           │
│  wt_ctx["path"] = None               │ ← Lead 的 cwd
│                                      │
│  Alice 线程（daemon）                 │
│  wt_ctx["path"] = ".worktrees/auth"  │ ← Alice 的 cwd
│  ↓                                   │
│  subprocess.run("ls", cwd=wt_ctx["path"]) │ ← 子进程在 auth 执行
│  ↓                                   │
│  父进程 cwd 不变                      │
│                                      │
│  os.getcwd() = /project              │ ← 进程 cwd 不变
└─────────────────────────────────────┘


真实 CC（EnterWorktree）：

┌─────────────────────────────────────┐
│  Node.js 进程                        │
│                                      │
│  用户执行：EnterWorktree auth        │
│  ↓                                   │
│  process.chdir("/project/.worktrees/auth") │ ← 进程 cwd 改变
│                                      │
│  Lead Promise                        │ ← Lead 也切换到 auth
│  Alice Promise                       │ ← Alice 也切换到 auth
│  Bob Promise                         │ ← Bob 也切换到 auth
│                                      │
│  process.cwd() = /project/.worktrees/auth │ ← 所有 Promise 共享
└─────────────────────────────────────┘


真实 CC（AgentTool isolation）：

┌─────────────────────────────────────┐
│  Node.js 进程                        │
│                                      │
│  Lead Promise                        │
│  cwd = /project                      │ ← Lead 的 cwd（进程 cwd）
│                                      │
│  Alice Promise（isolation）           │
│  cwdOverridePath = ".worktrees/auth" │ ← Alice 的 cwd（不改变进程 cwd）
│  ↓                                   │
│  exec("ls", {cwd: cwdOverridePath})  │ ← 子进程在 auth 执行
│  ↓                                   │
│  父进程 cwd 不变                      │
│                                      │
│  process.cwd() = /project            │ ← 进程 cwd 不变
└─────────────────────────────────────┘
```

---

## 五、最终总结

### 问题1的答案

```
✅ 真实 CC 中，subagent 和 teammate 都是通过 Promise 实现
✅ Node.js 单线程，无法创建多线程
✅ subagent 和 teammate 都在同一个线程中交替执行
✅ process.chdir() 会影响所有 Promise
```

### 问题2的答案

```
✅ Worktree 的 cwd 仍然是进程级的（不要改，会污染）
✅ 教学版：wt_ctx["path"] 传入 subprocess.run(cwd=...)
✅ 真实 CC：cwdOverridePath 传入 child_process.exec/spawn({cwd: ...})
✅ 都不改变进程 cwd，只影响子进程的 cwd
✅ 完全类似的机制
```

### 问题3的答案

```
✅ EnterWorktree = 用户主动切换整个进程到 worktree
✅ 类似用户手动 cd xxx
✅ process.chdir(worktreePath) 改变整个进程 cwd
✅ Lead Agent 也切换到 worktree
✅ 所有 Promise 都在 worktree 执行
✅ 这是用户主动切换（明确的意图）
✅ 这是设计，不是 bug
```

---

## 六、关键理解

```
三个关键概念：

1. Node.js 单线程架构：
   - subagent 和 teammate 都是 Promise
   - 在同一个线程中交替执行
   - 共享同一个进程 cwd

2. cwdOverridePath 机制：
   - 不改变进程 cwd
   - 传入工具函数的 cwd 参数
   - 类似教学版的 wt_ctx["path"]
   - exec/spawn({cwd: cwdOverridePath}) 影响子进程

3. EnterWorktree vs AgentTool isolation：
   - EnterWorktree：用户主动切换，process.chdir()，整个进程切换
   - AgentTool isolation：子 agent 独立，cwdOverridePath，进程 cwd 不变

关键：
- Node.js 单线程不意味着 cwd 隔离
- cwdOverridePath 不是 process.chdir()
- cwdOverridePath 是传入工具函数的 cwd 参数
- EnterWorktree 是用户主动切换，类似 cd xxx
```
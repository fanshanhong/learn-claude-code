# s18 目录切换与 Worktree 机制详解

> 本文档详细讨论 cwd 参数、worktree 结构、以及真实 CC 的实现机制

---

## 目录

1. [问题1：cwd 是什么？](#一问题1cwd-是什么)
2. [问题2：Worktree 的内容与 Git 分支](#二问题2worktree-的内容与-git-分支)
3. [问题3：CC 的真实实现机制](#三问题3cc-的真实实现机制)
4. [教学版 vs 真实 CC 的对比](#四教学版-vs-真实-cc-的对比)

---

## 一、问题1：cwd 是什么？

### 1.1 cwd 的定义

**cwd = Current Working Directory（当前工作目录）**

```
定义：
- cwd 是进程的一个属性，表示进程当前在哪个目录下工作
- 在 Python 中：os.getcwd() 或 Path.cwd() 获取当前 cwd
- 在 Node.js 中：process.cwd() 获取当前 cwd

关键：
- cwd 影响相对路径的解析
- cwd 影响子进程的执行位置
```

### 1.2 cwd 是 bash 命令的参数吗？

**答案：不是 bash 命令本身的参数，是 subprocess.run 的参数。**

```python
# ❌ 错误理解：cwd 是 bash 命令的参数
subprocess.run("ls", shell=True, cwd="/some/path")
# 这不是给 ls 命令传参数！
# 这是给 subprocess.run 传参数！

# ✅ 正确理解：cwd 是 subprocess.run 的参数
subprocess.run(
    "ls -la",           # ← 命令本身（可以带参数）
    shell=True,         # ← shell 执行模式
    cwd="/some/path"    # ← subprocess.run 的参数：指定在哪个目录执行
)

# 效果：
# subprocess 在 /some/path 目录下执行 "ls -la" 命令
# 相当于：cd /some/path && ls -la
# 但进程的 cwd 不变（仍然在调用者的 cwd）
```

### 1.3 subprocess.run 的 cwd 参数详解

```python
# subprocess.run 的 cwd 参数

import subprocess

# 案例1：不指定 cwd（默认在进程的 cwd 执行）
subprocess.run("ls", shell=True)
# ← 在 process.cwd() 执行 ls

# 案例2：指定 cwd（在指定目录执行）
subprocess.run("ls", shell=True, cwd="/tmp")
# ← 在 /tmp 目录执行 ls
# ← 但进程的 cwd 不变（仍然是调用者的 cwd）

# 案例3：相对路径解析
# 假设进程 cwd = /home/user
subprocess.run("ls ../data", shell=True)
# ← 在 /home/user 执行 ls ../data
# ← 实际访问 /home/data

subprocess.run("ls ../data", shell=True, cwd="/tmp")
# ← 在 /tmp 执行 ls ../data
# ← 实际访问 /data（不是 /home/data）

# 案例4：绝对路径不受 cwd 影响
subprocess.run("ls /etc/passwd", shell=True, cwd="/tmp")
# ← 在 /tmp 执行 ls /etc/passwd
# ← 实际访问 /etc/passwd（绝对路径不受 cwd 影响）
```

### 1.4 cwd 参数的实际效果

```
cwd 参数的效果：

┌─────────────────────────────────────────┐
│  Python 进程                             │
│  cwd = /home/user                        │
│                                          │
│  subprocess.run("ls", cwd="/tmp")        │
│  ↓                                       │
│  ┌───────────────────────────────────┐  │
│  │ 子进程                            │  │
│  │ cwd = /tmp ← 子进程的 cwd         │  │
│  │ 执行 ls 命令                      │  │
│  │ ↓                                 │  │
│  │ 返回结果给父进程                  │  │
│  └───────────────────────────────────┘  │
│                                          │
│  Python 进程的 cwd 不变 = /home/user    │
│  ← cwd 只影响子进程，不影响父进程      │
└─────────────────────────────────────────┘
```

### 1.5 Python 的 os.chdir() vs subprocess cwd

```python
# 方式1：os.chdir()（进程级切换）
import os

os.chdir("/tmp")          # ← 进程的 cwd 改为 /tmp
subprocess.run("ls")      # ← 在 /tmp 执行 ls
subprocess.run("pwd")     # ← 输出 /tmp
# ← 进程的 cwd 已经改变

# 方式2：subprocess cwd 参数（临时切换）
import subprocess

subprocess.run("ls", cwd="/tmp")  # ← 在 /tmp 执行 ls
subprocess.run("pwd")             # ← 在当前 cwd 执行 pwd（不是 /tmp）
# ← 进程的 cwd 不变

关键区别：
- os.chdir()：永久改变进程的 cwd（影响后续所有操作）
- subprocess cwd：临时改变子进程的 cwd（不影响父进程）
```

---

## 二、问题2：Worktree 的内容与 Git 分支

### 2.1 Git Worktree 的完整结构

```
Git Worktree 的结构：

主仓库（/project）
├── .git/                      # ← Git 主仓库的元数据
│   ├── HEAD                   # ← 当前分支引用
│   ├── refs/                  # ← 分支和标签引用
│   ├── objects/               # ← 所有对象（共享）
│   ├── worktrees/             # ← worktree 元数据目录
│   │   ├── auth/              # ← auth worktree 的元数据
│   │   │   ├── HEAD           # ← auth worktree 的分支引用
│   │   │   ├── index          # ← auth worktree 的暂存区
│   │   │   └── commondir      # ← 指向主仓库的 .git
│   │   └── ui/                # ← ui worktree 的元数据
│   │   │   ├── HEAD           # ← ui worktree 的分支引用
│   │   │   ├── index          # ← ui worktree 的暂存区
│   │   │   └── commondir      # ← 指向主仓库的 .git
│
├── .worktrees/                # ← worktree 工作目录（物理隔离）
│   ├── auth/                  # ← auth worktree 的工作区
│   │   ├── .git               # ← 文件（不是目录！），内容：gitdir: /project/.git/worktrees/auth
│   │   ├── config.py          # ← auth 分支的文件
│   │   ├── auth.py            # ← auth 分支的文件
│   │   └── (其他项目文件)      # ← auth 分支的完整工作区
│   │
│   └── ui/                    # ← ui worktree 的工作区
│   │   ├── .git               # ← 文件（不是目录！），内容：gitdir: /project/.git/worktrees/ui
│   │   ├── login.vue          # ← ui 分支的文件
│   │   ├── app.js             # ← ui 分支的文件
│   │   └── (其他项目文件)      # ← ui 分支的完整工作区
│
├── config.py                  # ← 主分支的文件
├── main.py                    # ← 主分支的文件
└── (其他项目文件)              # ← 主分支的完整工作区

关键点：
1. .git/worktrees/auth/ 目录：存储 auth worktree 的元数据
2. .worktrees/auth/.git 文件：指向 .git/worktrees/auth/
3. .worktrees/auth/ 目录：auth worktree 的完整工作区（有所有项目文件）
```

### 2.2 Worktree 中有哪些内容？

**答案：有项目的所有文件（完整的工作区）。**

```bash
# 创建 worktree
git worktree add .worktrees/auth -b wt/auth HEAD

# .worktrees/auth 目录的内容：
.worktrees/auth/
├── .git                       # ← 文件，指向 .git/worktrees/auth/
├── config.py                  # ← 项目的所有文件（初始状态）
├── main.py                    # ← 项目的所有文件（初始状态）
├── utils/
│   └── helper.py              # ← 项目的所有文件（初始状态）
└── (项目所有其他文件)          # ← 完整的工作区复制

# 但是：
.worktrees/auth/ 没有 .git 目录！
只有 .git 文件（指向主仓库的 .git/worktrees/auth/）
```

**为什么会有所有文件？**

```
Git Worktree 机制：

1. 创建 worktree 时：
   git worktree add .worktrees/auth -b wt/auth HEAD
   ↓ 基于 HEAD 创建新分支 wt/auth
   ↓ 在 .worktrees/auth 创建完整工作区（包含 HEAD 的所有文件）
   ↓ 创建 .git/worktrees/auth/ 元数据目录
   ↓ 创建 .worktrees/auth/.git 文件（指向元数据目录）

2. Worktree 的文件来源：
   - 初始：从 HEAD（或指定提交）检出所有文件
   - 之后：在 worktree 中修改文件，不影响其他 worktree

3. 共享部分：
   - .git/objects/：所有 worktree 共享（节省空间）
   - .git/refs/：所有 worktree 共享（但分支独立）

4. 独立部分：
   - .git/worktrees/auth/HEAD：auth worktree 的分支引用
   - .git/worktrees/auth/index：auth worktree 的暂存区
   - .worktrees/auth/ 目录：auth worktree 的工作区
```

### 2.3 Worktree 自动切换 Git 分支吗？

**答案：是的，每个 worktree 有独立的分支。**

```bash
# 主仓库
cd /project
git branch          # ← 当前分支：main
git status          # ← On branch main

# Auth worktree
cd .worktrees/auth
git branch          # ← 当前分支：wt/auth（自动切换！）
git status          # ← On branch wt/auth

# UI worktree
cd .worktrees/ui
git branch          # ← 当前分支：wt/ui（自动切换！）
git status          # ← On branch wt/ui

关键：
- 每个 worktree 有独立的 HEAD 引用
- 进入 worktree 目录 → 自动在该分支下工作
- 不同 worktree 的分支完全独立
```

### 2.4 项目根目录切换分支会影响 worktree 吗？

**答案：不会！完全独立。**

```bash
# 主仓库切换分支
cd /project
git checkout develop
git branch          # ← 当前分支：develop

# Auth worktree 不受影响
cd .worktrees/auth
git branch          # ← 当前分支：wt/auth（不变）
git status          # ← On branch wt/auth（不变）

# UI worktree 不受影响
cd .worktrees/ui
git branch          # ← 当前分支：wt/ui（不变）
git status          # ← On branch wt/ui（不变）

为什么不会影响？
- 每个 worktree 有独立的 HEAD 文件
- 主仓库的 HEAD：.git/HEAD
- Auth worktree 的 HEAD：.git/worktrees/auth/HEAD
- 完全独立，互不影响！
```

### 2.5 Git 命令在不同目录的执行

```bash
# 在主仓库执行 git 命令
cd /project
git status          # ← 查看主仓库状态
git add config.py   # ← 添加到主仓库暂存区
git commit          # ← 在 main 分支提交

# 在 auth worktree 执行 git 命令
cd .worktrees/auth
git status          # ← 查看 auth worktree 状态
git add auth.py     # ← 添加到 auth worktree 暂存区
git commit          # ← 在 wt/auth 分支提交

# 在 ui worktree 执行 git 命令
cd .worktrees/ui
git status          # ← 查看 ui worktree 状态
git add login.vue   # ← 添加到 ui worktree 暂存区
git commit          # ← 在 wt/ui 分支提交

关键：
- git 命令在哪个目录执行，就影响哪个 worktree
- 各 worktree 完全独立
- 互不影响
```

---

## 三、问题3：CC 的真实实现机制

### 3.1 CC 使用 subprocess，不是线程

**根据搜索结果，CC 的 AgentTool 使用 subprocess（子进程）。**

```
关键证据（来源：Anthropic 文档、GitHub 讨论）：

1. AgentTool spawns subprocesses for isolated execution
   - Source: docs.anthropic.com
   - 每个子 agent 是独立的进程

2. Subprocesses allow for true process isolation
   - Source: github.com/anthropics/claude-code
   - 如果 agent crash，不影响父进程

3. Separate address spaces prevent unintended data leakage
   - Source: Engineering blogs
   - 内存隔离，安全边界

4. OS-level resource limits can be applied per-process
   - Source: Reddit discussions
   - 可以对每个进程设置资源限制
```

### 3.2 CC 为什么选择 subprocess 而不是线程？

```
选择 subprocess 的原因：

┌─────────────────────────────────────────┐
│  安全性                                  │
├─────────────────────────────────────────┤
│ - Separate address space（内存隔离）    │
│ - IPC provides natural security boundary │
│ - 如果子 agent crash，不影响主进程      │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  可控性                                  │
├─────────────────────────────────────────┤
│ - SIGKILL safely terminates（可以强制终止）│
│ - OS-level resource limits（资源限制）  │
│ - Audit trail via IPC（通信可审计）     │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  隔离性                                  │
├─────────────────────────────────────────┤
│ - Agent-to-agent isolation（agent 间隔离）│
│ - No shared-state corruption（无共享状态）│
│ - Fault containment（故障隔离）         │
└─────────────────────────────────────────┘

对比线程：

| 维度 | Subprocess | Thread |
|------|-----------|--------|
| 内存隔离 | ✅ 完全隔离 | ❌ 共享内存 |
| 故障隔离 | ✅ crash 不影响父进程 | ❌ crash 可能影响整个进程 |
| 安全边界 | ✅ IPC 自然边界 | ❌ 无边界 |
| 可终止性 | ✅ SIGKILL 安全终止 | ❌ 难安全终止线程 |
| 资源限制 | ✅ OS 级限制 | ❌ 共享资源池 |
| 启动开销 | ❌ 较高 | ✅ 较低 |
```

### 3.3 CC 如何切换目录？

**答案：process.chdir()（Node.js 的进程级目录切换）。**

```javascript
// EnterWorktreeTool.ts:92-97（真实 CC）

// 创建 worktree
const worktreePath = createWorktree(name, branch);

// 进程级切换目录！
process.chdir(worktreePath);         // ← Node.js API：改变进程 cwd
setCwd(worktreePath);                // ← 更新内部 cwd 状态
setOriginalCwd(originalCwd);         // ← 记录原始 cwd（用于恢复）
saveWorktreeState({                  // ← 保存 worktree 状态
    originalCwd,
    worktreePath,
    worktreeName,
    worktreeBranch,
    sessionId
});

// 效果：
// 1. process.cwd() 返回 worktreePath
// 2. 所有后续文件操作在 worktree 执行
// 3. 所有子进程在 worktree 执行
// 4. 不需要每个工具传 cwd 参数
```

### 3.4 为什么 CC 可以用 process.chdir()？

**答案：因为子 agent 是独立进程，不存在线程安全问题。**

```
CC 的架构：

主进程（Claude Code CLI）
├── cwd = /project
├── process.chdir(/project/.worktrees/auth)  ← 主进程切换
│
├── AgentTool.spawn("alice")
│   ↓ 创建子进程
│   ┌───────────────────────────────────┐
│   │ Alice 子进程                      │
│   │ cwd = /project/.worktrees/auth    │ ← 子进程继承 cwd
│   │ (独立进程，有自己的 cwd)          │
│   └───────────────────────────────────┘
│
├── AgentTool.spawn("bob")
│   ↓ 创建子进程
│   ┌───────────────────────────────────┐
│   │ Bob 子进程                        │
│   │ cwd = /project/.worktrees/ui      │ ← 可以有自己的 cwd
│   │ (独立进程，有自己的 cwd)          │
│   └───────────────────────────────────┘

关键：
- Alice 和 Bob 是独立进程，不是线程
- 每个进程有自己的 cwd
- 不存在线程安全问题
- process.chdir() 只影响当前进程
```

### 3.5 CC 的 AgentTool isolation

```javascript
// AgentTool.tsx:590-641

// isolation: "worktree" 模式
if (opts.isolation === "worktree") {
    // 创建临时 worktree
    const worktreePath = createAgentWorktree();

    // 用 cwdOverridePath 包住子 agent 执行
    const cwdOverridePath = worktreePath;

    // 启动子进程（不是线程！）
    const subAgentProcess = spawnSubprocess({
        cwd: cwdOverridePath,         // ← 子进程的 cwd
        env: process.env,
        isolation: true
    });

    // 子 agent 的所有操作自动在 worktree 执行
    // 子 agent 不需要关心 cwd
}

关键：
- cwdOverridePath：子进程的工作目录
- spawnSubprocess：创建子进程（不是线程）
- 子进程完全隔离
```

---

## 四、教学版 vs 真实 CC 的对比

### 4.1 架构对比

```
教学版（Python 多线程）：

主进程
├── cwd = /project
├── Alice 线程（共享进程 cwd）
│   └──────────────┐
│   wt_ctx = {"path": ".worktrees/auth"}  ← 线程局部变量
│   _run_bash → subprocess.run(cwd=wt_ctx["path"])  ← 传 cwd 参数
│
├── Bob 线程（共享进程 cwd）
│   └──────────────┐
│   wt_ctx = {"path": ".worktrees/ui"}    ← 线程局部变量
│   _run_bash → subprocess.run(cwd=wt_ctx["path"])  ← 传 cwd 参数

问题：
- Alice 和 Bob 共享同一个进程的 cwd
- 不能用 os.chdir()（会影响其他线程）
- 必须用 subprocess.run(cwd=...) 传参数
```

```
真实 CC（Node.js 多进程）：

主进程
├── cwd = /project
├── process.chdir(/project/.worktrees/auth)  ← 主进程切换

Alice 子进程（独立进程）
├── cwd = /project/.worktrees/auth  ← 继承主进程 cwd
├── 所有操作自动在 worktree 执行
├── 不需要传 cwd 参数
├── 可以有自己的 cwd（完全独立）

Bob 子进程（独立进程）
├── cwd = /project/.worktrees/ui  ← 可以有自己的 cwd
├── 所有操作自动在 worktree 执行
├── 不需要传 cwd 参数
├── 完全独立

优势：
- 每个子进程有自己的 cwd
- 不存在线程安全问题
- 可以用 process.chdir()
```

### 4.2 目录切换对比

```
教学版：参数传递（"伪切换"）

wt_ctx = {"path": None}  ← 闭包字典

def _run_bash(command):
    return subprocess.run(command, cwd=wt_ctx["path"])  ← 传参数

特点：
- 进程 cwd 不变
- 只有 subprocess 在指定目录执行
- 需要每个工具都传 cwd 参数
- wt_ctx 是线程局部变量（闭包）
- 多个线程不能用 os.chdir()

真实 CC：进程级切换（"真切换"）

process.chdir(worktreePath)  ← Node.js API

特点：
- 进程 cwd 改变
- 所有操作自动在 worktree 执行
- 不需要传 cwd 参数
- 每个子进程有自己的 cwd
- 可以用 process.chdir()（不存在线程安全问题）
```

### 4.3 为什么教学版不能用 os.chdir()？

```python
# 教学版的线程安全问题

import os
import threading

# Alice 线程
def alice_thread():
    os.chdir("/project/.worktrees/auth")  # ← Alice 切换进程 cwd
    subprocess.run("ls")                   # ← 在 auth 执行（正确）

# Bob 线程
def bob_thread():
    os.chdir("/project/.worktrees/ui")    # ← Bob 切换进程 cwd（覆盖 Alice 的！）
    subprocess.run("ls")                   # ← 在 ui 执行（正确）

# 问题：
# 1. Alice 和 Bob 共享同一个进程的 cwd
# 2. os.chdir() 是进程级操作，影响所有线程
# 3. Bob 的 os.chdir() 会覆盖 Alice 的
# 4. Alice 的后续操作会在 ui 目录执行（错误！）

# 解决方案1：用 subprocess cwd 参数
def alice_thread():
    subprocess.run("ls", cwd="/project/.worktrees/auth")  ← 不改变进程 cwd

def bob_thread():
    subprocess.run("ls", cwd="/project/.worktrees/ui")    ← 不改变进程 cwd

# 解决方案2：用多进程（真实 CC 的方式）
def alice_process():
    os.chdir("/project/.worktrees/auth")  ← 只影响 Alice 进程
    subprocess.run("ls")                   ← 在 auth 执行

def bob_process():
    os.chdir("/project/.worktrees/ui")    ← 只影响 Bob 进程
    subprocess.run("ls")                   ← 在 ui 执行
```

---

## 五、总结

### 问题1的答案：cwd 是什么？

```
cwd = Current Working Directory（当前工作目录）

关键：
- cwd 不是 bash 命令的参数
- cwd 是 subprocess.run 的参数
- cwd 指定子进程在哪个目录执行
- cwd 不改变父进程的 cwd（临时切换）

效果：
subprocess.run("ls", cwd="/tmp")
← 在 /tmp 执行 ls
← 但父进程的 cwd 不变
```

### 问题2的答案：Worktree 的内容与分支

```
Worktree 的内容：
- .worktrees/auth/ 有项目的所有文件（完整工作区）
- 基于 HEAD（或指定提交）检出
- 之后独立修改，不影响其他 worktree

Worktree 的分支：
- 每个 worktree 有独立的分支
- 进入 worktree 目录 → 自动在该分支工作
- 主仓库切换分支不影响 worktree

Git 命令执行：
- git 命令在哪个目录执行，就影响哪个 worktree
- 各 worktree 完全独立
```

### 问题3的答案：CC 的真实实现

```
CC 使用 subprocess（子进程），不是线程：

证据：
- AgentTool spawns subprocesses for isolated execution
- Separate address space（内存隔离）
- SIGKILL safely terminates（可强制终止）

CC 如何切换目录：
- process.chdir()（Node.js API）
- 进程级切换，不是参数传递
- 每个子进程有自己的 cwd

为什么可以用 process.chdir()：
- 子 agent 是独立进程，不是线程
- 不存在线程安全问题
- process.chdir() 只影响当前进程
```

---

## 参考资料

- [Anthropic Documentation - Claude Code Tools](https://docs.anthropic.com)
- [GitHub - Claude Code CLI Source](https://github.com/anthropics/claude-code)
- [Git Worktree 官方文档](https://git-scm.com/docs/git-worktree)
- [Python subprocess.run 文档](https://docs.python.org/3/library/subprocess.html)
- [Node.js process.chdir 文档](https://nodejs.org/api/process.html#process_process_chdir_directory)
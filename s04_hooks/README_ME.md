# s04 Hooks — 深度理解笔记

## 核心问题

s03 的 agent_loop 循环中，权限检查、日志记录等功能是**硬编码**在循环体里的：

```python
# s03 的问题：每次扩展都要修改循环本身
def agent_loop(messages):
    while True:
        for block in response.content:
            log_to_file(block)          # 加一行
            check_permission(block)     # 加一行
            notify_slack(block)         # 又加一行
            output = execute(block)
            auto_git_add(block)         # 再加一行
            # ... 循环越来越臃肿，难以维护
```

**问题本质：**
- 你想扩展的是 **Agent 的行为**
- 但你改的却是 **循环本身**
- 循环应该是稳定的核心，不应该每次扩展都修改

---

## 一、设计模式详解

### 1.1 这是什么设计模式？

**s04_hooks 使用了多种设计模式的组合：**

| 设计模式 | 在 s04 中的应用 |
|---------|----------------|
| **观察者模式 (Observer Pattern)** | HOOKS 注册表，事件触发时通知所有订阅的回调函数 |
| **插件架构 (Plugin Architecture)** | 通过 `register_hook()` 动态添加功能，核心循环不感知具体逻辑 |
| **事件驱动架构 (Event-Driven Architecture)** | 4 个事件点覆盖整个 agent cycle |
| **开闭原则 (OCP)** | 循环对扩展开放，对修改关闭 |
| **依赖倒置原则 (DIP)** | 循环依赖抽象的 hooks 接口，不依赖具体的实现 |

**核心是"钩子模式"——一种特殊的观察者模式**

```
传统观察者模式：
    Subject → 通知所有 Observer
    
钩子模式：
    Core Loop → trigger_hooks(event) → 执行所有注册的 Hook 回调
```

### 1.2 观察者模式详解

**定义：定义对象间的一种一对多的依赖关系，当一个对象的状态发生改变时，所有依赖于它的对象都得到通知并被自动更新。**

```
┌─────────────────────────────────────────────────────────────┐
│ 观察者模式在 Hook 系统的应用                                  │
│                                                              │
│ Subject（被观察者）：                                         │
│     agent_loop                                               │
│     ├─ 状态变化：用户输入、工具执行、循环退出                 │
│     └─ 触发事件：UserPromptSubmit, PreToolUse, ...           │
│                                                              │
│ Observer（观察者）：                                          │
│     Hook 回调函数                                            │
│     ├─ context_inject_hook                                   │
│     ├─ permission_hook                                       │
│     ├─ log_hook                                              │
│     ├─ large_output_hook                                     │
│     └─ summary_hook                                          │
│                                                              │
│ 注册机制：                                                   │
│     register_hook(event, callback)                           │
│     ├─ 将 Observer 注册到 Subject                            │
│     └─ HOOKS[event].append(callback)                         │
│                                                              │
│ 通知机制：                                                   │
│     trigger_hooks(event, *args)                              │
│     ├─ Subject 状态变化时通知所有 Observer                   │
│     └─ for callback in HOOKS[event]: callback(*args)         │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 插件架构详解

**定义：核心系统提供扩展点，插件通过标准接口接入，实现功能扩展而不修改核心。**

```
┌─────────────────────────────────────────────────────────────┐
│ 插件架构在 Hook 系统的应用                                    │
│                                                              │
│ Core System（核心系统）：                                     │
│     agent_loop                                               │
│     ├─ 核心流程：LLM 调用、工具执行                           │
│     ├─ 扩展点：4 个 trigger_hooks() 调用点                   │
│     ├─ 标准接口：callback(*args) -> result | None            │
│     └─ 不感知具体插件实现                                    │
│                                                              │
│ Plugin Interface（插件接口）：                                │
│     def callback(*args) -> result | None:                    │
│         ├─ 参数：event 相关的数据                            │
│         ├─ 返回 None：继续执行                               │
│         ├─ 返回 非 None：阻止/修改执行                       │
│         └─ 标准接口，所有插件必须遵循                        │
│                                                              │
│ Plugins（具体插件）：                                         │
│     ├─ permission_hook：权限检查插件                         │
│     ├─ log_hook：日志记录插件                                │
│     ├─ large_output_hook：大输出警告插件                     │
│     ├─ context_inject_hook：上下文注入插件                   │
│     ├─ summary_hook：收尾统计插件                            │
│     └─ 可以无限扩展...                                       │
│                                                              │
│ Plugin Manager（插件管理器）：                                │
│     HOOKS 注册表                                              │
│     ├─ register_hook()：注册插件                             │
│     ├─ trigger_hooks()：执行插件                             │
│     ├─ 插件生命周期管理                                      │
│     └─ 插件组合、替换、删除                                  │
└─────────────────────────────────────────────────────────────┘
```

### 1.4 为什么这么设计？

#### 设计目标

| 目标 | 说明 |
|------|------|
| **解耦** | 核心循环不感知具体扩展逻辑 |
| **稳定** | 循环代码不变，扩展逻辑在外部 |
| **可扩展** | 加功能只需 `register_hook()`，不用改循环 |
| **可组合** | 多个 hook 可以组合，互不影响 |
| **可配置** | hook 可以动态注册/注销 |

#### 对比：s03 vs s04

```
┌─────────────────────────────────────────────────────────────┐
│ s03：紧耦合                                                  │
│                                                              │
│ agent_loop                                                   │
│     ├─ check_permission(block)  ← 硬编码在循环里             │
│     ├─ execute(block)                                         │
│     └─ ... 其他逻辑                                           │
│                                                              │
│ 问题：                                                       │
│     ├─ 加一个功能 → 改循环代码                                │
│     ├─ 删一个功能 → 改循环代码                                │
│     ├─ 改一个功能 → 改循环代码                                │
│     └─ 循环越来越复杂，难以维护                               │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ s04：松耦合                                                  │
│                                                              │
│ agent_loop                                                   │
│     ├─ trigger_hooks("PreToolUse", block)   ← 只调用抽象接口 │
│     ├─ execute(block)                                         │
│     ├─ trigger_hooks("PostToolUse", block, output)           │
│     └─ ... 循环代码不变                                      │
│                                                              │
│ HOOKS 注册表                                                  │
│     ├─ "PreToolUse": [permission_hook, log_hook]             │
│     ├─ "PostToolUse": [large_output_hook]                    │
│     └─ ... 扩展逻辑在这里                                    │
│                                                              │
│ 好处：                                                       │
│     ├─ 加功能 → register_hook()                              │
│     ├─ 删功能 → 从 HOOKS 移除                                 │
│     ├─ 改功能 → 改 hook 回调                                  │
│     └─ 循环代码始终不变                                      │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、设计原则详解

### 2.1 开闭原则

**定义：软件实体应该对扩展开放，对修改关闭。**

```
┌─────────────────────────────────────────────────────────────┐
│ 开闭原则在 s04 的应用                                         │
│                                                              │
│ 对扩展开放：                                                  │
│     ├─ 可以添加新的 hook（register_hook）                    │
│     ├─ 可以修改 hook 的行为                                   │
│     ├─ 可以组合多个 hook                                      │
│     ├─ hook 可以返回不同结果控制流程                          │
│     └─ 扩展点明确（4 个事件点）                               │
│                                                              │
│ 对修改关闭：                                                  │
│     ├─ agent_loop 代码不变                                   │
│     ├─ 核心逻辑（LLM 调用、工具执行）不变                     │
│     ├─ 循环结构不变                                          │
│     ├─ trigger_hooks() 调用点不变                            │
│     └─ HOOKS 注册表结构不变                                  │
│                                                              │
│ 实现方式：                                                   │
│     ├─ 抽象接口：trigger_hooks(event, *args)                 │
│     ├─ 具体实现：各种 hook 回调                               │
│     └─ 通过接口解耦，扩展不修改核心                           │
└─────────────────────────────────────────────────────────────┘
```

**具体体现：**

```python
# s04：扩展开放，修改关闭

# 加一个新功能：只需注册新 hook，不改循环
register_hook("PreToolUse", my_new_hook)  # ← 扩展

# agent_loop 代码：始终不变
def agent_loop(messages):
    while True:
        blocked = trigger_hooks("PreToolUse", block)  # ← 只调用抽象接口
        if blocked:
            results.append(...)
            continue
        output = TOOL_HANDLERS[block.name](**block.input)
        trigger_hooks("PostToolUse", block, output)  # ← 只调用抽象接口
        results.append(...)
```

### 2.2 依赖倒置原则 (DIP)

**定义：高层模块不应该依赖低层模块，两者都应该依赖抽象。抽象不应该依赖细节，细节应该依赖抽象。**

```
┌─────────────────────────────────────────────────────────────┐
│ DIP 在 s04 的应用                                            │
│                                                              │
│ 高层模块：agent_loop                                          │
│     ├─ 负责核心流程                                          │
│     ├─ 不感知具体扩展逻辑                                     │
│     ├─ 不依赖 permission_hook、log_hook 等                   │
│     └─ 依赖抽象接口：trigger_hooks(event, *args)            │
│                                                              │
│ 低层模块：permission_hook, log_hook 等                        │
│     ├─ 负责具体扩展逻辑                                       │
│     ├─ 不感知核心流程                                         │
│     ├─ 不依赖 agent_loop                                     │
│     └─ 实现抽象接口：callback(*args) -> result               │
│                                                              │
│ 抽象接口：                                                    │
│     ├─ register_hook(event, callback)                        │
│     ├─ trigger_hooks(event, *args)                           │
│     ├─ callback(*args) -> result | None                      │
│     └─ 定义规范，高层和低层都遵循                             │
│                                                              │
│ 依赖关系：                                                   │
│     ├─ agent_loop → 抽象接口                                 │
│     ├─ permission_hook → 抽象接口                            │
│     ├─ log_hook → 抽象接口                                   │
│     └─ 通过抽象接口解耦                                      │
└─────────────────────────────────────────────────────────────┘
```

**对比 s03 的违反 DIP：**

```python
# s03：违反 DIP（高层依赖低层）
def agent_loop(messages):
    for block in response.content:
        # 高层模块（agent_loop）直接依赖低层模块（check_permission）
        check_permission(block)  # ← 直接依赖具体实现
        output = execute(block)

# s04：遵循 DIP（高层依赖抽象）
def agent_loop(messages):
    for block in response.content:
        # 高层模块依赖抽象接口（trigger_hooks）
        blocked = trigger_hooks("PreToolUse", block)  # ← 依赖抽象
        if blocked:
            results.append(...)
            continue
        output = TOOL_HANDLERS[block.name](**block.input)
```

### 2.3 单一职责原则 (SRP)

**定义：一个类应该只有一个引起它变化的原因。**

```
┌─────────────────────────────────────────────────────────────┐
│ SRP 在 s04 的应用                                            │
│                                                              │
│ agent_loop：                                                  │
│     ├─ 职责：执行 agent 核心循环                              │
│     ├─ 变化原因：核心流程调整（很少变化）                     │
│     ├─ 不负责：权限检查、日志、通知等                         │
│     └─ 代码稳定                                              │
│                                                              │
│ permission_hook：                                             │
│     ├─ 职责：权限检查                                         │
│     ├─ 变化原因：权限规则调整                                 │
│     ├─ 不负责：其他逻辑                                       │
│     └─ 可以独立修改                                          │
│                                                              │
│ log_hook：                                                    │
│     ├─ 职责：日志记录                                         │
│     ├─ 变化原因：日志格式调整                                 │
│     ├─ 不负责：其他逻辑                                       │
│     └─ 可以独立修改                                          │
│                                                              │
│ large_output_hook：                                           │
│     ├─ 职责：大输出警告                                       │
│     ├─ 变化原因：警告阈值调整                                 │
│     ├─ 不负责：其他逻辑                                       │
│     └─ 可以独立修改                                          │
│                                                              │
│ context_inject_hook：                                         │
│     ├─ 职责：上下文注入                                       │
│     ├─ 变化原因：注入内容调整                                 │
│     ├─ 不负责：其他逻辑                                       │
│     └─ 可以独立修改                                          │
│                                                              │
│ summary_hook：                                                │
│     ├─ 职责：收尾统计                                         │
│     ├─ 变化原因：统计内容调整                                 │
│     ├─ 不负责：其他逻辑                                       │
│     └─ 可以独立修改                                          │
│                                                              │
│ 每个模块只有一个变化原因 → 易维护                            │
└─────────────────────────────────────────────────────────────┘
```

**对比 s03 的违反 SRP：**

```python
# s03：违反 SRP（agent_loop 有多个变化原因）
def agent_loop(messages):
    for block in response.content:
        log_to_file(block)          # ← 变化原因 1：日志格式
        check_permission(block)     # ← 变化原因 2：权限规则
        notify_slack(block)         # ← 变化原因 3：通知方式
        output = execute(block)
        auto_git_add(block)         # ← 变化原因 4：Git 操作
        # agent_loop 有多个变化原因 → 难维护

# s04：遵循 SRP（每个 hook 只有一个变化原因）
def agent_loop(messages):
    for block in response.content:
        blocked = trigger_hooks("PreToolUse", block)  # 只负责触发
        output = TOOL_HANDLERS[block.name](**block.input)
        trigger_hooks("PostToolUse", block, output)   # 只负责触发
        # agent_loop 只有一个变化原因：核心流程调整

def permission_hook(block):  # 只负责权限检查
    # ...只有一个变化原因：权限规则调整

def log_hook(block):  # 只负责日志记录
    # ...只有一个变化原因：日志格式调整
```

---

## 三、s04 教学版实现详解

### 3.1 核心：HOOKS 注册表

```python
# Hook 注册表：事件名 → 回调列表
HOOKS = {
    "UserPromptSubmit": [],  # 用户输入提交后、进入 LLM 前
    "PreToolUse": [],        # 工具执行前
    "PostToolUse": [],       # 工具执行后
    "Stop": [],              # 循环即将退出时
}

# 注册 hook
def register_hook(event: str, callback):
    HOOKS[event].append(callback)

# 触发 hook
def trigger_hooks(event: str, *args):
    for callback in HOOKS[event]:
        result = callback(*args)
        if result is not None:  # 非 None = 阻止/续跑
            return result
    return None  # None = 继续
```

### 3.2 四个事件点：覆盖完整 agent cycle

```
┌─────────────────────────────────────────────────────────────┐
│ Agent Cycle 与 Hook 事件点                                   │
│                                                              │
│ 1. UserPromptSubmit                                          │
│    ├─ 触发时机：用户输入提交后、进入 LLM 前                   │
│    ├─ 典型用途：输入验证、注入上下文                          │
│    ├─ 返回 None：继续                                        │
│    └─ 示例：context_inject_hook                              │
│                                                              │
│         ↓                                                    │
│                                                              │
│ 2. LLM 调用（核心流程，不是 hook）                            │
│                                                              │
│         ↓                                                    │
│                                                              │
│ 3. PreToolUse                                                │
│    ├─ 触发时机：工具执行前                                    │
│    ├─ 典型用途：权限检查、日志记录                            │
│    ├─ 返回 None：继续执行                                    │
│    ├─ 返回 非 None：阻止执行，返回值作为 tool_result          │
│    └─ 示例：permission_hook, log_hook                        │
│                                                              │
│         ↓                                                    │
│                                                              │
│ 4. 工具执行（核心流程，不是 hook）                            │
│                                                              │
│         ↓                                                    │
│                                                              │
│ 5. PostToolUse                                               │
│    ├─ 触发时机：工具执行后                                    │
│    ├─ 典型用途：副作用（自动 git add）、输出检查               │
│    ├─ 返回值：教学版不使用                                    │
│    └─ 示例：large_output_hook                                │
│                                                              │
│         ↓                                                    │
│                                                              │
│ 6. Stop                                                      │
│    ├─ 触发时机：循环即将退出时（stop_reason != "tool_use"）   │
│    ├─ 典型用途：收尾清理                                      │
│    ├─ 返回 None：正常退出                                    │
│    ├─ 返回 非 None：强制续跑，返回值作为 user 消息            │
│    └─ 示例：summary_hook                                     │
└─────────────────────────────────────────────────────────────┘
```

### 3.3 四个事件点的详细说明

#### UserPromptSubmit

```python
def context_inject_hook(query: str) -> str | None:
    """Inject current working directory info into every prompt."""
    print(f"\033[90m[HOOK] UserPromptSubmit: working in {WORKDIR}\033[0m")
    return None   # return None = no modification, let prompt through

register_hook("UserPromptSubmit", context_inject_hook)

# 在主循环中触发
query = input("s04 >> ")
trigger_hooks("UserPromptSubmit", query)   # ← 进入 LLM 之前
history.append({"role": "user", "content": query})
agent_loop(history)
```

**用途：**
- 输入验证
- 注入上下文（当前目录、环境变量等）
- 修改用户输入
- 拦截危险输入

#### PreToolUse

```python
# PreToolUse: 权限检查（s03 的逻辑，从循环移到 hook）
def permission_hook(block):
    if block.name == "bash":
        for pattern in DENY_LIST:
            if pattern in block.input.get("command", ""):
                return "Permission denied by deny list"
    if block.name in ("write_file", "edit_file"):
        path = block.input.get("path", "")
        if not (WORKDIR / path).resolve().is_relative_to(WORKDIR):
            choice = input("   Allow? [y/N] ").strip().lower()
            if choice not in ("y", "yes"):
                return "Permission denied by user"
    return None

# PreToolUse: 日志
def log_hook(block):
    args_preview = str(list(block.input.values())[:2])[:60]
    print(f"\033[90m[HOOK] {block.name}({args_preview})\033[0m")
    return None

register_hook("PreToolUse", permission_hook)
register_hook("PreToolUse", log_hook)
```

**用途：**
- 权限检查（阻止危险操作）
- 日志记录
- 输入验证
- 修改工具输入

#### PostToolUse

```python
# PostToolUse: 大文件提醒
def large_output_hook(block, output):
    if len(str(output)) > 100000:
        print(f"\033[33m[HOOK] ⚠ Large output from {block.name}: {len(str(output))} chars\033[0m")
    return None

register_hook("PostToolUse", large_output_hook)
```

**用途：**
- 副作用处理（自动 git add）
- 输出检查（大输出警告）
- 结果转换
- 通知发送

#### Stop

```python
# Stop hook: 打印收尾统计
def summary_hook(messages: list) -> str | None:
    """Print a summary when the loop is about to stop."""
    tool_count = sum(1 for m in messages
                     for b in (m.get("content") if isinstance(m.get("content"), list) else [])
                     if isinstance(b, dict) and b.get("type") == "tool_result")
    print(f"\033[90m[HOOK] Stop: session used {tool_count} tool calls\033[0m")
    return None   # return None = allow stop, return string = force continuation

register_hook("Stop", summary_hook)

# 在 agent_loop 中触发
if response.stop_reason != "tool_use":
    force = trigger_hooks("Stop", messages)   # ← 退出之前
    if force:
        # hook returned a message → inject it and continue
        messages.append({"role": "user", "content": force})
        continue
    return
```

**用途：**
- 收尾清理
- 统计汇总
- 强制续跑（返回非 None）
- 停机通知

### 3.4 完整流程图

```
用户输入 query
    ↓
┌─────────────────────────────────────────────────────────────┐
│ trigger_hooks("UserPromptSubmit", query)                     │
│     ├─ context_inject_hook(query) → None                     │
│     └─ 继续                                                  │
└─────────────────────────────────────────────────────────────┘
    ↓
messages.append({"role": "user", "content": query})
    ↓
┌─────────────────────────────────────────────────────────────┐
│ agent_loop                                                   │
│                                                              │
│ while True:                                                  │
│     response = client.messages.create(...)                   │
│     messages.append({"role": "assistant", "content": ...})   │
│                                                              │
│     if response.stop_reason != "tool_use":                   │
│         ┌─────────────────────────────────────────────────┐ │
│         │ trigger_hooks("Stop", messages)                  │ │
│         │     ├─ summary_hook(messages) → None             │ │
│         │     └─ 正常退出                                  │ │
│         │   或                                              │ │
│         │     ├─ hook 返回 非 None                         │ │
│         │     ├─ messages.append(user, result)             │ │
│         │     └─ continue（强制续跑）                       │ │
│         └─────────────────────────────────────────────────┘ │
│         return                                               │
│                                                              │
│     for block in response.content:                           │
│         if block.type != "tool_use":                         │
│             continue                                         │
│                                                              │
│         ┌─────────────────────────────────────────────────┐ │
│         │ trigger_hooks("PreToolUse", block)               │ │
│         │     ├─ permission_hook(block)                    │ │
│         │     │   ├─ 检查 deny list                        │ │
│         │     │   ├─ 检查 destructive                      │ │
│         │     │   ├─ 返回 None → 继续                      │ │
│         │     │   └─ 返回 非 None → 阻止                   │ │
│         │     ├─ log_hook(block) → None                    │ │
│         │     ├─ 返回 None → 执行工具                      │ │
│         │     └─ 返回 非 None → 跳过执行                   │ │
│         └─────────────────────────────────────────────────┘ │
│                                                              │
│         if blocked:                                          │
│             results.append(tool_result, content=blocked)     │
│             continue                                         │
│                                                              │
│         output = TOOL_HANDLERS[block.name](**block.input)    │
│                                                              │
│         ┌─────────────────────────────────────────────────┐ │
│         │ trigger_hooks("PostToolUse", block, output)      │ │
│         │     ├─ large_output_hook(block, output)          │ │
│         │     └─ None（不影响流程）                        │ │
│         └─────────────────────────────────────────────────┘ │
│                                                              │
│         results.append(tool_result, content=output)          │
│                                                              │
│     messages.append({"role": "user", "content": results})    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 3.5 循环代码对比：s03 vs s04

```python
# s03：硬编码权限检查
def agent_loop(messages):
    for block in response.content:
        if block.type != "tool_use":
            continue

        # s03: 硬编码权限检查
        if not check_permission(block):  # ← 硬编码在循环里
            results.append(tool_result, content="Permission denied")
            continue

        output = TOOL_HANDLERS[block.name](**block.input)
        results.append(tool_result, content=output)

# s04：hook 替代硬编码
def agent_loop(messages):
    for block in response.content:
        if block.type != "tool_use":
            continue

        # s04: hook 替代硬编码
        blocked = trigger_hooks("PreToolUse", block)  # ← 调用抽象接口
        if blocked:
            results.append(tool_result, content=blocked)
            continue

        output = TOOL_HANDLERS[block.name](**block.input)

        trigger_hooks("PostToolUse", block, output)  # ← 调用抽象接口

        results.append(tool_result, content=output)
```

---

## 四、Claude Code 实现详解（整体梳理）

### 4.1 CC 的 Hook 系统架构

**CC 不是简单的 4 个事件，而是完整的 Hook 系统：**

```
┌─────────────────────────────────────────────────────────────┐
│ Claude Code Hook 系统架构                                    │
│                                                              │
│ 事件层（coreTypes.ts）：27 个 Hook 事件                       │
│     ├─ 工具相关：PreToolUse, PostToolUse, PostToolUseFailure │
│     ├─ 会话相关：SessionStart, SessionEnd, Stop, StopFailure │
│     ├─ 用户交互：UserPromptSubmit, Notification, ...        │
│     ├─ 子 Agent：SubagentStart, SubagentStop                │
│     ├─ 压缩相关：PreCompact, PostCompact                    │
│     ├─ 团队相关：TeammateIdle, TaskCreated, TaskCompleted   │
│     └─ 其他：Elicitation, ConfigChange, WorktreeCreate, ... │
│                                                              │
│ 执行层（toolHooks.ts）：Hook 执行引擎                         │
│     ├─ 执行注册的 hook 回调                                  │
│     ├─ 处理 hook 返回值（HookResult）                        │
│     ├─ 权限不变式检查                                        │
│     ├─ 阻塞错误注入                                          │
│     └─ 防无限循环机制                                        │
│                                                              │
│ 结果层（HookResult）：处理 hook 返回                          │
│     ├─ 注入消息到对话                                        │
│     ├─ 阻止工具执行                                          │
│     ├─ 强制续跑                                              │
│     ├─ 优雅停机                                              │
│     └─ 修改工具输入                                          │
│                                                              │
│ 配置层（settings.json）：hook 配置                            │
│     ├─ hook 脚本路径                                         │
│     ├─ deny/ask 规则                                         │
│     └─ 权限配置                                              │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 27 个 Hook 事件分类

```python
# CC 的完整 Hook 事件列表

HOOK_EVENTS = {
    # 工具相关（3 个）
    "PreToolUse": [],           # 工具执行前
    "PostToolUse": [],          # 工具执行后
    "PostToolUseFailure": [],   # 工具执行失败后
    
    # 会话相关（4 个）
    "SessionStart": [],         # 会话开始
    "SessionEnd": [],           # 会话结束
    "Stop": [],                 # 循环即将退出
    "StopFailure": [],          # 循环退出失败
    "Setup": [],                # 初始化
    
    # 用户交互（4 个）
    "UserPromptSubmit": [],     # 用户输入提交
    "Notification": [],         # 通知事件
    "PermissionRequest": [],    # 权限请求
    "PermissionDenied": [],     # 权限被拒绝
    
    # 子 Agent（2 个）
    "SubagentStart": [],        # 子 Agent 启动
    "SubagentStop": [],         # 子 Agent 停止
    
    # 压缩相关（2 个）
    "PreCompact": [],           # 压缩前
    "PostCompact": [],          # 压缩后
    
    # 团队相关（3 个）
    "TeammateIdle": [],         # 队友空闲
    "TaskCreated": [],          # 任务创建
    "TaskCompleted": [],        # 任务完成
    
    # 其他（11 个）
    "Elicitation": [],          # 引导事件
    "ElicitationResult": [],    # 引导结果
    "ConfigChange": [],         # 配置变更
    "WorktreeCreate": [],       # Worktree 创建
    "WorktreeRemove": [],       # Worktree 删除
    "InstructionsLoaded": [],   # 指令加载
    "CwdChanged": [],           # 工作目录变更
    "FileChanged": [],          # 文件变更
    # ...
}
```

### 4.3 HookResult 结构

**CC 的 HookResult 有 14 个字段（types/hooks.ts:260-275）：**

```typescript
interface HookResult {
  // 基础字段
  message?: Message;           // UI 消息
  
  // 阻塞控制
  blockingError?: HookBlockingError;  // 阻塞错误 → 注入对话让模型自纠
  preventContinuation?: boolean;      // 阻止后续执行
  
  // 执行结果
  outcome?: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled';
  stopReason?: string;                // 停止原因描述
  
  // 权限控制
  permissionBehavior?: 'allow' | 'deny' | 'ask' | 'passthrough';
  
  // 输入修改
  updatedInput?: Record<string, unknown>;  // 修改工具输入
  
  // 上下文注入
  additionalContext?: string;              // 附加上下文
  
  // MCP 相关
  updatedMCPToolOutput?: unknown;          # MCP 工具输出修改
  
  // 其他...
}
```

### 4.4 关键机制详解

#### 机制 1：权限不变式

**这是 CC 权限系统最重要的安全设计！（toolHooks.ts:325-331）**

```
┌─────────────────────────────────────────────────────────────┐
│ 权限不变式：Hook 'allow' 不能绕过 deny/ask 规则              │
│                                                              │
│ 执行流程：                                                   │
│                                                              │
│ PreToolUse hook 返回 allow                                   │
│         ↓                                                    │
│ 检查 settings.json 的 deny 规则                              │
│     ├─ 如果在 deny 列表中 → 阻止                             │
│     └─ 如果不在 → 继续                                       │
│         ↓                                                    │
│ 检查 settings.json 的 ask 规则                               │
│     ├─ 如果在 ask 列表中 → 询问用户                          │
│     └─ 如果不在 → 继续                                       │
│         ↓                                                    │
│ 最终执行工具                                                 │
│                                                              │
│ 安全保证：                                                   │
│     ├─ hook 脚本不能绕过用户配置                             │
│     ├─ settings.json 是最高权限层                            │
│     └─ 防止恶意 hook 脚本                                    │
│                                                              │
│ 源码位置：toolHooks.ts:325-331                               │
└─────────────────────────────────────────────────────────────┘
```

**源码逻辑：**

```typescript
// 关键代码逻辑（toolHooks.ts:325-331）
if (hookResult.permissionBehavior === 'allow') {
  // 即使 hook 说 allow，也要检查 deny/ask 规则！
  if (isDeniedBySettings(toolName, input)) {
    return 'deny';  // settings.json deny 规则优先
  }
  if (shouldAskBySettings(toolName, input)) {
    return 'ask';   // settings.json ask 规则优先
  }
}
return hookResult.permissionBehavior;
```

#### 机制 2：stopHookActive 防无限循环

**防止 Stop hook 导致的无限循环（query.ts:212,1300）**

```
┌─────────────────────────────────────────────────────────────┐
│ stopHookActive 机制                                          │
│                                                              │
│ 问题场景：                                                   │
│     Stop hook 返回 blockingError                             │
│         ↓                                                    │
│     注入错误消息，模型自纠                                    │
│         ↓                                                    │
│     Stop hook 再次触发，又返回 blockingError                  │
│         ↓                                                    │
│     无限循环...                                              │
│                                                              │
│ 解决方案：stopHookActive 标志                                │
│                                                              │
│ 第 1 轮：                                                     │
│     Stop hook 返回 blockingError                             │
│     设置 stopHookActive = true                               │
│     重入循环                                                  │
│                                                              │
│ 第 2 轮：                                                     │
│     Stop hook 看到 stopHookActive = true                     │
│     不再触发，直接退出                                        │
│     避免 infinite loop                                       │
│                                                              │
│ 源码位置：query.ts:212,1300                                  │
└─────────────────────────────────────────────────────────────┘
```

**源码逻辑：**

```typescript
// query.ts:212
let stopHookActive = false;

// query.ts:1300
if (!stopHookActive && response.stop_reason !== "tool_use") {
  const stopHookResult = triggerStopHooks(messages);
  if (stopHookResult?.blockingError) {
    stopHookActive = true;  // 设置标志
    messages.push(stopHookResult.blockingError);
    continue;  // 重入循环
  }
}
```

#### 机制 3：hook_stopped_continuation 优雅停机

**PostToolUse hook 可以优雅地让 Agent 停机**

```
┌─────────────────────────────────────────────────────────────┐
│ hook_stopped_continuation 机制                               │
│                                                              │
│ PostToolUse hook 返回：                                       │
│     preventContinuation: true                                │
│                                                              │
│ 产生附件（toolHooks.ts:117-130）：                            │
│     hook_stopped_continuation                                │
│                                                              │
│ query.ts 检测（query.ts:1388-1393）：                         │
│     shouldPreventContinuation = true                         │
│                                                              │
│ 循环退出：                                                   │
│     不是崩溃，是优雅完成                                     │
│                                                              │
│ 典型用途：                                                   │
│     ├─ hook 发现任务已完成                                   │
│     ├─ hook 发现需要人工介入                                 │
│     └─ hook 发现安全问题                                     │
│                                                              │
│ 源码位置：                                                    │
│     toolHooks.ts:117-130（产生附件）                         │
│     query.ts:1388-1393（检测并退出）                         │
└─────────────────────────────────────────────────────────────┘
```

**源码逻辑：**

```typescript
// toolHooks.ts:117-130
if (hookResult.preventContinuation) {
  // 产生附件
  attachments.push({
    type: "hook_stopped_continuation",
    reason: hookResult.stopReason
  });
}

// query.ts:1388-1393
if (attachments.some(a => a.type === "hook_stopped_continuation")) {
  shouldPreventContinuation = true;
  // 优雅退出循环
}
```

#### 机制 4：阻塞错误注入

**Hook 可以返回错误，让模型自纠**

```
┌─────────────────────────────────────────────────────────────┐
│ 阻塞错误注入机制                                             │
│                                                              │
│ PreToolUse hook 返回：                                       │
│     blockingError: {                                         │
│         message: "Error: Dangerous command blocked"          │
│     }                                                        │
│                                                              │
│ 处理：                                                       │
│     不执行工具                                               │
│     注入错误消息到对话：                                      │
│         {"role": "user", "content": "Error: ..."}            │
│                                                              │
│ 模型看到错误：                                               │
│     可以自纠（换一个命令）                                   │
│     可以解释为什么                                           │
│     可以询问用户                                             │
│                                                              │
│ 优点：                                                       │
│     ├─ 不是硬性阻止，给模型机会                              │
│     ├─ 模型可以学习规则                                      │
│     └─ 用户可以看到模型的反应                                │
└─────────────────────────────────────────────────────────────┘
```

**示例：**

```typescript
// hook 返回阻塞错误
const hookResult = {
  blockingError: {
    message: "Error: The command 'rm -rf /' is blocked by safety rules."
  }
};

// 注入到对话
messages.push({
  role: "user",
  content: hookResult.blockingError.message
});

// 模型看到错误，可以自纠
// 例如："I see that command is blocked. Let me try a safer approach..."
```

### 4.5 CC 的完整 Hook 执行流程

```
┌─────────────────────────────────────────────────────────────┐
│ Claude Code Hook 执行完整流程                                │
│                                                              │
│ 1. 用户输入                                                  │
│         ↓                                                    │
│ 2. trigger_hooks("UserPromptSubmit", query)                  │
│     ├─ 执行所有注册的 hook                                   │
│     ├─ hook 可以修改 query                                   │
│     ├─ hook 可以注入上下文                                   │
│     └─ hook 可以阻止提交                                     │
│         ↓                                                    │
│ 3. LLM 调用                                                  │
│         ↓                                                    │
│ 4. for each tool_use block:                                  │
│         ↓                                                    │
│ 5. trigger_hooks("PreToolUse", block)                        │
│     ├─ 执行所有注册的 hook                                   │
│     ├─ 收集 HookResult                                       │
│     ├─ 权限不变式检查                                        │
│     │   ├─ hook 说 allow → 检查 settings deny/ask           │
│     │   └─ settings 优先                                     │
│     ├─ 处理 blockingError                                    │
│     │   ├─ 注入错误到对话                                    │
│     │   └─ 让模型自纠                                        │
│     ├─ 处理 updatedInput                                     │
│     │   └─ 修改工具输入                                      │
│     └─ 处理 permissionBehavior                               │
│         ├─ allow → 执行工具                                  │
│         ├─ deny → 阻止执行                                   │
│         ├─ ask → 询问用户                                    │
│         └─ passthrough → 继续                                │
│         ↓                                                    │
│ 6. if allowed: 执行工具                                      │
│         ↓                                                    │
│ 7. trigger_hooks("PostToolUse", block, output)               │
│     ├─ 执行所有注册的 hook                                   │
│     ├─ 收集 HookResult                                       │
│     ├─ 处理 preventContinuation                              │
│     │   ├─ true → 产生 hook_stopped_continuation             │
│     │   └─ 循环优雅退出                                      │
│     ├─ 处理 additionalContext                                │
│     │   └─ 注入附加上下文                                    │
│     └─ 处理其他字段                                          │
│         ↓                                                    │
│ 8. if stop_reason != "tool_use":                             │
│         ↓                                                    │
│ 9. trigger_hooks("Stop", messages)                           │
│     ├─ 检查 stopHookActive                                   │
│     │   ├─ true → 不触发，直接退出                           │
│     │   └─ false → 触发                                      │
│     ├─ 执行所有注册的 hook                                   │
│     ├─ 收集 HookResult                                       │
│     ├─ 处理 blockingError                                    │
│     │   ├─ 设置 stopHookActive = true                        │
│     │   ├─ 注入错误到对话                                    │
│     │   └─ continue（强制续跑）                               │
│     └─ 处理 preventContinuation                              │
│         ├─ true → 退出                                       │
│         └─ false → 正常退出                                  │
│         ↓                                                    │
│ 10. return（循环结束）                                        │
└─────────────────────────────────────────────────────────────┘
```

---

## 五、设计精髓总结

### 5.1 为什么这样设计？

| 原因 | 说明 |
|------|------|
| **解耦** | 核心循环稳定，扩展逻辑在外部 |
| **可扩展** | 加功能不改循环代码 |
| **安全** | 权限不变式保证 hook 不能绕过用户配置 |
| **可控** | hook 可以阻止执行、修改输入、注入上下文 |
| **可恢复** | blockingError 让模型自纠，不是硬性阻止 |
| **防循环** | stopHookActive 防止无限循环 |
| **优雅停机** | hook_stopped_continuation 让 Agent 优雅退出 |

### 5.2 教学版 vs 生产版对比

| 方面 | 教学版 s04 | 生产版 CC |
|------|-----------|----------|
| **事件数量** | 4 个 | 27 个 |
| **返回值处理** | None vs 非 None | HookResult 14 个字段 |
| **权限不变式** | 无 | hook 'allow' 不能绕过 deny/ask |
| **防无限循环** | 无 | stopHookActive |
| **优雅停机** | 无 | hook_stopped_continuation |
| **输入修改** | 无 | updatedInput |
| **上下文注入** | 无 | additionalContext |
| **复杂度** | 简单易懂 | 生产级完善 |

### 5.3 设计模式总结

| 设计模式 | 应用 |
|---------|------|
| **观察者模式** | HOOKS 注册表，事件触发通知所有回调 |
| **插件架构** | register_hook() 动态添加功能 |
| **事件驱动架构** | 4/27 个事件点覆盖完整生命周期 |
| **开闭原则 (OCP)** | 循环对扩展开放，对修改关闭 |
| **依赖倒置原则 (DIP)** | 循环依赖抽象接口，不依赖具体实现 |
| **单一职责原则 (SRP)** | 每个模块只有一个变化原因 |

### 5.4 核心理解

**一句话总结：**

> **Hook 系统让扩展逻辑"挂在循环上"，而不是"写进循环里"。**
> **循环稳定不变，功能灵活扩展。**

**设计本质：**

```
核心循环（agent_loop）= 稳定层
    ├─ 只调用抽象接口 trigger_hooks()
    ├─ 不感知具体扩展逻辑
    └─ 代码始终不变

Hook 注册表（HOOKS）= 扩展层
    ├─ 动态注册回调函数
    ├─ 可以组合、替换、删除
    ├─ 具体逻辑在这里
    └─ 27 个事件点覆盖完整生命周期

抽象接口 = 解耦层
    ├─ register_hook(event, callback)
    ├─ trigger_hooks(event, *args)
    ├─ callback(*args) -> HookResult | None
    └─ 定义扩展规范

安全机制 = 保护层
    ├─ 权限不变式：hook 不能绕过 settings
    ├─ stopHookActive：防止无限循环
    ├─ blockingError：让模型自纠
    └─ hook_stopped_continuation：优雅停机
```

---

## 六、参考资料

- [s04_hooks/README.md](./README.md) — 原始教材
- Claude Code 源码：
  - `toolHooks.ts`（650 行）— Hook 执行引擎
  - `hooks.ts` — Hook 注册和管理
  - `stopHooks.ts` — Stop hook 机制
  - `coreTypes.ts` — Hook 事件定义（27 个）
  - `query.ts` — 主循环和 hook 集成

---

<!-- 文档版本：v1.0 -->
<!-- 创建时间：2026-06-21 -->
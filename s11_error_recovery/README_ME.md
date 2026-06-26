# s11: Error Recovery — 错误不是结束，是重试的开始

## 目录

- [一、整体思想：错误不是结束，是重试的开始](#一整体思想错误不是结束是重试的开始)
- [二、架构设计：三层恢复机制](#二架构设计三层恢复机制)
- [三、实现细节](#三实现细节)
- [四、完整流程图](#四完整流程图)
- [五、CC 的真实实现（教学版 vs 生产级）](#五cc-的真实实现教学版-vs-生产级)
- [六、总结](#六总结)

---

## 一、整体思想：错误不是结束，是重试的开始

### 核心理念

```
"错误不是终点，是重试的起点"

设计原则：
1. 分类处理：不同错误类型走不同的恢复路径
2. 自动恢复：不需要用户干预，系统自动重试
3. 分级降级：从最优方案逐步降级到保底方案

结果：
- 不一碰就崩溃（韧性）
- 自动恢复（无需用户干预）
- 分级降级（保证至少能完成）
```

### 三种最常见的故障模式

| 模式 | 触发 | 影响 | 恢复策略 |
|------|------|------|---------|
| **输出截断** | `max_tokens` 用完 | 模型话说一半，回答不完整 | 升级 8K→64K / 续写提示 |
| **上下文超限** | `prompt_too_long` | 压缩后还是太长 | reactive compact → 重试 |
| **临时故障** | 429 / 529 | 网络抖动、限流、过载 | 指数退避 + 抖动 + 切换模型 |

### 为什么需要错误恢复？

```
生产环境中 API 错误是常态：

问题：
- Agent 一碰就崩溃（没有重试）
- 没有换模型（继续用过载的模型）
- 没有减少上下文（继续用超长的上下文）
- 直接崩溃，用户体验极差

原因：
- 网络抖动（429/529）
- 上下文积累（prompt_too_long）
- 输出过长（max_tokens）

解决：
- 自动重试（指数退避）
- 自动压缩（reactive compact）
- 自动续写（continuation prompt）
- 自动切换模型（fallback）

一个不处理错误的 Agent 就像一个一碰就熄火的车。
```

---

## 二、架构设计：三层恢复机制

### 架构图

```
┌─────────────────────────────────────────────────────────┐
│                      agent_loop                          │
│  while True:                                            │
│    ├─> try:                                             │
│    │     ├─> with_retry(lambda: LLM call, state)        │
│    │     │     ├─> 429/529 → 指数退避 + 抖动           │
│    │     │     ├─> 连续 529 → 切换 fallback model      │
│    │     │     └─> 其他错误 → re-raise 给外层          │
│    │     └─> response = LLM call                        │
│    │                                                   │
│    ├─> except Exception as e:                          │
│    │     ├─> prompt_too_long → reactive compact        │
│    │     │     └─> 压缩后 continue 重试                │
│    │     └─> 其他错误 → 记录日志 + return             │
│    │                                                   │
│    ├─> if response.stop_reason == "max_tokens":        │
│    │     ├─> 第一次 → 升级 max_tokens (8K→64K)         │
│    │     │     └─> continue 重试（不追加截断输出）    │
│    │     └─> 第二次+ → 续写提示（最多 3 次）          │
│    │           ├─> messages.append(截断输出)           │
│    │           ├─> messages.append(续写提示)           │
│    │           └─> continue 重试                       │
│    │                                                   │
│    ├─> 正常完成：messages.append(response.content)      │
│    │                                                   │
│    ├─> if stop_reason != "tool_use":                   │
│    │     └─> return（对话结束）                        │
│    │                                                   │
│    └─> 工具执行：                                       │
│          ├─> 执行 tool_use                             │
│          ├─> messages.append(tool_result)              │
│          ├─> update_context                            │
│          └─> continue 下一轮                            │
└─────────────────────────────────────────────────────────┘
```

### 三层恢复机制详解

#### 第 1 层：with_retry wrapper（处理瞬态错误）

```python
# 第182-223 行
def with_retry(fn, state: RecoveryState):
    """Exponential backoff for transient errors (429/529)."""
    for attempt in range(MAX_RETRIES):  # 最多 10 次
        try:
            result = fn()  # 执行 LLM 调用
            state.consecutive_529 = 0  # 成功后清除计数
            return result
        except Exception as e:
            # 429 rate limit → exponential backoff
            if "ratelimit" in name.lower() or "429" in msg:
                delay = retry_delay(attempt)
                time.sleep(delay)
                continue
            
            # 529 overloaded → exponential backoff + fallback model
            if "overloaded" in name.lower() or "529" in msg:
                state.consecutive_529 += 1
                if state.consecutive_529 >= MAX_CONSECUTIVE_529:
                    state.current_model = FALLBACK_MODEL  # 切换模型
                delay = retry_delay(attempt)
                time.sleep(delay)
                continue
            
            # Not transient → re-raise for outer try/except
            raise
    
    raise RuntimeError(f"Max retries ({MAX_RETRIES}) exceeded")
```

**作用：**
- 处理 **瞬态错误**（429/529）
- 指数退避 + 抖动
- 连续 529 → 切换 fallback model
- 其他错误 → re-raise 给外层处理

#### 第 2 层：外层 try/except（处理非瞬态错误）

```python
# 第273-298 行
try:
    response = with_retry(lambda: client.messages.create(...), state)
except Exception as e:
    # Path 2: prompt_too_long → reactive compact (once)
    if is_prompt_too_long_error(e):
        if not state.has_attempted_reactive_compact:
            messages[:] = reactive_compact(messages)
            state.has_attempted_reactive_compact = True
            continue  # 压缩后重试
        print("  [unrecoverable] still too long after compact")
        messages.append({"role": "assistant", "content": "[Error] Context too large"})
        return
    
    # Unrecoverable
    print(f"  [unrecoverable] {name}: {str(e)[:100]}")
    messages.append({"role": "assistant", "content": f"[Error] {name}"})
    return
```

**作用：**
- 处理 **非瞬态错误**（prompt_too_long）
- reactive compact（压缩后重试）
- 其他错误 → 记录日志 + return

#### 第 3 层：stop_reason 检查（处理输出截断）

```python
# 第300-318 行
if response.stop_reason == "max_tokens":
    # First escalation: don't append truncated output, retry same request
    if not state.has_escalated:
        max_tokens = ESCALATED_MAX_TOKENS  # 8K → 64K
        state.has_escalated = True
        continue  # 重试（messages 不变）
    
    # 64K still truncated: save truncated output + continuation prompt
    messages.append({"role": "assistant", "content": response.content})
    if state.recovery_count < MAX_RECOVERY_RETRIES:  # 最多 3 次
        messages.append({"role": "user", "content": CONTINUATION_PROMPT})
        state.recovery_count += 1
        continue  # 续写重试
    
    print("  [max_tokens] recovery limit reached")
    return
```

**作用：**
- 处理 **输出截断**（max_tokens）
- 第一次 → 升级 max_tokens（8K→64K）
- 第二次+ → 续写提示（最多 3 次）

### RecoveryState 状态管理

```python
# 第163-170 行
class RecoveryState:
    """Track recovery attempts across the loop."""
    def __init__(self):
        self.has_escalated = False  # 是否已升级 max_tokens
        self.recovery_count = 0  # 续写次数
        self.consecutive_529 = 0  # 连续 529 次数
        self.has_attempted_reactive_compact = False  # 是否已尝试 reactive compact
        self.current_model = PRIMARY_MODEL  # 当前模型
```

**作用：**
- 跨循环跟踪恢复状态
- 避免重复尝试同一恢复路径
- 记录连续错误次数（触发降级）

---

## 三、实现细节

### 细节 1：max_tokens 路径（升级 + 续写）

#### 问题：输出被截断

```
场景：
LLM 调用返回 stop_reason == "max_tokens"
意思是：模型话说一半，token 用完了（默认 8000）

问题：
- 回答不完整（模型想说更多但被截断）
- 用户体验差（只看到一半）
```

#### 恢复策略：两阶段

```
阶段 1：升级 max_tokens（第一次）
  ├─> has_escalated = False（第一次发生）
  ├─> max_tokens = 8K → 64K（8 倍空间）
  ├─> continue 重试
  └─> 关键：不追加截断输出到 messages（保持原始请求不变）

阶段 2：续写提示（第二次+）
  ├─> has_escalated = True（已升级）
  ├─> 64K 还是不够
  ├─> messages.append(截断输出)  # ← 保存截断内容
  ├─> messages.append(续写提示)  # ← 让模型接着说
  ├─> recovery_count += 1
  ├─> continue 重试
  └─> 最多 3 次续写
```

#### 为什么第一次不追加截断输出？

```
对比：

方案 1（第一次追加截断输出）：
messages = [
    {"role": "user", "content": "生成一段很长的代码"},
    {"role": "assistant", "content": "截断的代码（一半）"},  # ←追加
]
max_tokens = 64K
重试 → LLM 看到"截断的代码"，会重新开始，不会接着说

问题：
- LLM 不知道要接着说（以为是新对话）
-浪费了截断的内容

方案 2（第一次不追加截断输出）：
messages = [
    {"role": "user", "content": "生成一段很长的代码"},  # ←不变
]
max_tokens = 64K
重试 → LLM 用 64K 重新生成，可能一次性说完

优点：
- 不追加截断内容（messages 不变）
- LLM 有更多空间（64K）
- 可能一次性说完（不需要续写）
```

#### 续写提示的设计

```python
# 第58-61 行
CONTINUATION_PROMPT = (
    "Output token limit hit. Resume directly — "
    "no apology, no recap. Pick up mid-thought."
)
```

**设计理念：**
- "no apology, no recap"：不要道歉、不要回顾（浪费时间）
- "Pick up mid-thought"：接着刚才的想法继续
- 紧凑、高效

#### 流程图

```
第一次 max_tokens（has_escalated = False）：
  │
  ├─> max_tokens = 64K（升级）
  ├─> has_escalated = True
  ├─> messages 不变（不追加截断输出）
  ├─> continue 重试
  │
  └─> LLM 用 64K 重新生成
        ├─> 成功说完 → 正常完成
        └─> 还是截断 → 进入阶段 2

第二次 max_tokens（has_escalated = True）：
  │
  ├─> messages.append(截断输出)
  ├─> messages.append(续写提示)
  ├─> recovery_count += 1
  ├─> continue 重试
  │
  └─> LLM 接着截断的内容继续说
        ├─> 成功说完 → 正常完成
        └─> 还是截断 → 再次续写（最多 3 次）
```

### 细节 2：prompt_too_long 路径

#### 问题：上下文超限

```
场景：
LLM API 抛出异常："prompt_is_too_long"

意思是：上下文太长了（超过模型限制）

问题：
- s08 的四层压缩全跑过了，还是超
- 无法调用 LLM（API 拒绝）
```

#### 恢复策略：reactive compact

```python
# 第235-244 行
def reactive_compact(messages: list) -> list:
    """Emergency compact — teaching version keeps last N messages."""
    print("  [reactive compact] trimming to last 5 messages")
    tail = messages[-5:]
    return [{"role": "user",
             "content": "[Reactive compact] Earlier conversation trimmed. "
                        "Continue from where you left off."}, *tail]
```

**教学版 vs CC：**

```
教学版（简化）：
  ├─> 只保留最后 5 条消息
  ├─> 添加提示："Earlier conversation trimmed. Continue..."
  └─> 简单、高效

CC（真实实现）：
  ├─> 调用 LLM 生成 compact 摘要
  ├─> 使用 s08 的 compact_history
  ├─> 生成摘要后重试
  └─> 更复杂、更准确
```

#### 只尝试一次

```python
# 第283-286 行
if not state.has_attempted_reactive_compact:
    messages[:] = reactive_compact(messages)
    state.has_attempted_reactive_compact = True
    continue  # 压缩后重试
```

**为什么只尝试一次？**

```
问题：如果压缩过一次还是超限？

原因：
- 压缩已经是"最激进"的措施
- 再压缩也不会变小（可能只剩下 5 条消息）
- 继续尝试没有意义

策略：
- 只尝试一次 reactive compact
- 如果还是超限 → 记录错误 + return
```

### 细节 3：429/529 路径（指数退避 + 抖动）

#### 问题：临时故障

```
场景：
LLM API 抛出异常："429 rate limit" 或 "529 overloaded"

意思是：
- 429：请求太频繁，被限流
- 529：服务器过载，暂时无法响应

问题：
- 不是 bug，是分布式系统的常态
- 需要自动重试（不需要用户干预）
```

#### 恢复策略：指数退避 + 抖动

```python
# 第173-179 行
def retry_delay(attempt, retry_after=None):
    """Exponential backoff with jitter."""
    if retry_after:  # 如果服务器返回 Retry-After header
        return retry_after
    
    # 指数退避公式
    base = min(BASE_DELAY_MS * (2 ** attempt), 32000) / 1000
    # 随机抖动（0~25%）
    jitter = random.uniform(0, base * 0.25)
    return base + jitter
```

**退避公式：**

```
公式：min(500 × 2^attempt, 32000) + random(0~25%)

计算：
- attempt 0: 500ms + 0~125ms = 500~625ms
- attempt 1: 1000ms + 0~250ms = 1000~1250ms
- attempt 2: 2000ms + 0~500ms = 2000~2500ms
- attempt 3: 4000ms + 0~1000ms = 4000~5000ms
- attempt 4: 8000ms + 0~2000ms = 8000~10000ms
- attempt 5: 16000ms + 0~4000ms = 16000~20000ms
- attempt 6+: 32000ms + 0~8000ms = 32000~40000ms（上限）
```

**为什么加抖动？**

```
问题：如果没有抖动，会怎样？

场景：100 个并发请求同时遇到 429

没有抖动：
  ├─> 所有请求等待相同时间（如 1000ms）
  ├─> 1000ms 后，所有请求同时重试
  ├─> 再次触发 429（瞬间100 个请求）
  └─> 恶性循环

有抖动：
  ├─> 每个请求等待不同时间（1000~1250ms）
  ├─> 请求分散在不同时刻重试
  ├─> 避免瞬间大量请求
  └─> 成功恢复
```

#### 529 过载 → 切换 fallback model

```python
# 第203-214 行
if "overloaded" in name.lower() or "529" in msg:
    state.consecutive_529 += 1
    if state.consecutive_529 >= MAX_CONSECUTIVE_529:  # 连续 3 次
        if FALLBACK_MODEL:
            state.current_model = FALLBACK_MODEL  #切换模型
            state.consecutive_529 = 0
            print(f"  [529 x3] switching to {FALLBACK_MODEL}")
```

**策略：**
- 连续 3 次 529 → 切换到备用模型（如 Opus → Sonnet）
- 降低模型级别（从高级模型降级到普通模型）
- 保证至少能完成（保底方案）

---

## 四、完整流程图

### 时间线详解

```
时间点 1：agent_loop 开始
  ├─> system = get_system_prompt(context)
  ├─> state = RecoveryState()
  ├─> max_tokens = 8000
  └─> while True:

时间点 2：LLM 调用（with_retry wrapper）
  │
  ├─> try:
  │     ├─> with_retry(lambda: client.messages.create(...), state)
  │     │     │
  │     │     ├─> for attempt in range(10):  # 最多 10 次
  │     │     │     ├─> try:
  │     │     │     │     ├─> fn()  # LLM 调用
  │     │     │     │     ├─> 成功 → return result
  │     │     │     │     └─> state.consecutive_529 = 0
  │     │     │     │
  │     │     │     └─> except Exception as e:
  │     │     │           ├─> 429 rate limit:
  │     │     │           │     ├─> delay = retry_delay(attempt)
  │     │     │           │     ├─> time.sleep(delay)
  │     │     │           │     ├─> continue（重试）
  │     │     │           │
  │     │     │           ├─> 529 overloaded:
  │     │     │           │     ├─> state.consecutive_529 += 1
  │     │     │           │     ├─> if consecutive_529 >= 3:
  │     │     │           │     │     └─> state.current_model = FALLBACK_MODEL
  │     │     │           │     ├─> delay = retry_delay(attempt)
  │     │     │           │     ├─> time.sleep(delay)
  │     │     │           │     ├─> continue（重试）
  │     │     │           │
  │     │     │           └─> 其他错误:
  │     │     │                 └─> raise（re-raise 给外层）
  │     │     │
  │     │     └─> raise RuntimeError("Max retries exceeded")  # 10 次后仍失败
  │     │
  │     └─> response = with_retry(...)  # 成功返回 response
  │
  ├─> except Exception as e:  # 外层捕获
  │     │
  │     ├─> prompt_too_long:
  │     │     ├─> if not has_attempted_reactive_compact:
  │     │     │     ├─> messages[:] = reactive_compact(messages)
  │     │     │     ├─> has_attempted_reactive_compact = True
  │     │     │     ├─> continue（压缩后重试）
  │     │     │
  │     │     └─> else:
  │     │           ├─> print("still too long after compact")
  │     │           ├─> messages.append("[Error] Context too large")
  │     │           └─> return
  │     │
  │     └─> 其他错误:
  │           ├─> print(f"[unrecoverable] {name}")
  │           ├─> messages.append(f"[Error] {name}")
  │           └─> return
  │
  ├─> response 成功返回后：
  │     │
  │     ├─> if response.stop_reason == "max_tokens":
  │     │     │
  │     │     ├─> 第一次（has_escalated = False）:
  │     │     │     ├─> max_tokens = 64K
  │     │     │     ├─> has_escalated = True
  │     │     │     ├─> messages 不变
  │     │     │     ├─> continue（重试）
  │     │     │
  │     │     └─> 第二次+（has_escalated = True）:
  │     │           ├─> messages.append(截断输出)
  │     │           ├─> if recovery_count < 3:
  │     │           │     ├─> messages.append(续写提示)
  │     │           │     ├─> recovery_count += 1
  │     │           │     ├─> continue（续写重试）
  │     │           │
  │     │           └─> else:
  │     │                 ├─> print("recovery limit reached")
  │     │                 └─> return
  │     │
  │     ├─> 正常完成:
  │     │     ├─> messages.append(response.content)
  │     │     ├─> if stop_reason != "tool_use":
  │     │     │     └─> return（对话结束）
  │     │     │
  │     │     └─> 工具执行:
  │     │           ├─> 执行 tool_use
  │     │           ├─> messages.append(tool_result)
  │     │           ├─> update_context
  │     │           ├─> system = get_system_prompt(context)
  │     │           └─> continue下一轮）
```

---

## 五、CC 的真实实现（教学版 vs 生产级）

### CC 有十几种 reason/transition

| reason/transition | 教学版对应 | CC 行为 |
|---|---|---|
| `completed` | 正常完成 | 返回结果 |
| `next_turn` | 正常工具调用 | 继续下一轮工具执行 |
| `max_output_tokens_escalate` | 路径 1（第一次） | 8K→64K 升级 |
| `max_output_tokens_recovery` | 路径 1（续写） | 续写提示（最多 3 次） |
| `reactive_compact_retry` | 路径 2 | reactive compact → 重试 |
| `prompt_too_long` | 路径 2 | 同上 |
| `collapse_drain_retry` | 未展开 | context collapse 先提交暂存 |
| `model_error` | 未展开 | 重试 |
| `image_error` | 未展开 | `ImageSizeError` 专门处理 |
| `aborted_streaming` | 未展开 | 流式中止恢复 |
| `aborted_tools` | 未展开 | 工具中止 |
| `stop_hook_blocking` | 未展开 | 注入 blocking error → 模型自纠 |
| `token_budget_continuation` | 未展开 | token 用量 < 90% 时继续 |
| `max_turns` | 未展开 | 达到最大轮次 |

### CC 的精确退避公式

```
CC 的退避延迟：

delay = min(500 × 2^(attempt-1), 32000) + random(0~25%)

| 尝试 | 基础延迟 | + 抖动 |
|------|---------|--------|
| 1    | 500ms   | 0-125ms |
| 2    | 1000ms  | 0-250ms |
| 4    | 4000ms  | 0-1000ms |
| 7+   | 32000ms（上限） | 0-8000ms |
```

### CC 的 Diminishing Returns 检测

```
Token budget 的"继续"不是无限的：

检测：
- 连续 3 次 continuation
- 且 token 增量 < 500

判断：
- "继续也没有实质性产出"
- 停止 continuation

策略：
- 避免无限续写（浪费时间）
- 检测边际效益递减
```

---

## 六、总结

### 设计理念

```
"错误不是终点，是重试的起点"

三层设计：
1. 分类处理（不同错误走不同路径）
2. 自动恢复（无需用户干预）
3. 分级降级（最优→保底）
```

### 三条恢复路径

| 路径 | 错误类型 | 恢复策略 | 为什么？ |
|------|---------|---------|---------|
| **路径 1** | max_tokens | 升级 + 续写 | 输出被截断，需要更多空间 |
| **路径 2** | prompt_too_long | reactive compact | 上下文太长，需要压缩 |
| **路径 3** | 429/529 | 指数退避 + 抖动 + fallback | 临时故障，需要等待或降级 |

### 关键实现

```
关键实现点：

1. RecoveryState（状态管理）
   ├─> 跨循环跟踪恢复状态
   ├─> 避免重复尝试同一路径
   └─> 记录连续错误次数（触发降级）

2. with_retry wrapper（瞬态错误）
   ├─> 指数退避 + 抖动
   ├─> 连续 529 → 切换 fallback model
   └─> 其他错误 → re-raise 给外层

3. max_tokens 路径（两阶段）
   ├─> 第一次：升级 8K→64K（不追加截断输出）
   ├─> 第二次+：续写提示（最多 3 次）
   └─> 为什么不追加：给 LLM 更多空间，可能一次性说完

4. prompt_too_long 路径（只尝试一次）
   ├─> reactive compact（压缩到最后 5 条）
   ├─> 只尝试一次（再压缩也不会变小）
   └─> 如果还失败 → 记录错误 + return

5. 指数退避 + 抖动（避免雪崩）
   ├─> 公式：min(500 × 2^attempt, 32000) + random(0~25%)
   ├─> 抖动：让并发请求分散重试
   └─> Retry-After header：优先使用服务器建议
```

### CC 的真实实现更复杂

```
教学版：简化版（3 条路径，简单实现）
CC：生产级（10+ reason/transition，精确退避，Diminishing Returns 检测）

关键差异：
- CC 有更多 reason/transition（不只是 max_tokens、prompt_too_long、429/529）
- CC 有 Diminishing Returns 检测（避免无限续写）
- CC 有流式错误处理（暂扣错误，等 streaming 结束后判断）
- CC 有 token budget continuation（token 用量 < 90% 时继续）
```
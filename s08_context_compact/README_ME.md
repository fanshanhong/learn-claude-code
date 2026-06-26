# s08 Context Compact — 深度理解笔记

## 一、宏观理解：核心问题

### 1.1 问题：上下文无限膨胀，Agent 被卡死

```
Agent 跑着跑着，不动了。

手里有 bash、read、write，能力是够的。
但它读了一个 1000 行的文件（~4000 token）
又读了 30 个文件
跑了 20 条命令
每条命令的输出、每个文件的内容，全都堆在 messages 列表里

上下文窗口是有限的：
  ├─ Claude 3.5 Sonnet: 200K tokens
  ├─ Claude 3.5 Haiku: 200K tokens
  ├─ Claude 3 Opus: 200K tokens
  └─ 每次调用 LLM，整个 messages[] 都要发送

问题：
  ├─ 上下文窗口被填满
  ├─ API 返回错误：prompt_too_long（413）
  ├─ Agent 无法继续工作
  └─ 在大项目中根本没法干活

类比：
  ├─ 就像背包里的东西越来越多
  ├─ 旧的东西占着位置
  ├─ 新的东西放不进去
  └─ Agent 被"卡死"
```

### 1.2 设计理念："上下文总会满，要有办法腾地方"

```
核心认知：
  ├─ 上下文窗口是有限的（物理限制）
  ├─ Agent 连续工作，上下文必然增长
  ├─ 上下文总会满（必然事件）
  └─ 要有办法腾地方（解决方案）

类比理解：
  ├─ 背包空间有限（上下文窗口）
  ├─ 旅行时东西会越来越多（对话历史增长）
  ├─ 背包总会满（必然）
  └─ 要有办法整理背包（压缩策略）
```

---

## 二、架构设计：四层压缩管线

### 2.1 核心设计原则："便宜的先跑，贵的后跑"

```
设计原则：
  ├─ 第一层：纯文本/结构操作（0 API 调用，成本 0）
  ├─ 第二层：纯文本/结构操作（0 API 调用，成本 0）
  ├─ 第三层：纯文本/结构操作（0 API 调用，成本 0）
  ├─ 第四层：LLM 摘要（1 API 调用，成本 1x）
  └─ 应急层：LLM 摘要 + 截断（1 API 调用，成本 1x）

顺序：
  ├─ 先跑便宜的（L1/L2/L3，0 API）
  ├─ 检查是否超阈值
  ├─ 超阈值才跑贵的（L4，1 API）
  └─ API 报错才跑应急（reactive）

类比：
  ├─ 先整理背包（L1/L2/L3，免费）
  ├─ 还放不下才买新背包（L4，花钱）
  └─ 紧急情况才丢弃物品（reactive，损失大）
```

### 2.2 四层压缩管线架构

```
┌─────────────────────────────────────────────────────────────┐
│  messages[]                                                 │
│    ↓                                                        │
│  L3: tool_result_budget ─→ 大结果落盘到磁盘                │
│    ↓                                                        │
│  L1: snip_compact ─→ 裁掉中间的旧对话                       │
│    ↓                                                        │
│  L2: micro_compact ─→ 旧工具结果用占位符替换                │
│    ↓                                                        │
│  [token count > threshold?]                                 │
│    ├─ No  → 调用 LLM                                       │
│    └─ Yes → L4: compact_history                            │
│              ├─ 写 transcript（完整对话保存）               │
│              ├─ LLM 生成摘要（1 API 调用）                  │
│              └─ 替换 messages（只保留摘要）                 │
│              ↓                                              │
│          调用 LLM                                           │
│    [prompt_too_long?]                                       │
│    └─ Yes → reactive_compact                               │
│              ├─ 更激进的截断                                │
│              ├─ 保留尾部 5 条消息                            │
│              └─ 替换前面的为摘要                            │
└─────────────────────────────────────────────────────────────┘
```

---

## 三、为什么这么设计？

### 3.1 为什么需要四层？

**单层压缩的局限性**：

```
如果只有一层（比如直接 LLM 摘要）：

问题：
  ├─ 每次压缩都要调用 LLM（1 API）
  ├─ 成本高（每次 ~$0.01）
  ├─ 次数多（频繁压缩）
  └─ 总成本很高（API 费用）

例子：
  ├─ Agent 连续工作 30 分钟
  ├─ 每分钟可能触发压缩
  ├─ 30 次压缩 × $0.01 = $0.30
  └─ 成本很高

如果有多层：
  ├─ L1/L2/L3 便宜（0 API）
  ├─ 大部分情况下，三层就够了
  ├─ 只有极端情况才调 LLM（L4）
  ├─ 成本大幅降低
  └─ 平均成本 ~$0.01（而不是 $0.30）
```

**为什么需要不同的层**：

```
不同的问题需要不同的解决方案：

问题 1：对话轮数太多（160 条消息）
  ├─ 问题：消息数量占位置
  ├─ 解决：裁掉中间消息（L1 snip_compact）
  └─ 针对问题：消息数量

问题 2：旧工具结果太多（10 个 read_file 的完整内容）
  ├─ 问题：旧工具结果占大量 token
  ├─ 解决：替换为占位符（L2 micro_compact）
  └─ 针对问题：旧工具结果

问题 3：单条结果太大（一次 cat 大文件 500KB）
  ├─ 问题：单条 tool_result 超大
  ├─ 解决：落盘到磁盘（L3 tool_result_budget）
  └─ 针对问题：单条大结果

问题 4：整体对话太大（30 分钟连续工作）
  ├─ 问题：整体对话超阈值
  ├─ 解决：LLM 全量摘要（L4 compact_history）
  └─ 针对问题：整体对话

类比：
  ├─ 不同类型的垃圾需要不同的处理方式
  ├─ 纸张：直接扔（L1，便宜）
  ├─ 塑料：回收处理（L2，稍贵）
  ├─ 有害垃圾：专门处理（L3，贵）
  └─ 大件垃圾：运输处理（L4，最贵）
```

### 3.2 为什么是这个顺序？（budget → snip → micro）

**顺序的重要性**：

```
执行顺序：
  L3: tool_result_budget（大结果落盘）
  ↓
  L1: snip_compact（裁中间）
  ↓
  L2: micro_compact（旧结果占位）

为什么是这个顺序？

关键原因：L2 会把大 tool_result 替换成一行占位符
  ├─ 如果先跑 L2，大 tool_result 被替换成占位符
  ├─ 再跑 L3 budget，完整内容已经丢失
  ├─ L3 无法把完整内容落盘
  └─ 大文件内容永久丢失 ❌

正确顺序：
  ├─ 先跑 L3 budget：把大 tool_result 的完整内容落盘
  ├─ 再跑 L2 micro：把落盘后的内容替换成占位符
  ├─ 占位符包含 <persisted-output> 标记 + 磁盘路径
  └─ 模型可以重新读取完整内容 ✓
```

**CC 源码的顺序验证**：

```typescript
// CC 源码 query.ts:379-468 的真实顺序

// 1. applyToolResultBudget（L379）
messages = applyToolResultBudget(messages)

// 2. snipCompact（L403）
messages = snipCompactIfNeeded(messages)

// 3. microcompact（L414）
messages = microcompact(messages)

// 4. contextCollapse（L441）← 教学版无
messages = contextCollapse(messages)

// 5. autoCompact（L454）
messages = autoCompact(messages)

教学版的顺序与此一致 ✓
```

### 3.3 为什么需要应急层（reactive_compact）？

```
为什么 API 还会返回 prompt_too_long？

原因：
  ├─ 上下文增长速度快于压缩触发速度
  ├─ 前三层无法"理解"对话内容
  ├─ 只是机械地裁剪和替换
  ├─ 可能裁剪不当
  └─ token 估算不准确（教学版用字符数估算）

场景：
  ├─ Agent 连续读 10 个大文件
  ├─ L3 budget 落盘，但可能不够
  ├─ L2 micro 替换，但可能还有新的大结果
  ├─ L1 snip 裁剪，但可能裁剪不当
  ├─ token 仍然超阈值
  ├─ API 返回 prompt_too_long ❌
  └─ 需要应急处理

应急层的处理：
  ├─ 更激进的截断（只保留尾部 5 条）
  ├─ 生成摘要（LLM 调用）
  ├─ 替换前面的所有消息
  └─ 确保下次调用成功 ✓

类比：
  ├─ 就像紧急医疗
  ├─ 正常处理不够（前三层）
  ├─ 病情恶化（API 报错）
  ├─ 紧急手术（reactive）
  └─ 保命优先（确保下次调用成功）
```

---

## 四、实现思路：整体策略

### 4.1 核心思路：逐步升级压缩强度

```
实现思路：

Step 1: 轻量级压缩（L1/L2/L3）
  ├─ 每轮 LLM 调用前执行
  ├─ 纯文本/结构操作
  ├─ 不调用 LLM（0 API）
  ├─ 成本：免费
  └─ 效果：大部分情况下足够

Step 2: 检查阈值
  ├─ 估算 messages 的 token 数
  ├─ 与阈值比较
  ├─ 超阈值 → 触发 L4
  └─ 未超阈值 → 直接调用 LLM

Step 3: LLM 摘要（L4）
  ├─ 写 transcript（保存完整对话）
  ├─ LLM 生成摘要（保留关键信息）
  ├─ 替换 messages（只保留摘要）
  └─ 成本：1 API 调用

Step 4: 应急处理（API 报错时）
  ├─ 检测 prompt_too_long 错误
  ├─ reactive_compact（更激进）
  ├─ 重试上限（避免死循环）
  └─ 最终失败：抛出异常
```

### 4.2 压缩时机

```
触发时机：

主动触发：
  ├─ 每轮 LLM 调用前
  ├─ 运行前三层（budget → snip → micro）
  ├─ 检查 token 数
  ├─ 超阈值 → L4 compact_history
  └─ 模型调用 compact 工具 → L4

被动触发：
  ├─ API 返回 prompt_too_long
  ├─ 触发 reactive_compact
  ├─ 重试上限（MAX_REACTIVE_RETRIES = 1）
  └─ 再失败 → 抛出异常

类比：
  ├─ 主动触发：定期清理背包（每轮）
  ├─ 被动触发：背包爆炸时紧急处理（API 报错）
```

### 4.3 熔断机制

```
熔断机制：
  ├─ L4 熔断器：连续失败 3 次后停止重试
  ├─ reactive 熔断器：重试上限 1 次
  └─ 防止死循环浪费 API 调用

为什么需要熔断？
  ├─ 避免 API 调用死循环
  ├─ 避免成本失控
  ├─ 避免时间浪费
  └─ 最终失败交给后续错误处理

类比：
  ├─ 就像保险丝
  ├─ 电流过大时自动断开
  ├─ 保护系统不被烧毁
  └─ 避免灾难性后果
```

---

## 五、逐层详解

### 5.1 L1: snip_compact — 裁掉中间消息

**问题**：对话轮数太多（160 条消息）

```
场景：
  Agent 跑了 80 轮对话
  messages 攒了 160 条
  最前面的"帮我创建 hello.py"
  和当前工作几乎无关了
  但全占着位置
```

**解决方案**：

```python
def snip_compact(messages, max_messages=50):
    if len(messages) <= max_messages:
        return messages  # 不超过阈值，不处理

    # 保留头部 3 条（初始上下文）
    # 保留尾部 47 条（当前工作）
    # 裁掉中间的 110 条

    keep_head, keep_tail = 3, max_messages - 3
    head_end, tail_start = keep_head, len(messages) - keep_tail

    # 关键边界条件：不能拆开 tool_use 和 tool_result

    # 1. 检查 head_end 是否会切到 tool_use
    if head_end > 0 and _message_has_tool_use(messages[head_end - 1]):
        # 如果前一条是 assistant(tool_use)
        # 找到对应的 tool_result 结束位置
        while head_end < len(messages) and _is_tool_result_message(messages[head_end]):
            head_end += 1

    # 2. 检查 tail_start 是否会切到 tool_result
    if (tail_start > 0 and tail_start < len(messages)
            and _is_tool_result_message(messages[tail_start])
            and _message_has_tool_use(messages[tail_start - 1])):
        # 如果当前是 user(tool_result)，前一条是 assistant(tool_use)
        # 不能分开，回退一条
        tail_start -= 1

    # 3. 裁剪
    if head_end >= tail_start:
        return messages  # 裁剪范围无效

    snipped = tail_start - head_end
    placeholder = {"role": "user", "content": f"[snipped {snipped} messages]"}

    return messages[:head_end] + [placeholder] + messages[tail_start:]
```

**消息结构的理解**：

```
正常消息配对结构：

一条 assistant message 可能包含多个 tool_use：
messages.append({
    "role": "assistant",
    "content": [
        {"type": "tool_use", "id": "tool_1", "name": "read_file", ...},
        {"type": "tool_use", "id": "tool_2", "name": "bash", ...},
        {"type": "tool_use", "id": "tool_3", "name": "write_file", ...}
    ]
})

对应的 tool_result 都在同一条 user message 中：
messages.append({
    "role": "user",
    "content": [
        {"type": "tool_result", "tool_use_id": "tool_1", "content": "文件内容..."},
        {"type": "tool_result", "tool_use_id": "tool_2", "content": "命令输出..."},
        {"type": "tool_result", "tool_use_id": "tool_3", "content": "写入成功"}
    ]
})
```

**为什么不能拆开 tool_use 和 tool_result**：

```
边界条件的重要性：

如果裁剪时拆开了：
  ├─ 只有 assistant(tool_use)，没有 tool_result
  ├─ 模型看不到工具的实际输出
  ├─ 会导致模型"困惑"
  └─ 无法理解工具调用的结果

必须保持 tool_use 和 tool_result 的完整配对：
  ├─ assistant(tool_use) 和 user(tool_result) 是一个整体
  ├─ tool_result 是对 tool_use 的响应
  └─ 一个 assistant 可能调用多个工具，对应的 tool_result 都在同一条 user message 中
```

**为什么保留头部 3 条**：

```
头部 3 条的重要性：
  ├─ messages[0]: 用户初始输入
  ├─ messages[1]: assistant 初始分析
  ├─ messages[2]: user(tool_result)
  └─ 这是对话的起点，包含初始目标和任务

类比：
  ├─ 就像旅行日志的开头
  ├─ 记录了"出发时间、目的地"
  ├─ 即使后面的日志删了
  └─ 开头仍然知道"要去哪里"
```

**为什么保留尾部 47 条**：

```
尾部 47 条的重要性：
  ├─ 最最近的工作
  ├─ 当前正在处理的文件
  ├─ 当前正在执行的命令
  └─ 最相关的上下文

类比：
  ├─ 就像旅行日志的结尾
  ├─ 记录了"当前位置、下一步计划"
  └─ 必须保留，才能继续工作
```

### 5.2 L2: micro_compact — 旧工具结果占位

**问题**：旧工具结果太多（10 个 read_file 的完整内容）

```
场景：
  Agent 连续读了 10 个文件
  第 1-7 次的完整内容还躺在上下文里
  早就不需要了
  但占着大量空间（每个 ~4000 tokens）
```

**解决方案**：

```python
KEEP_RECENT = 3  # 保留最近 3 条 tool_result

def collect_tool_results(messages):
    # 收集所有 tool_result blocks
    blocks = []
    for mi, msg in enumerate(messages):
        if msg.get("role") != "user" or not isinstance(msg.get("content"), list):
            continue
        for bi, block in enumerate(msg["content"]):
            if isinstance(block, dict) and block.get("type") == "tool_result":
                blocks.append((mi, bi, block))  # 消息索引, block索引, block本身
    return blocks

def micro_compact(messages):
    tool_results = collect_tool_results(messages)

    if len(tool_results) <= KEEP_RECENT:
        return messages  # 不超过阈值，不处理

    # 保留最近 3 条，更旧的替换为占位符
    for _, _, block in tool_results[:-KEEP_RECENT]:
        if len(block.get("content", "")) > 120:
            block["content"] = "[Earlier tool result compacted. Re-run if needed.]"

    return messages
```

**collect_tool_results 的作用**：

```
收集所有 tool_result blocks 的用途：
  ├─ 定位所有 tool_result 的位置（消息索引 mi，block 索引 bi）
  ├─ 判断有多少个 tool_result（是否需要压缩）
  ├─ 区分哪些是旧的（前面的），哪些是新的（后面的）
  └─ 直接操作 block 对象本身（Python 引用机制）

收集结果示例：
[
    (2, 0, {"type": "tool_result", "tool_use_id": "A", "content": "..."}),
    (2, 1, {"type": "tool_result", "tool_use_id": "B", "content": "..."}),
    (5, 0, {"type": "tool_result", "tool_use_id": "C", "content": "..."}),
    ...
]
```

**为什么判断 len > 120**：

```
判断的是 content 字段的字符串长度（字符数）：

如果一个 tool_result 的内容只有 50 个字符：
  ├─ 例如："写入成功"
  ├─ 本来就很小
  ├─ 替换成占位符（40字符）反而可能更大
  └─ 不替换，保持原样 ✓

如果一个 tool_result 的内容有 5000 个字符：
  ├─ 例如：一个完整的文件内容
  ├─ 占大量空间
  ├─ 替换成占位符（40字符）节省空间
  └─ 必须替换 ✓
```

**直接操作 blocks 是否是直接修改 messages**：

```
是的！直接修改 messages！

Python 对象引用机制：
blocks.append((mi, bi, block))  # block 是对原始对象的引用
block["content"] = "..."  # 这直接改了 messages[mi]["content"][bi]

验证代码：
messages = [{"role": "user", "content": [{"type": "tool_result", "content": "很长..."}]}]
tool_results = collect_tool_results(messages)
block = tool_results[0][2]
block["content"] = "替换后的内容"
print(messages[0]["content"][0]["content"])  # 输出："替换后的内容"
```

**为什么保留最近 3 条**：

```
最近 3 条的重要性：
  ├─ 最最近的工作结果
  ├─ 当前正在使用的文件内容
  ├─ 当前正在分析的输出
  └─ 最相关的上下文

类比：
  ├─ 就像最近处理的书
  ├─ 可能还在用，不能扔
  └─ 更早的书可以扔（占位符）
```

**为什么用占位符而不是直接删除**：

```
占位符的作用：
  ├─ 保留 tool_result 的结构（tool_use_id）
  ├─ 提示模型"这里曾经有结果"
  ├─ 如果需要，模型可以重新执行
  └─ 不完全丢失信息

类比：
  ├─ 就像书的索引卡
  ├─ 原书扔了（节省空间）
  ├─ 但索引卡保留（占位符）
  ├─ 提示"这里曾经有这本书"
  └─ 需要时可以重新找书
```

**教学版的简化**：

```
教学版：按位置（最近 3 条）

CC 真实实现：
  ├─ time-based micro_compact：
  │   ├─ 按时间阈值触发（60 分钟）
  │   └─ 超过 60 分钟的 tool_result 清内容
  │
  └─ cached micro_compact：
  │   ├─ 按计数触发
  │   └─ 超过阈值的清内容
  │
  └─ 两条路径，更复杂的逻辑

教学版简化：
  ├─ 只按位置（最近 3 条）
  ├─ 足以展示核心概念
  └─ 避免时间/计数逻辑的复杂度
```

### 5.3 L3: tool_result_budget — 大结果落盘

**问题**：单条结果太大（一次 cat 大文件 500KB）

```
场景：
  模型一次读了 5 个大文件
  单条 user 消息里所有 tool_result 加起来 500KB

问题：
  ├─ 单条消息就超限制
  ├─ L1/L2 无法处理（L2 只处理旧结果，L1 裁中间）
  ├─ 需要处理当前的大结果
  └─ 必须落盘到磁盘
```

**解决方案**：

```python
PERSIST_THRESHOLD = 30000  # 30KB 以上才落盘
MAX_BYTES = 200_000        # 总预算 200KB

def persist_large_output(tool_use_id, output):
    if len(output) <= PERSIST_THRESHOLD:
        return output  # 不够大，不落盘

    # 落盘到磁盘
    TOOL_RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    path = TOOL_RESULTS_DIR / f"{tool_use_id}.txt"

    if not path.exists():  # 避免重复写入
        path.write_text(output)

    # 返回标记 + 预览
    return f"<persisted-output>\nFull output: {path}\nPreview:\n{output[:2000]}\n</persisted-output>"

def tool_result_budget(messages, max_bytes=200_000):
    last = messages[-1]  # 只处理最后一条消息

    if not last or last.get("role") != "user" or not isinstance(last.get("content"), list):
        return messages

    # 收集最后一条消息里的所有 tool_result
    blocks = [(i, b) for i, b in enumerate(last["content"])
              if isinstance(b, dict) and b.get("type") == "tool_result"]

    # 计算总大小
    total = sum(len(str(b.get("content", ""))) for _, b in blocks)

    if total <= max_bytes:
        return messages  # 不超预算，不处理

    # 按大小排序，从最大的开始落盘
    ranked = sorted(blocks, key=lambda p: len(str(p[1].get("content", ""))), reverse=True)

    for _, block in ranked:
        if total <= max_bytes:
            break  # 已控制在预算内

        content = str(block.get("content", ""))

        if len(content) <= PERSIST_THRESHOLD:
            continue  # 不够大，不落盘

        tid = block.get("tool_use_id", "unknown")
        block["content"] = persist_large_output(tid, content)

        # 重新计算总大小
        total = sum(len(str(b.get("content", ""))) for _, b in blocks)

    return messages
```

**为什么只处理最后一条消息**：

```
只处理最后一条消息：
  ├─ 最后一条消息是当前工具调用的结果
  ├─ 可能刚产生大结果（cat 大文件）
  ├─ 需要立即处理
  └─ 旧的 tool_result 已经在 L2 处理

类比：
  ├─ 就像刚买的大件物品
  ├─ 最最近买的（最后一条）
  ├─ 可能太大放不下
  └─ 需要立即处理（落盘）
```

**为什么按大小排序，从最大的开始落盘**：

```
按大小排序：
  ├─ 大的结果占最多空间
  ├─ 先处理大的，效果最明显
  ├─ 可能只要处理 1-2 个就够了
  └─ 落盘效率最高

类比：
  ├─ 就像整理背包
  ├─ 先扔最大的物品
  ├─ 空间立即释放
  └─ 可能只要扔 1-2 个就够了
```

**落盘后的标记**：

```
<persisted-output>
Full output: .task_outputs/tool-results/{tool_use_id}.txt
Preview:
{output[:2000]}
</persisted-output>

标记的作用：
  ├─ 提示模型：完整内容在磁盘上
  ├─ 给出路径：可以重新读取
  ├─ 提供 preview：前 2000 字符
  └─ 模型可以看到部分内容

类比：
  ├─ 就像仓库里的物品
  ├─ 背包里只放索引卡（标记）
  ├─ 索引卡告诉你在哪个仓库（路径）
  ├─ 索引卡上有照片（preview）
  └─ 需要时可以去仓库取
```

### 5.4 L4: compact_history — LLM 全量摘要

**问题**：整体对话太大（30 分钟连续工作）

```
场景：
  前三层全跑完了
  但在超大项目中连续工作 30 分钟后
  token 仍然超过阈值

问题：
  ├─ 前三层无法"理解"对话内容
  ├─ 只是机械地裁剪和替换
  ├─ 可能裁剪不当
  └─ token 估算不准
```

**解决方案**：

```python
def write_transcript(messages):
    # 保存完整对话到磁盘（JSONL 格式）
    TRANSCRIPT_DIR.mkdir(parents=True, exist_ok=True)
    path = TRANSCRIPT_DIR / f"transcript_{int(time.time())}.jsonl"

    with path.open("w") as f:
        for msg in messages:
            f.write(json.dumps(msg, default=str) + "\n")

    return path

def summarize_history(messages):
    # LLM 生成摘要
    conversation = json.dumps(messages, default=str)[:80000]  # 截断到 80KB

    prompt = (
        "Summarize this coding-agent conversation so work can continue.\n"
        "Preserve: 1. current goal, 2. key findings/decisions, "
        "3. files read/changed, 4. remaining work, 5. user constraints.\n"
        "Be compact but concrete.\n\n" + conversation
    )

    response = client.messages.create(
        model=MODEL,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=2000
    )

    return extract_text(response.content).strip() or "(empty summary)"

def compact_history(messages):
    # 三步流程
    transcript_path = write_transcript(messages)  # 1. 写 transcript
    print(f"[transcript saved: {transcript_path}]")

    summary = summarize_history(messages)         # 2. LLM 生成摘要

    return [{"role": "user", "content": f"[Compacted]\n\n{summary}"}]  # 3. 替换消息
```

**三步流程**：

```
Step 1: 写 transcript
  ├─ 目的：保留完整对话记录
  ├─ 格式：JSONL（每行一条消息）
  ├─ 位置：.transcripts/transcript_{timestamp}.jsonl
  └─ 注意：写入的是压缩后的 messages（已经过 L3/L1/L2 处理）

Step 2: LLM 生成摘要
  ├─ 目的：提取关键信息
  ├─ 要求：保留 5 类关键信息
  │   ├─ current goal（当前目标）
  │   ├─ key findings/decisions（重要发现/决策）
  │   ├─ files read/changed（已改文件）
  │   ├─ remaining work（剩余工作）
  │   └─ user constraints（用户约束）
  └─ 输出：简洁但具体的摘要

Step 3: 替换 messages
  ├─ 目的：清空上下文，只保留摘要
  ├─ messages 被替换为一条摘要消息
  └─ 模型可以从摘要开始继续工作
```

**write_transcript 的作用**：

```
write_transcript 写入的是压缩后的 messages：
  ├─ 不是原始完整对话
  ├─ 包含占位符、截取标记、落盘标记
  └─ 已经经过 L3/L1/L2 处理

实际作用：
  ├─ 1. 保留压缩后的完整结构
  │      ├─ 包含占位符："[Earlier tool result compacted]"
  │      ├─ 包含截取标记："[snipped {N} messages]"
  │      ├─ 包含落盘标记：<persisted-output>
  │      └─ 可以理解压缩决策
  │
  ├─ 2. 调试和审计
  │      ├─ 查看 agent 做了什么
  │      ├─ 理解压缩决策
  │      └─ 分析 agent 行为
  │
  ├─ 3. 可恢复性（通过重新执行）
  │      ├─ 占位符提示可以重新执行
  │      ├─ 落盘的文件在磁盘上
  │      └─ 可以重新读取
  │
  └─ 4. 会话重启（如果崩溃）
         ├─ 恢复压缩后的状态
         ├─ 从摘要继续工作
         └─ 不完全丢失信息

为什么不是恢复原始对话？
  ├─ 原始完整对话太大（可能 200K+ tokens）
  ├─ 恢复后会立即超限
  ├─ 又要压缩
  └─ 循环往复，没有意义
```

**为什么保留这 5 类信息**：

```
关键信息的重要性：

current goal：
  ├─ Agent 正在做什么
  ├─ 任务目标是什么
  └─ 必须知道"要去哪里"

key findings/decisions：
  ├─ 已经发现了什么
  ├─ 已经做了什么决策
  └─ 避免重复工作

files read/changed：
  ├─ 已经读了哪些文件
  ├─ 已经改了哪些文件
  └─ 避免重复读/改

remaining work：
  ├─ 还剩什么要做
  ├─ 下一步计划
  └─ 继续工作

user constraints：
  ├─ 用户的要求
  ├─ 用户18的限制
  └─ 遵守用户意愿
```

### 5.5 应急: reactive_compact

**问题**：API 返回 prompt_too_long

```
场景：
  前三层都跑了
  L4 也跑了
  但 API 还是返回 prompt_too_long

原因：
  ├─ 上下文增长速度快于压缩触发速度
  ├─ token 估算不准（教学版用字符数）
  ├─ L4 摘要后仍可能超限
  └─ 需要更激进的处理
```

**解决方案**：

```python
def reactive_compact(messages):
    # 更激进的截断

    # 1. 写 transcript（保存完整对话）
    transcript = write_transcript(messages)

    # 2. LLM 生成摘要
    summary = summarize_history(messages)

    # 3. 更激进的截断（只保留尾部 5 条）
    tail_start = max(0, len(messages) - 5)

    # 边界条件：不能拆开 tool_use 和 tool_result
    if (tail_start > 0 and tail_start < len(messages)
            and _is_tool_result_message(messages[tail_start])
            and _message_has_tool_use(messages[tail_start - 1])):
        tail_start -= 1

    # 4. 替换
    return [
        {"role": "user", "content": f"[Reactive compact]\n\n{summary}"},
        *messages[tail_start:]  # 保留尾部
    ]
```

**与 compact_history 的区别**：

```
compact_history：
  ├─ 激进程度：中等
  ├─ 保留内容：只有摘要
  ├─ 丢弃内容：所有旧消息
  └─ 适用场景：主动触发（阈值检查）

reactive_compact：
  ├─ 激进程度：更高
  ├─ 保留内容：摘要 + 尾部 5 条消息
  ├─ 丢弃内容：前面的大部分消息
  └─ 适用场景：被动触发（API 报错）
```

**为什么保留尾部 5 条**：

```
尾部 5 条的重要性：
  ├─ 最最近的工作状态
  ├─ 可能包含正在进行的工具调用
  │      ├─ assistant: tool_use（刚调用的工具）
  │      └─ user: tool_result（刚返回的结果）
  ├─ 保留可以立即继续工作
  └─ 不需要重新执行工具
```

**熔断机制**：

```python
MAX_REACTIVE_RETRIES = 1  # 重试上限

# 在 agent_loop 中
try:
    response = client.messages.create(...)
    reactive_retries = 0  # 成功后重置
except Exception as e:
    if ("prompt_too_long" in str(e).lower()
            and reactive_retries < MAX_REACTIVE_RETRIES):
        print("[reactive compact]")
        messages[:] = reactive_compact(messages)
        reactive_retries += 1
        continue  # 重试
    raise  # 超过重试上限，抛出异常
```

---

## 六、完整执行流程（agent_loop）

```python
def agent_loop(messages: list):
    reactive_retries = 0

    while True:
        # ===== 前三层预处理器（0 API 调用）=====

        # L3: 大结果落盘（先跑，确保完整内容落盘）
        messages[:] = tool_result_budget(messages)

        # L1: 裁中间消息
        messages[:] = snip_compact(messages)

        # L2: 旧结果占位
        messages[:] = micro_compact(messages)

        # ===== 检查阈值 =====

        if estimate_size(messages) > CONTEXT_LIMIT:
            print("[auto compact]")
            # L4: LLM 全量摘要
            messages[:] = compact_history(messages)

        # ===== 调用 LLM =====

        try:
            response = client.messages.create(
                model=MODEL, system=SYSTEM,
                messages=messages, tools=TOOLS,
                max_tokens=8000
            )
            reactive_retries = 0  # 成功后重置熔断器

        except Exception as e:
            # ===== 应急处理 =====

            if ("prompt_too_long" in str(e).lower()
                    and reactive_retries < MAX_REACTIVE_RETRIES):
                print("[reactive compact]")
                messages[:] = reactive_compact(messages)
                reactive_retries += 1
                continue  # 重试

            raise  # 超过重试上限，抛出异常

        # ===== 处理响应 =====

        messages.append({"role": "assistant", "content": response.content})

        if response.stop_reason != "tool_use":
            return  # 对话结束

        # ===== 执行工具 =====

        results = []
        for block in response.content:
            if block.type != "tool_use":
                continue

            print(f"\033[36m> {block.name}\033[0m")

            # 特殊工具：compact
            if block.name == "compact":
                messages[:] = compact_history(messages)
                results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": "[Compacted. Conversation history has been summarized.]"
                })
                messages.append({"role": "user", "content": results})
                break  # 结束当前 turn

            # 其他工具
            blocked = trigger_hooks("PreToolUse", block)
            if blocked:
                results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": str(blocked)
                })
                continue

            handler = TOOL_HANDLERS.get(block.name)
            output = handler(**block.input) if handler else f"Unknown: {block.name}"

            trigger_hooks("PostToolUse", block, output)
            print(str(output)[:200])

            results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": str(output)
            })

        else:
            # 正常工具执行完成
            messages.append({"role": "user", "content": results})
            continue

        # compact 工具执行完成，已经 break
        continue
```

---

## 七、教学版 vs CC 对比（关键差异）

### 7.1 教学版的简化与局限

**教学版的设计目的**：

```
教学版的目标：
  ├─ 展示核心概念
  ├─ 易于理解
  ├─ 可运行演示
  └─ 不追求生产级精确性
```

**关键简化点**：

```
1. token 估算：
   教学版：len(str(msgs))（字符数）
   CC：精确 token 计算

2. compact_history 摘要：
   教学版：5 类信息 + 简单 prompt
   CC：9 个部分 + 双重防呆 prompt

3. 后压缩恢复：
   教学版：无（只保留摘要）
   CC：自动重新读取最近文件

4. reactive_compact：
   教学版：简单逻辑（摘要 + 尾部 5 条）
   CC：分级截断 + truncateHeadForPTLRetry
```

### 7.2 教学版的逻辑缺陷分析

**问题 1：token 估算不准确**

```python
# 教学版
def estimate_size(msgs):
    return len(str(msgs))  # 用字符数估算

问题：
  ├─ 字符数 ≠ token 数
  ├─ 可能估算偏小，跳过 compact_history
  ├─ 实际超限，API 报错
  └─ 需要 reactive_compact

# CC
token_count = count_tokens(messages)  # 精确计算
threshold = contextWindow - maxOutputTokens - 13_000  # 精确阈值
```

**问题 2：compact_history 后还报错的场景**

```
场景分析：

情况 A：估算不准，跳过 compact_history
  ├─ 前三层处理后，estimate_size < CONTEXT_LIMIT
  ├─ 跳过 compact_history
  ├─ 实际 token 超限
  ├─ API 报错
  ├─ messages 还是预处理后的完整 messages
  ├─ reactive_compact 对完整 messages 摘要 + 保留尾部 5 条
  └─ 逻辑正确 ✓

情况 B：compact_history 后还报错（教学版的缺陷）
  ├─ compact_history 后 messages = [摘要]
  ├─ len(messages) = 1
  ├─ 调用 LLM 还是报错
  ├─ reactive_compact(messages)
  │      ├─ summary = summarize_history([摘要])  # 对摘要再做摘要？
  │      ├─ tail_start = max(0, 1-5) = 0
  │      ├─ messages[tail_start:] = 整个 messages（即摘要）
  │      └─ 结果：[摘要的摘要] + [原摘要]
  │      └─ 还会超限 ❌
  └─ 逻辑有问题

问题根源：
  ├─ 教学版用字符数估算，摘要后字符数可能还是很大
  ├─ CC 用精确 token + max_tokens=2000，摘要肯定不会超限
  └─ 教学版的简化导致逻辑缺陷
```

### 7.3 CC 的真实实现（生产级）

#### 7.3.1 compact_history 的差异

**摘要要求**：

```
教学版：
  ├─ 5 类信息
  │   ├─ current goal
  │   ├─ key findings/decisions
  │   ├─ files read/changed
  │   ├─ remaining work
  │   └─ user constraints
  └─ 简单 prompt

CC：
  ├─ 9 个部分
  │   ├─ current goal
  │   ├─ recent progress
  │   ├─ recent errors
  │   ├─ files read/changed
  │   ├─ remaining work
  │   ├─ user constraints
  │   ├─ important decisions
  │   ├─ agent/skill/tool usage
  │   └─ external interactions
  └─ 更全面的摘要要求
```

**压缩 prompt**：

```
教学版：
  简单 prompt：
    "Summarize this coding-agent conversation so work can continue.
     Preserve: 1. current goal, 2. key findings/decisions,
     3. files read/changed, 4. remaining work, 5. user constraints.
     Be compact but concrete."

CC：
  双重防呆 prompt：

    CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

    Summarize the conversation so work can continue.

    First, write your analysis inside <analysis> tags:
    - Current goal
    - Recent progress
    - ...

    Then, write your summary inside <summary> tags:
    - ...
    - ...

    REMINDER: Do NOT call any tools.

  双重防呆：
    ├─ 开头：CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
    ├─ 要求：先在 <analysis> 标签里理清思路
    ├─ 要求：然后在 <summary> 标签里输出正式摘要
    ├─ 末尾：REMINDER: Do NOT call any tools.
    └─ 防止模型调用工具（可能导致无限循环）
```

**后压缩恢复**：

```
教学版：
  ├─ 无后压缩恢复
  ├─ 只保留摘要
  └─ 模型需要重新读取文件

CC：
  ├─ 自动重新读取最近文件
  │      ├─ 分析摘要中的 files read/changed
  │      ├─ 选择最近读取/修改的文件（最多 5 个）
  │      ├─ 每个文件最多 5K token
  │      ├─ 总预算 50K token
  │      └─ 自动添加到 messages
  │
  ├─ 目的：
  │      ├─ 自动恢复工作状态
  │      ├─ 不需要重新执行工具
  │      ├─ 模型可以立即继续工作
  │      └─ 减少重复操作
  │
  └─ 实现步骤：
         ├─ 1. compact_history 完成
         ├─ 2. 分析摘要中的文件列表
         ├─ 3. 选择最近 5 个文件
         ├─ 4. 读取文件内容（每个最多 5K token）
         ├─ 5. 添加到 messages
         └─ 6. 继续工作
```

#### 7.3.2 reactive_compact 的差异

**CC 的分级截断**：

```
教学版：
  ├─ reactive_compact 简单逻辑
  ├─ 摘要 + 保留尾部 5 条
  ├─ 重试上限 1 次
  └─ 不分级

CC：
  ├─ truncateHeadForPTLRetry()
  │      ├─ 按消息组回退
  │      ├─ 逐步截断
  │      └─ 确保最终成功
  │
  ├─ reactive 更精细分级
  │      ├─ 第一次报错：截断到最近 10 条
  │      ├─ 第二次报错：截断到最近 5 条
  │      ├─ 第三次报错：截断到最近 1 条
  │      └─ 确保最终成功
  │
  └─ 逻辑：
         ├─ 不再做摘要（摘要已经是精简后的）
         ├─ 直接截断（truncateHeadForPTLRetry）
         ├─ 逐步减少保留的消息数
         └─ 确保最终能成功
```

**为什么 CC 不做二次摘要**：

```
CC 的理解：
  ├─ compact_history 后，messages 已经是摘要
  ├─ 摘要已经很精简（max_tokens=2000）
  ├─ 再做摘要没有意义（信息丢失严重）
  ├─ 摘要的摘要可能还是超限（如果摘要本身就大）
  └─ 直接截断更有效

正确的逻辑：
  ├─ 如果 compact_history 后还报错
  ├─ 不再做摘要
  ├─ 直接截断（truncateHeadForPTLRetry）
  ├─ 逐步减少保留的消息数
  └─ 确保最终成功

教学版的缺陷：
  ├─ reactive_compact 还会对摘要做摘要
  ├─ len(messages) = 1 时，tail_start = 0
  ├─ messages[tail_start:] = 整个 messages
  ├─ 结果：[摘要的摘要] + [原摘要]
  └─ 还会超限 ❌
```

#### 7.3.3 token 计算的差异

**教学版**：

```python
def estimate_size(msgs):
    return len(str(msgs))  # 字符数

CONTEXT_LIMIT = 50000  # 字符数阈值

问题：
  ├─ 字符数 ≠ token 数
  ├─ 英文：1 token ≈ 4 chars
  ├─ 中文：1 token ≈ 1-2 chars
  ├─ 代码：1 token ≈ 2-3 chars
  └─ 估算不准确
```

**CC**：

```python
# 精确 token 计算
token_count = count_tokens(messages)

# 精确阈值
threshold = contextWindow - maxOutputTokens - 13_000

# 例如：
# contextWindow = 200_000
# maxOutputTokens = 8_192
# threshold = 200_000 - 8_192 - 13_000 = 178_808 tokens

# compact_history 摘要的 max_tokens
response = client.messages.create(..., max_tokens=2000)

# 摘要肯定不会超过 2000 tokens
# 加上 system prompt，也不会超限
```

#### 7.3.4 其他差异

```
| 方面 | 教学版（s08） | 生产版（CC） |
|------|--------------|-------------|
| 执行顺序 | budget → snip → micro → auto | budget → snip → micro → collapse → auto |
| snip_compact | 保留头 3 + 尾 47 | CC 仅主线程启用；实现不在开源仓库 |
| micro_compact | 按位置（最近 3 条） | time-based（60分钟）+ cached（按计数） |
| tool_result_budget | 200KB 字符 | 200,000 字符（toolLimits.ts:49） |
| compact_history 阈值 | 字符数估算 | 精确 token：contextWindow - maxOutputTokens - 13,000 |
| 摘要要求 | 5 类信息 | 9 个部分 + <analysis>/<summary> 双标签 |
| 压缩 prompt | 简单 prompt | 首尾双重防呆禁止调工具 |
| 后压缩恢复 | 无（只保留摘要） | 自动重新读取最近文件（5个，每个5K，总50K） |
| contextCollapse | 无 | 独立的上下文管理系统 |
| sessionMemoryCompact | 无 | compact前先尝试用 session memory 做轻量摘要 |
| PTL retry | 有（简化） | truncateHeadForPTLRetry() 按消息组回退 |
| 熔断器 | reactive 1 次，auto 3 次 | reactive 更精细分级，auto 3 次 |
```

---

## 八、关键设计决策

### 8.1 为什么顺序不能换？

```
顺序：
  L3: tool_result_budget（大结果落盘）
  ↓
  L1: snip_compact（裁中间）
  ↓
  L2: micro_compact（旧结果占位）

为什么不能换？

错误顺序示例：
  L2 → L3 → L1

  问题：
    ├─ L2 先跑，大 tool_result 被替换成占位符
    ├─ L3 再跑，完整内容已经丢失
    ├─ L3 无法把完整内容落盘
    └─ 大文件内容永久丢失 ❌

正确顺序：
  ├─ L3 先跑：把大 tool_result 的完整内容落盘
  ├─ L2 再跑：把落盘后的内容替换成占位符
  ├─ 占位符包含 <persisted-output> 标记 + 磁盘路径
  └─ 模型可以重新读取完整内容 ✓
```

### 8.2 为什么需要 compact 工具？

```
compact 工具：
  ├─ 模型主动调用 compact 工具
  ├─ 触发 compact_history（L4）
  ├─ 模型可以主动控制压缩时机
  └─ 不被动等待阈值触发

为什么需要主动控制？
  ├─ 模型可能知道"这段对话不重要了"
  ├─ 模型可以主动压缩，释放空间
  ├─ 避免被动触发（可能更激进）
  └─ 更精细的上下文控制

类比：
  ├─ 被动压缩：背包满了自动报警
  ├─ 主动压缩：自己决定什么时候整理
  └─ 更灵活的控制
```

### 8.3 为什么需要熔断机制？

```
熔断机制：
  ├─ L4 熔断器：连续失败 3 次后停止重试
  ├─ reactive 熔断器：重试上限 1 次

为什么需要？
  ├─ 避免 API 调用死循环
  ├─ 避免 cost失控
  ├─ 避免时间浪费
  └─ 最终失败交给后续错误处理

类比：
  ├─ 就像保险丝
  ├─ 电流过大时自动断开
  ├─ 保护系统不被烧毁
  └─ 避免灾难性后果
```

### 8.4 为什么需要 transcript？

```
transcript：
  ├─ 保存完整对话（JSONL 格式）
  ├─ 写入 .transcripts/ 目录
  ├─ 时间戳命名：transcript_{timestamp}.jsonl
  └─ 注意：写入的是压缩后的 messages

为什么需要？
  ├─ 防止信息丢失（压缩后的状态）
  ├─ 如果需要，可以恢复压缩后的状态
  ├─ 调试：可以查看完整历史
  └─ 审计：记录所有操作

类比：
  ├─ 就像备份
  ├─ 原文件压缩了（摘要）
  ├─ 但备份保留完整内容（压缩后的）
  └─ 需要时可以恢复
```

---

## 九、类比理解总结

```
四层压缩：

背包整理类比：
  ├─ L1 snip：扔掉中间的旧日志
  │   ├─ 保留开头（出发时间、目的地）
  │   ├─ 保留结尾（当前位置、下一步）
  │   └─ 裁掉中间（已经走过的路）
  │
  ├─ L2 micro：把旧物品的照片扔掉
  │   ├─ 保留最近 3 个物品（还在用）
  │   ├─ 旧物品扔掉照片（占位符）
  │   └─ 需要时可以重新买
  │
  ├─ L3 budget：大件物品放仓库
  │   ├─ 大件物品放不下
  │   ├─ 放仓库（落盘）
  │   ├─ 背包里放索引卡（标记）
  │   ├─ 索引卡告诉你在哪个仓库
  │   └─ 需要时去仓库取
  │
  └─ L4 auto：买新背包（LLM 摘要）
  │   ├─ 前三层都不够
  │   ├─ 整理不过来了
  │   ├─ 买新背包（LLM 摘要）
  │   └─ 保留摘要（关键信息）

──────────────────────────────────────────────────────────

顺序的重要性：

类比：
  ├─ L3 先跑：大件物品先放仓库
  │   ├─ 如果先扔照片（L2）
  │   ├─ 大件物品的照片被扔了
  │   ├─ 不知道大件物品在哪
  │   └─ 大件物品永久丢失 ❌
  │
  ├─ L2 再跑：扔旧物品的照片
  │   ├─ 大件物品已经放仓库
  │   ├─ 照片上有仓库地址
  │   ├─ 扔照片没关系
  │   └─ 知道大件物品在哪 ✓
  │
  └─ L1 最后：裁中间日志
  │   ├─ 已经处理了物品和照片
  │   └─ 裁日志不影响物品

──────────────────────────────────────────────────────────

应急处理：

类比：
  ├─ 正常整理不够（前三层）
  ├─ 背包爆炸（API 报错）
  ├─ 紧急抛弃（reactive）
  │   ├─ 抛弃大部分物品
  │   ├─ 保留最近 5 个物品
  │   └─ 确保能继续工作
  └─ 熔断机制：不能无限重试
```

---

## 十、关键要点总结

1. **四层压缩管线**：
   - L1: snip_compact（裁中间消息）
   - L2: micro_compact（旧结果占位）
   - L3: tool_result_budget（大结果落盘）
   - L4: compact_history（LLM 摘要）

2. **核心设计原则**："便宜的先跑，贵的后跑"

3. **顺序不能换**：budget → snip → micro（先落盘，再占位）

4. **触发时机**：
   - 主动：每轮前 + 阈值检查 + compact 工具
   - 被动：API 报错 prompt_too_long

5. **熔断机制**：防止死循环浪费 API

6. **transcript**：保存压缩后的 messages，用于调试/审计/恢复

7. **边界条件**：不能拆开 tool_use 和 tool_result

8. **教学版 vs CC 的关键差异**：
   - token 估算：字符数 vs 精确 token
   - compact_history：5 类信息 vs 9 个部分 + 双重防呆
   - 后压缩恢复：无 vs 自动重新读取最近文件
   - reactive_compact：简单逻辑 vs 分级截断
   - 教学版有逻辑缺陷（compact_history 后还报错的场景）

9. **CC 的真实实现**：
   - 精确 token 计算，不会估算不准
   - 分级截断（truncateHeadForPTLRetry），不做二次摘要
   - 后压缩恢复，自动恢复工作状态

---

## 十一、与前后章节的衔接

```
s07 Skill Loading：
  ├─ 按需加载知识
  ├─ "不该提前带的不要带"
  └─ 防止上下文被知识占满

s08 Context Compact：
  ├─ 压缩旧上下文
  ├─ "该丢的怎么丢"
  └─ 防止上下文被历史占满

s09 Memory：
  ├─ 有选择地记住重要的事
  ├─ "什么该记住"
  └─ 防止摘要丢失关键信息

三者衔接：
  ├─ s07：防止知识占满
  ├─ s08：防止历史占满
  └─ s09：防止摘要丢失关键信息
  └─ 共同目标：干净的记忆，无限的会话
```

---

## 十二、核心哲学

```
便宜的先跑 + 贵的后跑 + 顺序不能换 + 熔断保护 + 保留备份

这就是 ClaudeCode Context Compact 的完整设计理念。

教学版的启示：
  ├─ 展示核心概念，易于理解
  ├─ 但简化带来逻辑缺陷
  ├─ 生产级需要精确计算 + 分级处理 + 后压缩恢复
  └─ CC 的真实实现更复杂、更严谨
```

---

<!-- 文档版本：v2.0 -->
<!-- 更新时间：2026-06-23 -->
<!-- 基于 s08 教学版和 CC 源码的深度分析 + 教学版与 CC 差异的完整梳理 -->
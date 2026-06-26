# s14 Cron Scheduler 深度解析

## 一、核心问题与解决思路

### 1.1 问题场景

**闹钟的类比**：
- ❌ **错误做法**：盯着闹钟，等它到 7:00 才响
- ✅ **正确做法**：设好 7:00，去睡觉、洗澡、做饭，到点闹钟自动响

s13 Background Tasks 的局限：
```
s13: 后台执行慢操作
  - 但所有操作仍然需要用户手动触发
  - 用户说一句，Agent 动一下
  - "每天早上 9 点跑测试" → 需要用户每天早上手动输入
  
s14: 定时自动触发
  - 不需要用户每次来推
  - 调度器自动在指定时间触发
  - "每 30 分钟检查 CI 状态" → 调度器自动触发
```

### 1.2 设计哲学

**核心原则**：
1. **调度与执行解耦** - 调度器只管时间判断，不管执行
2. **独立线程运行** - 不依赖 agent_loop 是否在执行
3. **队列传递触发** - 生产者-消费者模式解耦
4. **持久化可选** - durable 跨重启，session-only 进程内

---

## 二、架构设计

### 2.1 四层模型

```
┌─────────────────────────────────────────────────────────────┐
│                     Layer 1: Scheduler                       │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ cron_scheduler_loop (daemon thread)                  │   │
│  │   - 每 1 秒轮询                                       │   │
│  │   - cron_matches 判断时间是否匹配                     │   │
│  │   - 匹配 → 写入 cron_queue                           │   │
│  │   - 不依赖 agent_loop 是否在运行                      │   │
│  └──────────────────────────────────────────────────────┘   │
│                          │                                   │
│                          ▼                                   │
│                     Layer 2: Queue                           │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ cron_queue (线程安全列表)                            │   │
│  │   - 调度线程写入（生产者）                            │   │
│  │   - queue processor 交付                             │   │
│  │   - agent_loop 消费（消费者）                         │   │
│  │   - 解耦生产者和消费者                                │   │
│  └──────────────────────────────────────────────────────┘   │
│                          │                                   │
│                          ▼                                   │
│                Layer 3: Queue Processor                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ queue_processor_loop (daemon thread)                 │   │
│  │   - 每 0.2 秒检查队列                                 │   │
│  │   - 检查 Agent 是否空闲（agent_lock）                │   │
│  │   - 空闲且有任务 → 启动 agent_loop                   │   │
│  │   - 自动交付定时任务                                  │   │
│  └──────────────────────────────────────────────────────┘   │
│                          │                                   │
│                          ▼                                   │
│                   Layer 4: Consumer                          │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ agent_loop                                           │   │
│  │   - consume_cron_queue() 从队列拿任务                │   │
│  │   - 注入到 messages                                   │   │
│  │   - "[Scheduled] {job.prompt}"                       │   │
│  │   - LLM 收到消息，执行操作                            │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 数据结构

```python
@dataclass
class CronJob:
    id: str              # 唯一标识 "cron_123456"
    cron: str            # 五段式 cron 表达式 "0 9 * * *"
    prompt: str          # 触发时注入给 Agent 的消息
    recurring: bool      # True=周期性，False=一次性
    durable: bool        # True=写磁盘，False=仅内存
    
# 全局状态
scheduled_jobs: dict[str, CronJob] = {}  # 已注册任务
cron_queue: list[CronJob] = []           # 已触发待交付任务
cron_lock = threading.Lock()             # 线程安全锁
agent_lock = threading.Lock()            # Agent 空闲判断
_last_fired: dict[str, str] = {}         # 防止重复触发
```

### 2.3 手动触发 vs 定时触发

| 维度 | 手动触发 (s13) | 定时触发 (s14) |
|------|---------------|---------------|
| **触发者** | 用户输入 | 调度线程 |
| **触发时机** | 随时 | cron 表达式指定 |
| **需要人参与** | 是 | 否（调度器自动入队） |
| **持久性** | — | durable 跨重启 |
| **Agent 空闲** | 立即响应 | queue processor 等空闲 |

---

## 三、实现细节

### 3.1 Cron 表达式：五段式匹配

```python
# 标准 Unix cron 表达式
分钟  小时  日  月  星期
  *    *   *   *   *      # 每分钟
  0    9   *   *   *      # 每天早上 9:00
 */5    *   *   *   *      # 每 5 分钟
  0    9   *   *  1-5     # 工作日早上 9:00
  
# 支持格式：
# *       - 任意值
# */N     - 每 N 单位
# N       - 具体值
# N-M     - 范围
# N,M,... - 列表
```

**关键语义：DOM 和 DOW 用 OR**

```python
def cron_matches(cron_expr: str, dt: datetime) -> bool:
    """检查 cron 表达式是否匹配当前时间"""
    fields = cron_expr.strip().split()
    minute, hour, dom, month, dow = fields
    
    # 分钟、小时、月必须全部匹配
    m = _cron_field_matches(minute, dt.minute)
    h = _cron_field_matches(hour, dt.hour)
    month_ok = _cron_field_matches(month, dt.month)
    
    if not (m and h and month_ok):
        return False
    
    # DOM 和 DOW：如果两者都被约束，任一匹配即可（OR）
    dom_unconstrained = dom == "*"
    dow_unconstrained = dow == "*"
    
    if dom_unconstrained and dow_unconstrained:
        return True  # 两者都未约束，直接返回
    if dom_unconstrained:
        return dow_ok  # 只有星期被约束
    if dow_unconstrained:
        return dom_ok  # 只有日期被约束
    return dom_ok or dow_ok  # 两者都被约束，OR 语义
```

**为什么用 OR？**
```
场景："每月 15 日或每周一早上 9 点"

如果用 AND：
  - 必须是 15 日且是周一 → 很少触发
  
如果用 OR（标准 Unix cron）：
  - 15 日早上 9 点 → 触发
  - 周一早上 9 点 → 触发
  - 更符合直觉
```

---

### 3.2 独立调度线程：每秒轮询

```python
def cron_scheduler_loop():
    """独立 daemon 线程，每 1 秒检查一次"""
    while True:
        time.sleep(1)
        now = datetime.now()
        
        # Date-aware marker：防止重复触发
        minute_marker = now.strftime("%Y-%m-%d %H:%M")
        
        with cron_lock:
            for job in list(scheduled_jobs.values()):
                try:
                    # 判断时间是否匹配
                    if cron_matches(job.cron, now):
                        # 防止同一分钟重复触发
                        if _last_fired.get(job.id) != minute_marker:
                            # 写入队列（生产者）
                            cron_queue.append(job)
                            _last_fired[job.id] = minute_marker
                            
                        # 一次性任务：触发后删除
                        if not job.recurring:
                            scheduled_jobs.pop(job.id, None)
                            if job.durable:
                                save_durable_jobs()
                except Exception as e:
                    # 单 job 异常不杀掉整个线程
                    print(f"[cron error] {job.id}: {e}")
```

**关键设计**：
1. **独立于 agent_loop**：即使 agent_loop 没运行，调度器也在后台检查
2. **date-aware minute_marker**：
   ```python
   # 使用 "YYYY-MM-DD HH:MM" 格式
   # 防止同一分钟重复触发
   # 同时不会在第二天跳过（date-aware）
   
   # 错误做法：只用 "HH:MM"
   # 问题：第二天同一时间会跳过（因为 _last_fired 还记得昨天）
   
   # 正确做法：用 "YYYY-MM-DD HH:MM"
   # 每天都是新的 marker，不会跳过
   ```
3. **单 job try/except**：一个坏 job 不会拖垮整个调度线程
4. **一次性任务自动删除**：触发后立即从 scheduled_jobs 移除

---

### 3.3 Queue Processor：自动交付

```python
def queue_processor_loop():
    """自动交付定时任务，当 Agent 空闲时"""
    while True:
        time.sleep(0.2)  # 每 0.2 秒检查
        
        # 检查队列是否有任务
        if not has_cron_queue():
            continue
        
        # 检查 Agent 是否空闲
        if not agent_lock.acquire(blocking=False):
            continue  # Agent 正在工作，等待
        
        try:
            # 再次检查（防止竞态）
            if not has_cron_queue():
                continue
            
            # 自动启动一轮 agent_loop
            print("[queue processor] delivering scheduled work")
            run_agent_turn_locked()
        finally:
            agent_lock.release()
```

**关键设计**：
- **agent_lock**：判断 Agent 是否空闲
  - `agent_lock.acquire(blocking=False)` → 非阻塞尝试
  - 成功 → Agent 空闲，可以启动新轮次
  - 失败 → Agent 正在工作，等待
- **双重检查**：防止竞态条件
  ```python
  # 第一次检查：has_cron_queue()
  # 第二次检查：获取 agent_lock 后再检查
  # 防止：检查时有任务 → 获取锁 → 任务已被消费
  ```

---

### 3.4 Agent Loop 消费队列

```python
def agent_loop(messages: list, context: dict):
    """Layer 4: 消费已触发的任务"""
    while True:
        # 消费 cron_queue
        fired = consume_cron_queue()
        for job in fired:
            # 注入到 messages
            messages.append({
                "role": "user",
                "content": f"[Scheduled] {job.prompt}"
            })
            print(f"[inject cron] {job.prompt}")
        
        # 调用 LLM
        response = client.messages.create(...)
        
        # ... 执行工具 ...
```

**消费者逻辑**：
- ✅ 不负责检查时间（这是调度线程的事）
- ✅ 只从 cron_queue 拿已触发的任务
- ✅ 注入到 messages，格式为 `[Scheduled] {job.prompt}`
- ✅ LLM 收到消息，执行相应操作

---

### 3.5 Durable vs Session-only

```python
# Durable（持久化）
# - 任务定义写入 .scheduled_tasks.json
# - Agent 重启后加载文件，恢复任务
# - 下次启动时调度器才会发现"该触发了"

# Session-only（仅会话）
# - 只在内存里
# - Agent 关闭就没了
# - 适合临时任务

def save_durable_jobs():
    """持久化 durable 任务"""
    durable = [asdict(j) for j in scheduled_jobs.values() if j.durable]
    DURABLE_PATH.write_text(json.dumps(durable, indent=2))

def load_durable_jobs():
    """启动时从磁盘加载"""
    if not DURABLE_PATH.exists():
        return
    jobs = json.loads(DURABLE_PATH.read_text())
    for j in jobs:
        job = CronJob(**j)
        # 校验 cron 表达式（防止坏任务）
        err = validate_cron(job.cron)
        if err:
            print(f"[cron] skipping invalid job {job.id}: {err}")
            continue
        scheduled_jobs[job.id] = job
```

**重要前提**：
```
Cron 调度器必须在 Agent 进程内跑
  - 进程关闭 → 调度也停
  - Durable 只意味着任务定义跨重启保留
  - 下次 Agent 启动时调度器才会触发
  
如果需要"即使应用关闭也能定时跑"：
  - 使用系统 crontab
  - 或 systemd timer
```

---

### 3.6 校验：防止坏 cron 杀掉调度器

```python
def validate_cron(cron_expr: str) -> str | None:
    """校验 cron 表达式，返回错误消息或 None"""
    fields = cron_expr.strip().split()
    if len(fields) != 5:
        return f"Expected 5 fields, got {len(fields)}"
    
    # 校验每个字段范围
    bounds = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 6)]
    names = ["minute", "hour", "day-of-month", "month", "day-of-week"]
    
    for i, (field, (lo, hi), name) in enumerate(zip(fields, bounds, names)):
        err = _validate_cron_field(field, lo, hi)
        if err:
            return f"{name}: {err}"
    
    return None

def schedule_job(cron: str, prompt: str, recurring: bool, durable: bool):
    """注册前先校验"""
    err = validate_cron(cron)
    if err:
        return err  # 直接返回错误，不注册
    # ... 注册 job
```

**为什么校验重要？**
- ✅ 防止非法表达式导致 cron_matches 抛异常
- ✅ 防止坏任务拖垮整个调度线程
- ✅ 从磁盘加载时也会校验，跳过坏任务

---

## 四、完整执行流程

### 4.1 启动流程

```python
if __name__ == "__main__":
    # 1. 加载持久化任务
    load_durable_jobs()
    
    # 2. 启动调度线程
    threading.Thread(target=cron_scheduler_loop, daemon=True).start()
    print("[cron] scheduler thread started")
    
    # 3. 启动 queue processor 线程
    threading.Thread(target=queue_processor_loop, daemon=True).start()
    print("[queue processor] started")
    
    # 4. 主循环等待用户输入
    while True:
        query = input("s14 >> ")
        if query in ("q", "exit", ""):
            break
        with agent_lock:
            run_agent_turn_locked(query)
```

### 4.2 注册任务

```python
用户输入："每 2 分钟打印日期"

Agent → schedule_cron(cron="*/2 * * * *", prompt="run date")

1. validate_cron 校验表达式
2. 创建 CronJob:
   {
     id: "cron_123456",
     cron: "*/2 * * * *",
     prompt: "run date",
     recurring: True,
     durable: True
   }
3. 写入 scheduled_jobs
4. durable=True → save_durable_jobs()
```

### 4.3 自动触发流程

```
T=0s: Agent Loop 返回（stop_reason="end_turn")
      Agent 空闲（agent_lock 可获取）

T=120s: 时间到达 2 分钟后
        调度线程：cron_matches("*/2 * * * *", now) → True
        写入 cron_queue（生产者）
        
T=120s+0.2s: queue processor 检查
             has_cron_queue() → True
             agent_lock.acquire() → 成功（Agent 空闲）
             自动启动 agent_loop（消费者）
             
Agent Loop:
             consume_cron_queue() →拿到任务
             messages.append("[Scheduled] run date")
             LLM 收到消息 → bash "date"
             打印当前时间
```

---

## 五、关键设计细节

### 5.1 线程模型

```
教学版：3 个线程

Thread 1: cron_scheduler_loop (daemon)
  - 每 1 秒轮询
  - 判断时间匹配
  - 写入 cron_queue
  
Thread 2: queue_processor_loop (daemon)
  - 每 0.2 秒检查队列
  - 检查 Agent 空闲
  - 自动启动 agent_loop
  
Thread 3: 主线程（用户输入 + agent_loop）
  - 等待用户输入
  - 或响应 queue processor 的自动触发
```

### 5.2 锁的作用

```python
cron_lock:
  - 保护 scheduled_jobs
  - 保护 cron_queue
  - 保护 _last_fired
  - 生产者（调度线程）和消费者（agent_loop）共享
  
agent_lock:
  - 判断 Agent 是否空闲
  - queue processor 用它决定是否启动新轮次
  - 防止多个 agent_loop 并发
```

### 5.3 daemon 线程

```python
threading.Thread(target=cron_scheduler_loop, daemon=True)
threading.Thread(target=queue_processor_loop, daemon=True)

# daemon=True 的作用：
# - Agent 进程退出时，线程跟着退出
# - 避免孤儿线程
```

---

## 六、生产版差异

### 6.1 教学版 vs 生产版

| 特性 | 教学版 | 生产版 |
|------|--------|--------|
| **调度频率** | 1 秒 | 1 秒 |
| **队列检查** | 0.2 秒 | 更智能 |
| **抖动** | ❌ 无 | ✅ 防惊群效应 |
| **自动过期** | ❌ 无 | ✅ 7 天 |
| **任务上限** | ❌ 无 | ✅ 50 个 |
| **文件锁** | ❌ 无 | ✅ 防多 session 重复触发 |
| **持久化** | ✅ JSON 文件 | ✅ JSON 文件 |
| **UI 阻塞** | ❌ 无 | ✅ 处理 UI 交互 |
| **优先级** | ❌ 无 | ✅ 队列优先级 |
| **QoS** | ❌ 无 | ✅ API 容量紧张时降级 |

### 6.2 生产版的高级特性

#### A. 抖动（防惊群效应）
```typescript
// 生产版：防止大量任务同一时间触发
// - 重复性任务：延迟最多 10% 的期间（上限 15 分钟）
// - 基于 job ID 的确定性哈希
// - 一次性任务：在 :00 或 :30 时最多提前 90 秒触发
```

#### B. 自动过期
```typescript
// 重复性任务 7 天后自动过期
// 可配置，上限 30 天
// 过期前最后一次触发，触发后自动删除
```

#### C. 任务上限
```typescript
// MAX_JOBS = 50
// 超限时返回错误："Too many scheduled jobs (max 50)"
```

#### D. 文件锁
```typescript
// .scheduled_tasks.lock 文件
// 防止同项目的多个 session 重复触发
// 只有持有锁的 session 才触发 durable 任务
```

---

## 七、常见问题与陷阱

### 7.1 重复触发问题

**问题**：同一分钟内多次触发

**原因**：
```python
# 错误做法：只用 "HH:MM"
minute_marker = now.strftime("%H:%M")

# 问题：
# - 第一天 9:00 触发，_last_fired["job_id"] = "09:00"
# - 第二天 9:00，检查 _last_fired["job_id"] == "09:00"
# - 结果：跳过（因为还记得昨天的 09:00）
```

**解决**：
```python
# 正确做法：用 "YYYY-MM-DD HH:MM"
minute_marker = now.strftime("%Y-%m-%d %H:%M")

# 每天都是新的 marker：
# - 第一天："2024-06-18 09:00"
# - 第二天："2024-06-19 09:00"
# - 不会跳过
```

---

### 7.2 坏任务拖垮调度器

**问题**：非法 cron 表达式导致异常

**原因**：
```python
# 如果不校验：
cron_matches("invalid cron", now) → 抛异常
# 调度线程崩溃，所有任务停止
```

**解决**：
```python
# 1. 注册前校验
err = validate_cron(cron)
if err:
    return err

# 2. 单 job try/except
try:
    if cron_matches(job.cron, now):
        # ...
except Exception as e:
    print(f"[cron error] {job.id}: {e}")
    # 不影响其他 job
```

---

### 7.3 Agent 不空闲导致任务堆积

**问题**：Agent 正在工作，任务无法交付

**原因**：
```python
# queue_processor_loop:
if not agent_lock.acquire(blocking=False):
    continue  # Agent 正在工作，等待

# 如果 Agent 工作时间长，cron_queue 会堆积
```

**解决（生产版）**：
- ✅ 队列有优先级，紧急任务优先
- ✅ UI 可以显示等待中的任务
- ✅ 用户可以手动触发

---

## 八、设计模式与最佳实践

### 8.1 生产者-消费者模式

```python
# 生产者：cron_scheduler_loop
with cron_lock:
    cron_queue.append(job)  # 写入队列

# 消费者：agent_loop
fired = consume_cron_queue()  # 从队列读取

# 解耦：
# - 生产者不关心消费者是否在运行
# - 消费者不关心生产者何时写入
# - 队列作为缓冲
```

### 8.2 独立调度线程

```python
# 调度线程独立运行
threading.Thread(target=cron_scheduler_loop, daemon=True)

# 不依赖 agent_loop：
# - agent_loop 可能退出（stop_reason="end_turn")
# - 调度线程仍在后台检查时间
# - queue processor 会自动启动 agent_loop
```

### 8.3 错误隔离

```python
# 单 job try/except
try:
    if cron_matches(job.cron, now):
        # ...
except Exception as e:
    print(f"[cron error] {job.id}: {e}")
    # 不影响其他 job

# 设计哲学：
# - 一个坏任务不应拖垮整个系统
# - 部分容错
```

---

## 九、总结

### 核心要点

1. **四层模型**：
   - Scheduler：时间判断（生产者）
   - Queue：解耦缓冲
   - Queue Processor：自动交付
   - Consumer：执行任务

2. **独立调度线程**：不依赖 agent_loop

3. **队列传递触发**：生产者-消费者解耦

4. **Durable vs Session-only**：持久化可选

5. **错误隔离**：单 job 异常不拖垮系统

### 设计哲学

> **闹钟不需要你盯着它才会响**

这就是 Cron Scheduler 的核心价值 —— 自动定时触发，不需要用户每次手动推。

---

## 十、下一步

你已经掌握了 s14 Cron Scheduler 的核心内容。接下来建议：

1. **实战运行代码**：
   ```bash
   python s14_cron_scheduler/code.py
   ```

2. **测试场景**：
   - 每 2 分钟打印日期
   - 1 分钟后一次性提醒
   - 查看持久化文件

3. **继续学习 s15 Agent Teams**（多 agent 协作）

---

**详细实现请参考 code.py 源码！** 📚
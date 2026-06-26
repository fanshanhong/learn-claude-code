# s14 Cron Scheduler 总览与核心要点

## 🎯 一句话总结

> **闹钟不需要你盯着它才会响** —— 自动定时触发，不需要用户每次手动推

---

## 📊 四层模型（核心架构）

```
Layer 1: Scheduler（调度线程）
  ↓ 每秒轮询，判断时间匹配
  ↓ cron_matches → True → 写入队列

Layer 2: Queue（队列）
  ↓ cron_queue 解耦生产者和消费者
  ↓ 调度线程写，agent_loop 读

Layer 3: Queue Processor（自动交付）
  ↓ 检查队列有任务 + Agent 空闲
  ↓ 自动启动 agent_loop

Layer 4: Consumer（agent_loop）
  ↓ 消费队列，注入到 messages
  ↓ "[Scheduled] {job.prompt}"
  ↓ LLM 执行操作
```

---

## 🔑 关键设计点

### 1. Cron 表达式（五段式）
```
分钟  小时  日  月  星期
  *    *   *   *   *      每分钟
  0    9   *   *   *      每天 9:00
 */5    *   *   *   *      每 5 分钟

支持：*、*/N、N、N-M、N,M,...

关键语义：DOM 和 DOW 用 OR（任一匹配即可）
```

### 2. 独立调度线程
```python
# 不依赖 agent_loop 是否在运行
# 进程关闭 → 调度也停（daemon=True）
# 单 job try/except → 不拖垮整个线程
```

### 3. 防止重复触发
```python
# date-aware minute_marker
# 使用 "YYYY-MM-DD HH:MM" 格式
# 防止同一分钟重复触发
# 同时不会在第二天跳过
```

### 4. Durable vs Session-only
```
Durable：
  - 任务写入 .scheduled_tasks.json
  - Agent 重启后加载恢复
  
Session-only：
  - 仅内存，进程关闭丢失
  
重要前提：调度器必须在 Agent 进程内运行
```

---

## 📚 深度分析文档

详细分析请查阅：
- **README_ME.md** - 架构设计、实现细节、生产版差异

---

## 🎓 核心概念速记

### 手动 vs 定时

| 维度 | 手动触发 (s13) | 定时触发 (s14) |
|------|---------------|---------------|
| **触发者** | 用户输入 | 调度线程 |
| **触发时机** | 随时 | cron 表达式 |
| **需要人参与** | 是 | 否 |
| **持久性** | — | durable 跨重启 |

---

## ✨ 你已经掌握的内容

- ✅ 四层模型：Scheduler、Queue、Queue Processor、Consumer
- ✅ Cron 表达式：五段式匹配，DOM/DOW OR 语义
- ✅ 独立调度线程：不依赖 agent_loop
- ✅ 队列传递触发：生产者-消费者解耦
- ✅ 防止重复触发：date-aware marker
- ✅ 错误隔离：单 job 异常不拖垮系统

---

## 🚀 下一步建议

1. **实战运行代码**：
   ```bash
   python s14_cron_scheduler/code.py
   ```

2. **测试场景**：
   - 每 2 分钟打印日期
   - 1 分钟后一次性提醒

3. **继续学习 s15 Agent Teams**（多 agent 协作）

---

**详细内容请查阅 README_ME.md！** 📚
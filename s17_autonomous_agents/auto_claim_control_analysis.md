# s17 自动认领的控制权衡：何时不应该自动认领？

> 本文档分析 teammate 自动认领任务的问题，探讨哪些情况下不应该自动认领

---

## 目录

1. [自动认领的设计假设](#一自动认领的设计假设)
2. [不应该自动认领的六种情况](#二不应该自动认领的六种情况)
3. [真实 CC 的控制机制](#三真实-cc-的控制机制)
4. [改进建议：可控的自治](#四改进建议可控的自治)
5. [最佳实践](#五最佳实践)

---

## 一、自动认领的设计假设

### 1.1 s17 的设计理念

```
设计假设：
- 所有任务都是"可认领的"（谁做都一样）
- 所有 teammate 都是"通用的"（能力相同）
- Lead 不需要控制任务分配（自动最好）
- 任务依赖关系是唯一的约束（blockedBy）

核心假设："任务越快完成越好"
```

### 1.2 自动认领的行为

```python
# idle_poll 的逻辑
def idle_poll(agent_name, messages, name, role) -> str:
    for _ in range(12):  # 12 * 5s = 60s
        time.sleep(5)
        
        # ① 优先检查 inbox（shutdown_request 等）
        inbox = BUS.read_inbox(agent_name)
        if inbox:
            ...
        
        # ② 扫描任务看板，自动认领
        unclaimed = scan_unclaimed_tasks()
        if unclaimed:
            task = unclaimed[0]  # ← 取第一个（无选择逻辑）
            result = claim_task(task["id"], agent_name)  # ← 直接认领
            if "Claimed" in result:
                # ← 认领成功，立即进入 WORK 阶段
                messages.append({"role": "user",
                    "content": f"<auto-claimed>Task {task['id']}: "
                               f"{task['subject']}</auto-claimed>"})
                return "work"  # ← 无需 Lead 确认

# 问题：teammate 直接认领，Lead 无法阻止或控制
```

### 1.3 缺失的控制机制

```
s17 缺失的控制：

❌ 无任务标记：无法标记"只能由 Lead 分配的任务"
❌ 无角色匹配：teammate 无角色/技能，无法匹配任务类型
❌ 无认领请求：teammate 直接认领，不请求 Lead 许可
❌ 无撤销机制：认领后无法撤销或重新分配
❌ 无优先级控制：只能按文件名排序，无法按优先级认领
```

---

## 二、不应该自动认领的六种情况

### 2.1 情况①：任务需要特定技能或角色

**场景**：任务需要特定领域的专业知识

```python
# Lead 创建了三个不同类型的任务
create_task("修复后端 API bug", metadata={"skill": "backend"})
create_task("设计前端 UI", metadata={"skill": "frontend"})
create_task("配置 Kubernetes 集群", metadata={"skill": "devops"})

# 启动了三个不同角色的 teammate
spawn_teammate("alice", "backend developer", "擅长 Python/FastAPI")
spawn_teammate("bob", "frontend developer", "擅长 React/TypeScript")
spawn_teammate("charlie", "devops engineer", "擅长 Docker/K8s")

# 问题：自动认领可能导致技能不匹配
alice IDLE → scan → 发现"设计前端 UI" → 认领 → 执行
# ← alice 是后端开发者，不擅长前端 UI！
# ← 但她还是自动认领了，因为任务看板只有一个未认领任务
```

**真实场景**：
```
实际影响：
- alice 花费大量时间学习前端框架
- 任务完成质量可能较差
- bob（前端专家）空闲等待
- 资源分配不合理
```

### 2.2 情况②：任务需要 Lead 审批

**场景**：安全敏感或高风险任务

```python
# Lead 创建了需要审批的任务
create_task("删除生产数据库", metadata={"requires_approval": True})
create_task("修改核心配置文件", metadata={"requires_approval": True})
create_task("部署到生产环境", metadata={"requires_approval": True})

# 问题：teammate 自动认领并执行，无审批流程
alice IDLE → scan → 发现"删除生产数据库" → 认领 → 立即执行
# ← alice 直接执行了高风险操作，Lead 无法阻止！
# ← 这在生产环境中非常危险
```

**真实场景**：
```
实际影响：
- 高风险操作无审批流程
- 可能导致生产事故
- Lead 失去控制权
- 无法审计操作
```

### 2.3 情况③：Lead 想保留任务给自己

**场景**：某些任务 Lead 想亲自处理

```python
# Lead 创建了任务，但想自己处理一部分
create_task("设计系统架构")  # ← Lead 想自己做
create_task("写单元测试")    # ← 可以分配给 teammate
create_task("写文档")        # ← 可以分配给 teammate

# 问题：teammate 自动认领所有任务，包括 Lead 想保留的
alice IDLE → scan → 发现"设计系统架构" → 认领 → 执行
# ← Lead 想亲自设计架构，但 alice 已经认领了！
# ← Lead 无法阻止
```

**真实场景**：
```
实际影响：
- Lead 失去了亲自处理任务的机会
- 无法保留特定任务
- 需要提前创建任务（否则会被认领）
```

### 2.4 情况④：任务需要特定上下文知识

**场景**：任务需要特定上下文，不适合普通 teammate

```python
# Lead 刚处理了一个复杂的客户需求
# 创建任务时需要基于这个上下文

# Lead 的上下文：
# - 刚和客户开会讨论了特定需求
# - 知道客户的特殊要求
# - 理解业务的复杂性

create_task("实现客户定制功能", 
            description="根据客户需求实现特定功能")

# 问题：teammate 缺少上下文知识
bob IDLE → scan → 认领"实现客户定制功能" → 执行
# ← bob 不知道客户的特殊要求
# ← bob 不知道业务上下文
# ← 可能实现错误的功能
```

**真实场景**：
```
实际影响：
- teammate 缺少必要上下文
- 可能理解错误需求
- 需要反复沟通（增加成本）
- 任务完成质量可能较差
```

### 2.5 情况⑤：Lead 想控制执行顺序（不仅仅是依赖）

**场景**：Lead 想按特定策略安排任务执行顺序

```python
# Lead 创建了多个任务（无依赖）
create_task("任务 A")  # ← 优先级：高
create_task("任务 B")  # ← 优先级：中
create_task("任务 C")  # ← 优先级：低

# Lead 想按优先级执行：A → B → C
# 但自动认领可能按其他顺序

# 教学版的排序逻辑：按文件名排序
scan_unclaimed_tasks():
    for f in sorted(TASKS_DIR.glob("task_*.json")):  # ← 文件名排序
        task = json.loads(f.read_text())
        if can_claim:
            unclaimed.append(task)
    return unclaimed  # ← 返回按文件名排序的任务

# 文件名：task_timestamp_random
# - task_1718123456_0001  (任务 C，最早创建)
# - task_1718123460_0002  (任务 A)
# - task_1718123465_0003  (任务 B)

alice IDLE → scan → 取第一个 → "任务 C"（优先级最低）
# ← alice 认领了优先级最低的任务！
# ← Lead 无法控制执行顺序
```

**真实场景**：
```
实际影响：
- 无法按优先级执行
- 无法按业务逻辑安排顺序
- 只能依赖任务创建时间（文件名）
```

### 2.6 情况⑥：任务正在被 Lead 处理（TOCTOU 问题）

**场景**：Lead 正在处理任务，teammate 却认领了

```python
# Lead 正在手动处理任务
Lead: read_file(".tasks/task_001.json")
      ↓ Lead 看到任务，准备手动处理
      ↓ 但还没更新 owner（还在思考）

# 同时，alice 在 IDLE 阶段
alice IDLE → scan → 发现 task_001（owner=None）
      ↓ alice 认领 task_001
      ↓ alice 开始执行

Lead: 想手动处理 task_001 → 发现已被 alice 认领
      ↓ Lead 无法处理（已被认领）
      ↓ TOCTOU (Time-of-Check-Time-of-Use) 问题
```

**真实场景**：
```
实际影响：
- Lead 正在处理的任务可能被 teammate 认领
- 需要提前更新 owner（否则会被认领）
- 时刻担心任务被自动认领
```

---

## 三、真实 CC 的控制机制

### 3.1 CC 如何处理这些问题？

从 README 第235-268行，真实 CC 有多个机制：

#### 机制①：idle_notification（通知 Lead）

```typescript
// inProcessRunner.ts:569-589
sendIdleNotification()

// 队友完成工作后，通知 Lead：
// "我现在空闲了，可以分配任务"

// Lead 知道队友可用，可以选择：
// - 分配新任务（通过 inbox）
// - 请求关机（shutdown_request）
// - 不理会（让队友继续等待）
```

**关键**：Lead 可以选择不分配任务，而不是队友自动认领。

#### 机制②：mailbox 轮询 + task watcher

```typescript
// inProcessRunner.ts:689-868
waitForNextPromptOrShutdown()

// 500ms 轮询，检查三类来源：
// ① pending user messages（Lead 分配的任务）
// ② mailbox 文件消息（Lead 的消息）
// ③ task list（任务看板）

// 但不是自动认领，而是：
// - Lead 可以通过消息分配任务
// - Lead 可以通过消息阻止认领
```

**关键**：Lead 可以通过消息控制任务分配。

#### 机制③：useTaskListWatcher（文件监听）

```typescript
// hooks/useTaskListWatcher.ts:34-189
useTaskListWatcher()

// 监听 .claude/tasks/ 目录变化
// 当新任务创建或依赖解锁时触发

// 但不是立即认领，而是：
// - 检查任务是否可认领（blockedBy）
// - Lead 可能已经通过其他机制分配
```

**关键**：被动通知，不是主动认领。

#### 机制④：tryClaimNextTask（有控制的认领）

```typescript
// inProcessRunner.ts:853-860
tryClaimNextTask()

// 在等待期间主动尝试认领
// 但有文件锁保护，避免竞争
```

**关键**：文件锁 + 原子操作，避免 TOCTOU。

### 3.2 CC vs 教学版对比

| 维度 | 教学版 (s17) | 真实 CC |
|------|-------------|---------|
| **通知机制** | ❌ 无通知 | ✅ idle_notification |
| **Lead 控制** | ❌ 无控制 | ✅ Lead 可通过消息分配 |
| **认领时机** | ✅ 自动认领（5s轮询） | ❌ 等待 Lead 分配或主动尝试 |
| **文件锁** | ❌ 无锁（竞争风险） | ✅ proper-lockfile |
| **撤销机制** | ❌ 无撤销 | ✅ Lead 可重新分配 |
| **超时机制** | ✅ 60s 超时退出 | ❌ 无固定超时（Lead 控制） |

**关键差异**：
- 教学版：**主动自动认领**（teammate 主动找活干）
- 真实 CC：**被动等待分配**（Lead 控制分配）+ 可选主动认领

---

## 四、改进建议：可控的自治

### 4.1 方案①：任务标记机制

```python
# 扩展 Task 定义
@dataclass
class Task:
    id: str
    subject: str
    description: str
    status: str
    owner: str | None
    blockedBy: list[str]
    
    # ← 新增标记
    auto_claimable: bool = True      # ← 是否允许自动认领
    required_skills: list[str] = []  # ← 需要的技能
    requires_approval: bool = False  # ← 是否需要 Lead 审批
    priority: int = 0                # ← 优先级（数字越大越优先）

# scan_unclaimed_tasks 改进
def scan_unclaimed_tasks() -> list[dict]:
    unclaimed = []
    for f in sorted(TASKS_DIR.glob("task_*.json")):
        task = json.loads(f.read_text())
        
        # ← 检查是否允许自动认领
        if not task.get("auto_claimable", True):
            continue  # ← 不允许自动认领
        
        # ← 检查技能匹配（如果有）
        required_skills = task.get("required_skills", [])
        if required_skills:
            # ← teammate 需要有匹配的技能
            if not has_skills(agent_name, required_skills):
                continue
        
        # ← 检查是否需要审批
        if task.get("requires_approval", False):
            continue  # ← 需要审批，不能自动认领
        
        # ← 检查其他条件
        if (task.get("status") == "pending"
                and not task.get("owner")
                and can_start(task["id"])):
            unclaimed.append(task)
    
    # ← 按优先级排序（数字越大越优先）
    unclaimed.sort(key=lambda t: t.get("priority", 0), reverse=True)
    
    return unclaimed
```

**效果**：
- Lead 可以标记任务为"不允许自动认领"
- Lead 可以标记任务为"需要审批"
- Lead 可以设置任务优先级
- teammate 只认领匹配技能的任务

### 4.2 方案②：认领请求协议

```python
# 新增协议：claim_request / claim_response

# Teammate 在认领前请求 Lead 许可
def idle_poll_with_approval(agent_name, messages, name, role) -> str:
    for _ in range(12):
        time.sleep(5)
        
        inbox = BUS.read_inbox(agent_name)
        if inbox:
            ...
        
        # ← 扫描任务看板
        unclaimed = scan_unclaimed_tasks()
        if unclaimed:
            task = unclaimed[0]
            
            # ← 新增：发送认领请求（不直接认领）
            req_id = new_request_id()
            pending_requests[req_id] = ProtocolState(
                request_id=req_id,
                type="claim_approval",
                sender=agent_name,
                target="lead",
                status="pending",
                payload=json.dumps({"task_id": task["id"]})
            )
            
            BUS.send(agent_name, "lead",
                     f"我想认领任务: {task['subject']}",
                     "claim_request",
                     {"request_id": req_id, "task_id": task["id"]})
            
            # ← 等待 Lead 响应（下次 inbox 检查）
            # ← Lead 可以批准或拒绝
            
            continue  # ← 不立即认领，等待 Lead 响应
    
    return "timeout"

# Lead 处理认领请求
def handle_claim_request(msg):
    metadata = msg.get("metadata", {})
    req_id = metadata.get("request_id", "")
    task_id = metadata.get("task_id", "")
    
    # ← Lead 决定是否批准
    approve = should_approve_claim(task_id, msg.get("from", ""))
    
    # ← 更新协议状态
    state = pending_requests.get(req_id)
    if state:
        state.status = "approved" if approve else "rejected"
    
    # ← 发送响应
    BUS.send("lead", msg.get("from", ""),
             f"批准认领" if approve else f"拒绝认领",
             "claim_response",
             {"request_id": req_id, "approve": approve, "task_id": task_id})
    
    if approve:
        # ← Lead 帮 teammate 认领（或 teammate 自己认领）
        claim_task(task_id, msg.get("from", ""))

# Teammate 处理认领响应
def handle_claim_response(msg, messages):
    metadata = msg.get("metadata", {})
    req_id = metadata.get("request_id", "")
    approve = metadata.get("approve", False)
    task_id = metadata.get("task_id", "")
    
    if approve:
        # ← Lead 批准，开始执行任务
        messages.append({"role": "user",
            "content": f"<claim-approved>Task {task_id} approved by Lead</claim-approved>"})
        return "work"
    else:
        # ← Lead 拒绝，继续扫描其他任务
        return "idle"
```

**效果**：
- teammate 认领前需要请求 Lead 许可
- Lead 可以批准或拒绝
- Lead 保持控制权

### 4.3 方案③：角色匹配机制

```python
# 扩展 teammate 配置
@dataclass
class TeammateConfig:
    name: str
    role: str
    skills: list[str]  # ← 技能列表
    prompt: str

# Lead 启动 teammate 时指定技能
spawn_teammate("alice", "backend developer",
               "擅长 Python/FastAPI",
               skills=["backend", "python", "api"])

# scan_unclaimed_tasks 检查技能匹配
def scan_unclaimed_tasks(agent_skills: list[str]) -> list[dict]:
    unclaimed = []
    for f in sorted(TASKS_DIR.glob("task_*.json")):
        task = json.loads(f.read_text())
        
        required_skills = task.get("required_skills", [])
        if required_skills:
            # ← 检查 teammate 是否有匹配技能
            if not set(required_skills).issubset(set(agent_skills)):
                continue  # ← 技能不匹配
        
        if (task.get("status") == "pending"
                and not task.get("owner")
                and can_start(task["id"])):
            unclaimed.append(task)
    
    return unclaimed
```

**效果**：
- teammate 只认领匹配技能的任务
- 避免"后端开发者做前端任务"的问题

### 4.4 方案④：优先级机制

```python
# Task 定义增加优先级
@dataclass
class Task:
    priority: int = 0  # ← 数字越大优先级越高

# scan_unclaimed_tasks 按优先级排序
def scan_unclaimed_tasks() -> list[dict]:
    unclaimed = []
    ...
    # ← 按优先级排序（降序）
    unclaimed.sort(key=lambda t: t.get("priority", 0), reverse=True)
    return unclaimed

# Lead 创建任务时设置优先级
create_task("紧急 bug 修复", priority=10)  # ← 高优先级
create_task("优化性能", priority=5)        # ← 中优先级
create_task("写文档", priority=1)          # ← 低优先级
```

**效果**：
- teammate 按优先级认领任务
- Lead 可以控制执行顺序

---

## 五、最佳实践

### 5.1 何时使用自动认领？

```
适合自动认领的场景：

✅ 独立且通用的任务
   - 无特定技能要求
   - 无审批流程
   - 无上下文依赖

✅ 大批量并行任务
   - 任务数量多（>10）
   - Lead 无法手动分配
   - 任务相对简单

✅ 依赖链任务
   - 有明确的依赖关系
   - blockedBy 自动控制顺序
   - Lead 不需要干预

✅ 测试或演示场景
   - 快速验证系统功能
   - 不关心任务分配
   - 优先展示自治能力
```

### 5.2 何时避免自动认领？

```
不适合自动认领的场景：

❌ 技能敏感任务
   - 需要特定领域知识
   - 需要特定角色处理
   - 技能不匹配会降低质量

❌ 安全敏感任务
   - 高风险操作（删除数据库）
   - 需要审批流程
   - 需要 Lead 审查

❌ 上下文依赖任务
   - 需要 Lead 的上下文知识
   - 需要客户需求理解
   - 需要业务逻辑洞察

❌ Lead 保留任务
   - Lead 想亲自处理
   - Lead 有特定意图
   - Lead 想学习或验证

❌ 优先级控制场景
   - 需要按特定顺序执行
   - 不仅仅是依赖关系
   - 有业务优先级考虑

❌ TOCTOU 风险场景
   - Lead 正在处理任务
   - 需要避免竞争
   - 需要原子操作
```

### 5.3 推荐的混合策略

```python
# 混合策略：Lead 分配 + 自动认领

# ① Lead 创建任务时标记
create_task("紧急 bug 修复", 
            auto_claimable=False,  # ← Lead 保留
            priority=10)

create_task("写单元测试",
            auto_claimable=True,   # ← 允许自动认领
            required_skills=["testing"],
            priority=5)

create_task("写文档",
            auto_claimable=True,   # ← 允许自动认领
            priority=1)

# ② Lead 启动队友时指定技能
spawn_teammate("alice", "backend developer", skills=["backend", "testing"])
spawn_teammate("bob", "writer", skills=["documentation"])

# ③ teammate 只认领匹配的任务
alice IDLE → scan → 发现"写单元测试"（匹配技能）→ 认领
bob IDLE → scan → 发现"写文档"（匹配技能）→ 认领

# ④ Lead 手动分配保留的任务
Lead: "紧急 bug 修复" → 手动分配给 alice → alice 处理
# ← 或者 Lead 自己处理
```

---

## 六、总结

### 6.1 自动认领的价值

```
核心价值：
✅ 减少 Lead 负担（无需手动分配）
✅ 自动负载均衡（空闲队友找活干）
✅ 扩展性好（任务越多优势越大）

核心问题：
❌ 失去控制权（Lead 无法阻止）
❌ 技能不匹配（质量可能较差）
❌ 缺少审批流程（高风险操作）
❌ TOCTOU 问题（竞争风险）
```

### 6.2 改进方向

```
改进建议：

① 任务标记机制
   - auto_claimable：是否允许自动认领
   - requires_approval：是否需要审批
   - priority：优先级控制

② 认领请求协议
   - claim_request / claim_response
   - teammate 请求 → Lead 批准/拒绝

③ 角色匹配机制
   - teammate skills
   - task required_skills
   - 匹配才能认领

④ 优先级机制
   - task priority
   - 按优先级认领
   - Lead 控制顺序
```

### 6.3 真实 CC 的启示

```
真实 CC 的设计：
✅ idle_notification（通知 Lead）
✅ mailbox 轮询（等待 Lead 分配）
✅ task watcher（被动通知）
✅ tryClaimNextTask（有控制的主动认领）
✅ 文件锁（避免竞争）

关键理念：
- 不是"完全自动"，而是"可控的自治"
- Lead 有最终控制权
- teammate 可以主动，但 Lead 可以阻止
```

---

## 附录：具体场景示例

### A. 高风险任务的正确处理

```python
# ❌ 错误做法（自动认领）
create_task("删除生产数据库")
alice IDLE → scan → 认领 → 立即执行 → 生产事故

# ✅ 正确做法（审批流程）
create_task("删除生产数据库", 
            requires_approval=True)

alice IDLE → scan → 发现任务（requires_approval=True）
→ 不认领（跳过）
→ Lead 手动分配或亲自处理

# 或者：认领请求协议
alice IDLE → scan → 发现任务
→ 发送 claim_request
→ Lead 看到请求 → 评估风险 → 批准/拒绝
→ 如果批准 → alice 执行
→ 如果拒绝 → alice 继续扫描其他任务
```

### B. 技能匹配的正确处理

```python
# ❌ 错误做法（自动认领，无匹配）
create_task("设计前端 UI")
spawn_teammate("alice", "backend developer")
alice IDLE → scan → 认领"设计前端 UI" → 质量差

# ✅ 正确做法（技能匹配）
create_task("设计前端 UI", required_skills=["frontend", "ui"])
spawn_teammate("alice", "backend developer", skills=["backend"])
spawn_teammate("bob", "frontend developer", skills=["frontend", "ui"])

alice IDLE → scan → 发现任务（技能不匹配）→ 跳过
bob IDLE → scan → 发现任务（技能匹配）→ 认领 → 质量好
```

### C. Lead 保留任务的正确处理

```python
# ❌ 错误做法（无法保留）
create_task("设计系统架构")
alice IDLE → scan → 认领 → Lead 无法亲自处理

# ✅ 正确做法（标记保留）
create_task("设计系统架构", auto_claimable=False)
alice IDLE → scan → 发现任务（auto_claimable=False）→ 跳过
Lead → 手动处理 → 完成
```

---

## 参考资料

- [s17 Autonomous Agents 主文档](./README.md)
- [真实 CC 的空闲机制](./README.md#深入-cc-源码)
- [任务系统设计](../s12_todo_write/)
- [协议机制](../s16_team_protocols/)
# A2A 协议完整指南

> 本文档详细介绍 A2A (Agent-to-Agent) 协议，包括应用场景、具体协议和示例

---

## 目录

1. [A2A 协议概述](#一a2a-协议概述)
2. [FIPA ACL（经典标准）](#二fipa-acl经典标准)
3. [Google A2A Protocol（现代标准）](#三google-a2a-protocol现代标准)
4. [其他 A2A 协议](#四其他-a2a-协议)
5. [应用场景](#五应用场景)
6. [具体协议示例](#六具体协议示例)
7. [与 s17 的对比](#七与-s17-的对比)
8. [如何选择 A2A 协议](#八如何选择-a2a-协议)

---

## 一、A2A 协议概述

### 1.1 什么是 A2A 协议？

**A2A (Agent-to-Agent) Protocol** 是一个**标准化的协议框架**，用于 Agent 之间的通信、协调和协作。

```
核心目标：
✅ 标准化：不同系统开发的 Agent 可以互操作
✅ 语义化：Agent 能理解消息的含义和意图
✅ 结构化：消息格式统一，便于解析和处理
✅ 可扩展：支持新的协议类型和交互模式
```

### 1.2 为什么需要 A2A 协议？

```
问题：没有标准，无法互操作

场景1：
系统A开发了 Agent Alice（Python）
系统B开发了 Agent Bob（Java）
Alice 和 Bob 无法通信（协议不同）

场景2：
Alice 发送消息："delete database"
Bob 理解为："删除数据库"（中文）
Charlie 理解为："删除数据库"（英文）
理解不一致，导致错误

场景3：
Alice 发送："request shutdown"
Bob 不知道如何响应（没有标准响应格式）

解决方案：A2A 协议
✅ 统一消息格式（JSON-RPC / FIPA ACL）
✅ 统一动作类型（Performatives）
✅ 统一语义理解（Ontology）
✅ 统一响应格式（request-response）
```

### 1.3 A2A 协议的分类

```
A2A 协议家族：

┌─────────────────────────────────────────┐
│  经典标准（2000年代）                     │
│  - FIPA ACL（Foundation for Intelligent │
│              Physical Agents）          │
│  - KQML（Knowledge Query Manipulation   │
│         Language）                      │
│  ✅ 学术标准                             │
│  ✅ 完整规范                             │
│  ❌ 过于复杂                             │
└─────────────────────────────────────────┘
            ↓ 现代简化版
┌─────────────────────────────────────────┐
│  现代标准（2020年代）                     │
│  - Google A2A Protocol（2024）          │
│  - Microsoft Semantic Kernel（2023）    │
│  - LangChain Agent Protocol（2024）     │
│  - CrewAI Protocol（2024）              │
│  ✅ 轻量级                               │
│  ✅ JSON-RPC 风格                        │
│  ❌ 不够完整                             │
└─────────────────────────────────────────┘
            ↓ 特定框架
┌─────────────────────────────────────────┐
│  框架协议（2020年代）                     │
│  - AutoGen Protocol（Microsoft）        │
│  - LangGraph Protocol（LangChain）      │
│  - CrewAI Protocol（CrewAI）            │
│  ✅ 框架内置                             │
│  ✅ 易于使用                             │
│  ❌ 框架绑定                             │
└─────────────────────────────────────────┘
```

---

## 二、FIPA ACL（经典标准）

### 2.1 FIPA ACL 简介

**FIPA ACL**（Foundation for Intelligent Physical Agents Agent Communication Language）是 A2A 协议的**经典学术标准**，由 FIPA 组织制定（1996-2005）。

```
特点：
✅ 国际标准（ISO/IEC）
✅ 完整规范（几十种协议）
✅ 语义定义（FIPA SL 语言）
✅ 知识本体（Ontology）
❌ 过于复杂（实际应用少）
```

### 2.2 FIPA ACL 消息结构

```json
{
  "performative": "request",       // ← 动作类型（关键！）
  "sender": "agent_alice",         // ← 发送者
  "receiver": ["agent_bob"],       // ← 接收者列表
  "content": "Please delete database 'test_db'",  // ← 内容
  "protocol": "fipa-request",      // ← 协议类型
  "conversation-id": "conv_12345", // ← 会话 ID（关联请求和响应）
  "reply-with": "reply_12345",     // ← 期望的回复 ID
  "reply-by": "2025-01-01T12:00:00Z",  // ← 超时时间
  "language": "fipa-sl",           // ← 内容语言（FIPA SL）
  "encoding": "utf-8",             // ← 编码
  "ontology": "database-management"  // ← 知识本体（语义共享）
}
```

**关键字段解释**：

| 字段 | 作用 | 示例 |
|------|------|------|
| **performative** | 动作类型（核心） | request, inform, agree, refuse |
| sender | 发送者标识 | agent_alice |
| receiver | 接收者列表 | ["agent_bob"] |
| content | 消息内容 | "Please delete database 'test_db'" |
| protocol | 协议类型 | fipa-request, fipa-query |
| conversation-id | 会话 ID（关联请求和响应） | conv_12345 |
| reply-with | 期望的回复 ID | reply_12345 |
| reply-by | 超时时间 | 2025-01-01T12:00:00Z |
| language | 内容语言 | fipa-sl（FIPA Semantic Language） |
| ontology | 知识本体（语义共享） | database-management |

### 2.3 Performatives（动作类型）详解

**Performative** 是 FIPA ACL 的核心概念，定义了 Agent 的**意图和动作类型**。

#### 基础 Performatives

```
信息交换类：
- inform：通知信息
  "我来通知你，任务已完成"
  
- confirm：确认信息
  "确认，数据库已删除"

- disconfirm：否认信息
  "否认，数据库未删除"

请求类：
- request：请求执行动作
  "请你删除数据库"

- request-when：请求在条件满足时执行
  "请在用户登录后删除数据库"

- request-whenever：请求每次条件满足时都执行
  "请每次用户退出后都清理临时文件"

响应类：
- agree：同意执行
  "同意，我将删除数据库"

- refuse：拒绝执行
  "拒绝，我不能删除生产数据库"

提议类：
- propose：提议执行动作
  "我提议删除测试数据库"

- accept-proposal：接受提议
  "接受提议，删除测试数据库"

- reject-proposal：拒绝提议
  "拒绝提议，测试数据库还有用"

查询类：
- query-if：查询条件是否成立
  "数据库是否为空？"

- query-ref：查询引用（获取值）
  "数据库的大小是多少？"

- reply：回复查询
  "数据库大小为 1GB"

取消类：
- cancel：取消请求
  "取消删除数据库的请求"

代理类：
- proxy：代理执行
  "我代理你执行删除数据库"
```

#### 高级 Performatives

```
协商类：
- call-for-proposal：征集提议
  "征集删除数据库的方案"

- propose：提交提议
  "提议：先备份再删除"

- accept-proposal：接受提议
  "接受提议"

- reject-proposal：拒绝提议
  "拒绝提议，备份太耗时"

拍卖类：
- auction：拍卖
  "拍卖计算资源"

- bid：竞价
  "竞价：100 CPU cores"

- award：授予
  "授予 Agent Bob 100 CPU cores"

委托类：
- delegate：委托执行
  "委托 Agent Bob 删除数据库"

- sub-contract：分包
  "分包任务给 Agent Charlie"

错误类：
- failure：失败通知
  "删除数据库失败：权限不足"

- not-understood：不理解
  "不理解消息：格式错误"
```

### 2.4 FIPA ACL 协议类型

#### FIPA Request Protocol（请求协议）

```
交互模式：
Alice → Bob: request
      ↓
Bob → Alice: agree / refuse
      ↓
(如果 agree)
Bob → Alice: inform (done) / failure

示例：
Alice: request "删除数据库 test_db"
Bob: agree "同意删除"
Bob: inform "数据库已删除"

或者：
Alice: request "删除数据库 test_db"
Bob: refuse "拒绝删除（生产数据库）"
```

#### FIPA Query Protocol（查询协议）

```
交互模式：
Alice → Bob: query-if / query-ref
      ↓
Bob → Alice: reply / refuse / failure

示例：
Alice: query-if "数据库是否为空？"
Bob: reply "数据库不为空（还有100条记录）"

或者：
Alice: query-ref "数据库大小？"
Bob: reply "数据库大小为 1GB"
```

#### FIPA Propose Protocol（提议协议）

```
交互模式：
Alice → Bob: propose
      ↓
Bob → Alice: accept-proposal / reject-proposal
      ↓
(如果 accept-proposal)
Alice → Bob: inform (done) / failure

示例：
Alice: propose "提议删除测试数据库"
Bob: accept-proposal "接受提议"
Alice: inform "测试数据库已删除"
```

#### FIPA Contract Net Protocol（合同网协议）

```
交互模式（最复杂）：
Manager → Workers: call-for-proposal
      ↓
Worker1 → Manager: propose
Worker2 → Manager: propose
Worker3 → Manager: propose
      ↓
Manager → Worker1: accept-proposal
Manager → Worker2: reject-proposal
Manager → Worker3: reject-proposal
      ↓
Worker1 → Manager: inform (done) / failure

示例：
Manager: call-for-proposal "征集删除数据库的方案"
Worker1: propose "提议：先备份再删除（预计10分钟）"
Worker2: propose "提议：直接删除（预计5分钟）"
Worker3: propose "提议：迁移后再删除（预计30分钟）"
Manager: accept-proposal Worker1（选择最安全的方案）
Manager: reject-proposal Worker2（风险太高）
Manager: reject-proposal Worker3（耗时太长）
Worker1: inform "备份完成，数据库已删除"
```

### 2.5 FIPA SL（语义语言）

**FIPA SL**（Semantic Language）是 FIPA ACL 的内容语言，用于表达复杂的逻辑和语义。

```
FIPA SL 示例：

简单表达式：
(delete (database test_db))

条件表达式：
(when (logged-in user123)
  (delete (database test_db)))

逻辑表达式：
(and (is-empty database test_db)
     (can-delete user123))

量化表达式：
(forall ?db (is-test-database ?db)
  (delete ?db))

意图表达式：
(intends alice
  (delete (database test_db)))

信念表达式：
(believes alice
  (is-empty database test_db))
```

### 2.6 Ontology（知识本体）

**Ontology** 定义了 Agent 共享的词汇和语义，确保不同 Agent 理解一致。

```json
{
  "ontology": "database-management",
  "terms": [
    {
      "term": "database",
      "definition": "A structured collection of data",
      "properties": ["name", "size", "status"]
    },
    {
      "term": "delete",
      "definition": "Remove a database from storage",
      "parameters": ["database-id"],
      "effects": ["database.status = deleted"]
    },
    {
      "term": "test_db",
      "definition": "A database used for testing",
      "is-a": "database",
      "properties": ["temporary", "can-delete"]
    }
  ]
}
```

**作用**：
- Agent A 说"delete database"
- Agent B 根据 ontology 理解"delete database"的含义
- 确保语义一致（不会误解）

---

## 三、Google A2A Protocol（现代标准）

### 3.1 Google A2A Protocol 简介

**Google A2A Protocol** 是 Google 在 2024 年提出的**现代轻量级 A2A 协议**，基于 JSON-RPC 风格。

```
特点：
✅ 轻量级（简化 FIPA ACL）
✅ JSON-RPC 风格（现代）
✅ 易于实现
✅ 易于集成
❌ 不够完整（缺少部分 Performatives）
❌ 缺少 Ontology（语义定义）
```

### 3.2 Google A2A 消息结构

```json
{
  "jsonrpc": "2.0",
  "method": "request",             // ← 类似 FIPA performative
  "id": "msg_12345",               // ← 类似 conversation-id
  "params": {
    "from": "agent_alice",         // ← 发送者
    "to": ["agent_bob"],           // ← 接收者
    "content": "Please delete database 'test_db'",  // ← 内容
    "metadata": {                  // ← 元数据（灵活）
      "task_id": "task_001",
      "priority": "high",
      "timeout": "60s"
    }
  },
  "timestamp": "2025-01-01T12:00:00Z"
}
```

**关键设计**：
- `method`：类似 FIPA performative，定义动作类型
- `id`：消息 ID，用于 request-response 关联
- `params`：消息参数（灵活的 JSON 结构）
- `metadata`：元数据（可扩展）

### 3.3 Google A2A 动作类型

Google A2A 简化了 FIPA ACL 的 Performatives，只保留常用的：

```
基础动作：
- request：请求执行动作
- inform：通知信息
- query：查询信息
- response：响应请求

响应动作：
- accept：接受请求
- reject：拒绝请求
- error：错误通知

协商动作：
- propose：提议执行动作
- accept-proposal：接受提议
- reject-proposal：拒绝提议

协调动作：
- notify：通知状态变化
- subscribe：订阅事件
- unsubscribe：取消订阅
```

### 3.4 Google A2A 协议示例

#### Request-Response 协议

```json
// Alice 发送请求
{
  "jsonrpc": "2.0",
  "method": "request",
  "id": "req_001",
  "params": {
    "from": "agent_alice",
    "to": ["agent_bob"],
    "content": {
      "action": "delete_database",
      "database": "test_db"
    }
  },
  "timestamp": "2025-01-01T10:00:00Z"
}

// Bob 响应（接受）
{
  "jsonrpc": "2.0",
  "method": "response",
  "id": "req_001",  // ← 关联请求
  "params": {
    "from": "agent_bob",
    "to": ["agent_alice"],
    "content": {
      "status": "accept",
      "message": "同意删除数据库 test_db"
    }
  },
  "timestamp": "2025-01-01T10:00:05Z"
}

// Bob 通知完成
{
  "jsonrpc": "2.0",
  "method": "inform",
  "id": "req_001",  // ← 关联请求
  "params": {
    "from": "agent_bob",
    "to": ["agent_alice"],
    "content": {
      "status": "done",
      "message": "数据库 test_db 已删除",
      "timestamp": "2025-01-01T10:00:30Z"
    }
  },
  "timestamp": "2025-01-01T10:00:30Z"
}
```

#### Query 协议

```json
// Alice 查询数据库状态
{
  "jsonrpc": "2.0",
  "method": "query",
  "id": "qry_001",
  "params": {
    "from": "agent_alice",
    "to": ["agent_bob"],
    "content": {
      "query": "database_status",
      "database": "test_db"
    }
  }
}

// Bob 响应查询
{
  "jsonrpc": "2.0",
  "method": "response",
  "id": "qry_001",
  "params": {
    "from": "agent_bob",
    "to": ["agent_alice"],
    "content": {
      "status": "success",
      "result": {
        "database": "test_db",
        "size": "1GB",
        "tables": 10,
        "records": 10000
      }
    }
  }
}
```

#### Propose 协议

```json
// Alice 提议删除数据库
{
  "jsonrpc": "2.0",
  "method": "propose",
  "id": "prop_001",
  "params": {
    "from": "agent_alice",
    "to": ["agent_bob"],
    "content": {
      "proposal": "backup_and_delete",
      "database": "test_db",
      "estimated_time": "10 minutes"
    }
  }
}

// Bob 接受提议
{
  "jsonrpc": "2.0",
  "method": "accept-proposal",
  "id": "prop_001",
  "params": {
    "from": "agent_bob",
    "to": ["agent_alice"],
    "content": {
      "status": "accept",
      "message": "接受提议，先备份再删除"
    }
  }
}

// Alice 执行并通知完成
{
  "jsonrpc": "2.0",
  "method": "inform",
  "id": "prop_001",
  "params": {
    "from": "agent_alice",
    "to": ["agent_bob"],
    "content": {
      "status": "done",
      "message": "备份完成，数据库已删除",
      "backup_location": "/backup/test_db.tar.gz"
    }
  }
}
```

---

## 四、其他 A2A 协议

### 4.1 KQML（Knowledge Query Manipulation Language）

**KQML** 是 FIPA ACL 的前身（1990年代），由 DARPA 提出。

```
特点：
✅ 最早的标准（1993）
✅ FIPA ACL 的基础
❌ 已被 FIPA ACL 替代

KQML 消息示例：
(kqml
  :performative request
  :sender alice
  :receiver bob
  :content "(delete database test_db)"
  :language kif
  :ontology database-management)
```

### 4.2 Microsoft Semantic Kernel

**Semantic Kernel** 是 Microsoft 提出的 Agent 框架，内置 A2A 协议。

```
特点：
✅ 框架内置（易于使用）
✅ 支持多语言（C#, Python, Java）
❌ 框架绑定（无法跨框架使用）

Semantic Kernel Agent 通信：
// Agent A 发送消息
var message = new AgentMessage
{
    From = "agent_alice",
    To = "agent_bob",
    Content = "Please delete database 'test_db'",
    Type = MessageType.Request
};

// Agent B 接收并响应
var response = new AgentMessage
{
    From = "agent_bob",
    To = "agent_alice",
    Content = "Database deleted successfully",
    Type = MessageType.Response,
    CorrelationId = message.Id
};
```

### 4.3 LangChain Agent Protocol

**LangChain** 的 Agent 通信协议，基于 LCEL（LangChain Expression Language）。

```
特点：
✅ LangChain 框架内置
✅ 支持 DAG（有向无环图）流程
❌ 框架绑定

LangChain Agent 通信：
from langchain.agents import AgentExecutor

# Agent A 发送任务
agent_a.invoke({
    "input": "delete database test_db",
    "target_agent": "agent_b"
})

# Agent B 处理并响应
agent_b.invoke({
    "task": "delete database test_db",
    "response": "done"
})
```

### 4.4 CrewAI Protocol

**CrewAI** 的多 Agent 协作框架，内置任务分配协议。

```
特点：
✅ 多 Agent 协作框架
✅ 任务分配协议
❌ 框架绑定

CrewAI 任务分配：
from crewai import Agent, Task, Crew

agent_alice = Agent(role="Database Admin", ...)
agent_bob = Agent(role="Backup Admin", ...)

task1 = Task(description="Delete database test_db", agent=agent_alice)
task2 = Task(description="Backup before delete", agent=agent_bob)

crew = Crew(agents=[agent_alice, agent_bob], tasks=[task1, task2])
crew.kickoff()  # ← 自动协调任务
```

### 4.5 AutoGen Protocol

**AutoGen** 是 Microsoft Research 提出的多 Agent 框架。

```
特点：
✅ 多 Agent 对话框架
✅ 支持人机协作
❌ 框架绑定

AutoGen Agent 对话：
from autogen import AssistantAgent, UserProxyAgent

agent_alice = AssistantAgent("alice", ...)
agent_bob = AssistantAgent("bob", ...)

# Agent 对话
agent_alice.send(
    "Please delete database test_db",
    agent_bob,
    request_reply=True  # ← 期望回复
)

agent_bob.reply(
    "Database deleted successfully",
    agent_alice
)
```

---

## 五、应用场景

### 5.1 多 Agent 协作系统

```
场景：分布式数据库管理

架构：
┌─────────────────────────────────────┐
│  Manager Agent                      │
│  - 协调任务                          │
│  - 分配资源                          │
│  - 监控状态                          │
└─────────────────────────────────────┘
         ↓ FIPA Request Protocol
┌─────────────────┬─────────────────┐
│  Agent Alice    │  Agent Bob      │
│  - 管理数据库A  │  - 管理数据库B  │
└─────────────────┴─────────────────┘

协议交互：

Manager: call-for-proposal "征集数据库清理方案"
Alice: propose "提议：清理数据库A（预计5分钟）"
Bob: propose "提议：清理数据库B（预计10分钟）"
Manager: accept-proposal Alice（选择快的）
Manager: reject-proposal Bob（耗时太长）
Alice: inform "数据库A已清理"
```

### 5.2 智能制造系统

```
场景：工厂自动化

架构：
┌─────────────────────────────────────┐
│  Factory Manager Agent              │
│  - 调度生产任务                      │
│  - 监控设备状态                      │
└─────────────────────────────────────┘
         ↓ FIPA Contract Net Protocol
┌─────────────┬─────────────┬─────────────┐
│  Machine 1  │  Machine 2  │  Machine 3  │
│  Agent      │  Agent      │  Agent      │
└─────────────┴─────────────┴─────────────┘

协议交互：

Factory Manager: call-for-proposal "征集生产零件A的方案"
Machine 1: propose "提议：生产100个零件A（预计1小时）"
Machine 2: propose "提议：生产100个零件A（预计2小时）"
Machine 3: propose "提议：生产100个零件A（预计1.5小时）"
Factory Manager: accept-proposal Machine 1（最快）
Machine 1: inform "零件A生产完成（100个）"
```

### 5.3 智能交通系统

```
场景：交通协调

架构：
┌─────────────────────────────────────┐
│  Traffic Control Agent              │
│  - 协调交通信号                      │
│  - 处理紧急车辆                      │
└─────────────────────────────────────┘
         ↓ FIPA Request Protocol
┌─────────────┬─────────────┬─────────────┐
│  Vehicle A  │  Vehicle B  │  Vehicle C  │
│  Agent      │  Agent      │  Agent      │
└─────────────┴─────────────┴─────────────┘

协议交互：

Vehicle A: request "请求优先通行（紧急车辆）"
Traffic Control: agree "同意优先通行"
Traffic Control: request "其他车辆请让行"
Vehicle B: agree "同意让行"
Vehicle C: agree "同意让行"
Traffic Control: inform "路径已清空"
Vehicle A: inform "已通过路口"
```

### 5.4 电商推荐系统

```
场景：个性化推荐

架构：
┌─────────────────────────────────────┐
│  Recommendation Manager Agent       │
│  - 协调推荐任务                      │
│  - 整合推荐结果                      │
└─────────────────────────────────────┘
         ↓ Google A2A Protocol
┌─────────────┬─────────────┬─────────────┐
│  User Prof  │  History    │  Preference │
│  Agent      │  Agent      │  Agent      │
└─────────────┴─────────────┴─────────────┘

协议交互：

Manager: request "获取用户123的推荐"
User Profile Agent: response "用户画像：年轻人，喜欢科技产品"
History Agent: response "历史：购买过iPhone、MacBook"
Preference Agent: response "偏好：高端产品、快配送"
Manager: inform "推荐结果：iPhone 15、MacBook Pro"
```

### 5.5 医疗诊断系统

```
场景：多 Agent 诊断协作

架构：
┌─────────────────────────────────────┐
│  Diagnostic Coordinator Agent       │
│  - 协调诊断流程                      │
│  - 整合诊断结果                      │
└─────────────────────────────────────┘
         ↓ FIPA Query Protocol
┌─────────────┬─────────────┬─────────────┐
│  Lab Result │  Imaging    │  Symptoms   │
│  Agent      │  Agent      │  Agent      │
└─────────────┴─────────────┴─────────────┘

协议交互：

Coordinator: query-if "白细胞是否异常？"
Lab Result Agent: reply "白细胞计数偏高（15.0）"
Coordinator: query-ref "肺部影像有无异常？"
Imaging Agent: reply "肺部有阴影，疑似感染"
Coordinator: query-if "有无发热症状？"
Symptoms Agent: reply "有发热（38.5°C）"
Coordinator: inform "诊断结果：肺部感染，建议抗生素治疗"
```

---

## 六、具体协议示例

### 6.1 FIPA ACL 完整示例

#### 示例1：数据库删除协作

```json
// Step 1: Alice 发送删除请求
{
  "performative": "request",
  "sender": "agent_alice",
  "receiver": ["agent_bob"],
  "content": {
    "action": "delete",
    "object": "database",
    "name": "test_db"
  },
  "protocol": "fipa-request",
  "conversation-id": "conv_001",
  "reply-with": "reply_001",
  "reply-by": "2025-01-01T12:00:00Z",
  "language": "fipa-sl",
  "ontology": "database-management"
}

// Step 2: Bob 同意删除
{
  "performative": "agree",
  "sender": "agent_bob",
  "receiver": ["agent_alice"],
  "content": {
    "action": "agree-to-delete",
    "database": "test_db",
    "estimated-time": "30 seconds"
  },
  "protocol": "fipa-request",
  "conversation-id": "conv_001",
  "in-reply-to": "reply_001",
  "reply-with": "reply_002"
}

// Step 3: Bob 执行删除并通知完成
{
  "performative": "inform",
  "sender": "agent_bob",
  "receiver": ["agent_alice"],
  "content": {
    "action": "deleted",
    "database": "test_db",
    "status": "success",
    "timestamp": "2025-01-01T11:00:30Z"
  },
  "protocol": "fipa-request",
  "conversation-id": "conv_001",
  "in-reply-to": "reply_002"
}

// 或者：Bob 拒绝删除（风险高）
{
  "performative": "refuse",
  "sender": "agent_bob",
  "receiver": ["agent_alice"],
  "content": {
    "action": "refuse-to-delete",
    "reason": "database is production",
    "database": "test_db"
  },
  "protocol": "fipa-request",
  "conversation-id": "conv_001",
  "in-reply-to": "reply_001"
}
```

#### 示例2：任务征集协作

```json
// Step 1: Manager 征集任务执行方案
{
  "performative": "call-for-proposal",
  "sender": "agent_manager",
  "receiver": ["agent_alice", "agent_bob", "agent_charlie"],
  "content": {
    "task": "optimize_database",
    "constraints": {
      "max-time": "2 hours",
      "min-performance-gain": "50%"
    }
  },
  "protocol": "fipa-contract-net",
  "conversation-id": "conv_002",
  "reply-by": "2025-01-01T13:00:00Z"
}

// Step 2: Alice 提交提议
{
  "performative": "propose",
  "sender": "agent_alice",
  "receiver": ["agent_manager"],
  "content": {
    "proposal": "optimize_indexes",
    "estimated-time": "1 hour",
    "performance-gain": "60%",
    "steps": [
      "analyze current indexes",
      "create missing indexes",
      "optimize query performance"
    ]
  },
  "protocol": "fipa-contract-net",
  "conversation-id": "conv_002",
  "reply-with": "prop_001"
}

// Step 3: Bob 提交提议
{
  "performative": "propose",
  "sender": "agent_bob",
  "receiver": ["agent_manager"],
  "content": {
    "proposal": "partition_database",
    "estimated-time": "1.5 hours",
    "performance-gain": "70%",
    "steps": [
      "analyze data distribution",
      "create partitions",
      "optimize queries for partitions"
    ]
  },
  "protocol": "fipa-contract-net",
  "conversation-id": "conv_002",
  "reply-with": "prop_002"
}

// Step 4: Manager 接受 Alice 的提议（最快）
{
  "performative": "accept-proposal",
  "sender": "agent_manager",
  "receiver": ["agent_alice"],
  "content": {
    "accepted-proposal": "optimize_indexes",
    "task-id": "task_001"
  },
  "protocol": "fipa-contract-net",
  "conversation-id": "conv_002",
  "in-reply-to": "prop_001"
}

// Step 5: Manager 拒绝 Bob 的提议
{
  "performative": "reject-proposal",
  "sender": "agent_manager",
  "receiver": ["agent_bob"],
  "content": {
    "rejected-proposal": "partition_database",
    "reason": "too time-consuming"
  },
  "protocol": "fipa-contract-net",
  "conversation-id": "conv_002",
  "in-reply-to": "prop_002"
}

// Step 6: Alice 执行并通知完成
{
  "performative": "inform",
  "sender": "agent_alice",
  "receiver": ["agent_manager"],
  "content": {
    "status": "done",
    "task-id": "task_001",
    "result": {
      "indexes-created": 5,
      "performance-gain": "65%",
      "execution-time": "55 minutes"
    }
  },
  "protocol": "fipa-contract-net",
  "conversation-id": "conv_002"
}
```

### 6.2 Google A2A 完整示例

#### 示例：分布式文件处理

```json
// Coordinator 发送任务请求
{
  "jsonrpc": "2.0",
  "method": "request",
  "id": "req_001",
  "params": {
    "from": "coordinator",
    "to": ["file_processor_1", "file_processor_2"],
    "content": {
      "task": "process_files",
      "files": ["file1.txt", "file2.txt", "file3.txt"],
      "operation": "compress",
      "priority": "high"
    },
    "metadata": {
      "task_id": "task_001",
      "deadline": "2025-01-01T12:00:00Z"
    }
  },
  "timestamp": "2025-01-01T10:00:00Z"
}

// File Processor 1 接受任务
{
  "jsonrpc": "2.0",
  "method": "response",
  "id": "req_001",
  "params": {
    "from": "file_processor_1",
    "to": ["coordinator"],
    "content": {
      "status": "accept",
      "accepted_files": ["file1.txt", "file2.txt"],
      "estimated_time": "10 minutes"
    }
  },
  "timestamp": "2025-01-01T10:00:05Z"
}

// File Processor 2 接受任务
{
  "jsonrpc": "2.0",
  "method": "response",
  "id": "req_001",
  "params": {
    "from": "file_processor_2",
    "to": ["coordinator"],
    "content": {
      "status": "accept",
      "accepted_files": ["file3.txt"],
      "estimated_time": "5 minutes"
    }
  },
  "timestamp": "2025-01-01T10:00:05Z"
}

// File Processor 1 通知完成
{
  "jsonrpc": "2.0",
  "method": "inform",
  "id": "req_001",
  "params": {
    "from": "file_processor_1",
    "to": ["coordinator"],
    "content": {
      "status": "done",
      "processed_files": [
        {"file": "file1.txt", "compressed_size": "50KB"},
        {"file": "file2.txt", "compressed_size": "30KB"}
      ]
    }
  },
  "timestamp": "2025-01-01T10:10:00Z"
}

// File Processor 2 通知完成
{
  "jsonrpc": "2.0",
  "method": "inform",
  "id": "req_001",
  "params": {
    "from": "file_processor_2",
    "to": ["coordinator"],
    "content": {
      "status": "done",
      "processed_files": [
        {"file": "file3.txt", "compressed_size": "20KB"}
      ]
    }
  },
  "timestamp": "2025-01-01T10:05:00Z"
}

// Coordinator 通知任务完成
{
  "jsonrpc": "2.0",
  "method": "inform",
  "id": "req_001",
  "params": {
    "from": "coordinator",
    "to": ["file_processor_1", "file_processor_2"],
    "content": {
      "status": "task_completed",
      "total_files": 3,
      "total_compressed_size": "100KB",
      "message": "All files compressed successfully"
    }
  },
  "timestamp": "2025-01-01T10:10:05Z"
}
```

---

## 七、与 s17 的对比

### 7.1 s17 协议 vs FIPA ACL

| 维度 | s17 协议 | FIPA ACL |
|------|---------|---------|
| **标准化程度** | ❌ 自定义 | ✅ 国际标准 |
| **Performatives** | ❌ 无概念（只有 *_request/*_response） | ✅ 标准动作类型（request, inform, agree, ...） |
| **会话管理** | ❌ 只有 request_id | ✅ conversation-id + reply-with |
| **超时机制** | ❌ 无定义 | ✅ reply-by |
| **内容语言** | ❌ JSON（无语义） | ✅ FIPA SL（语义语言） |
| **知识本体** | ❌ 无定义 | ✅ ontology（语义共享） |
| **协议类型** | ❌ 只有 shutdown/plan_approval | ✅ 几十种标准协议 |
| **互操作性** | ❌ 无法互操作 | ✅ 不同系统可互操作 |

### 7.2 s17 协议 vs Google A2A

| 维度 | s17 协议 | Google A2A |
|------|---------|-----------|
| **消息格式** | ❌ 自定义 JSON | ✅ JSON-RPC 标准 |
| **动作类型** | ❌ *_request/*_response | ✅ method（request, inform, query） |
| **元数据** | ❌ metadata（无标准） | ✅ params.metadata（有标准） |
| **消息关联** | ✅ request_id | ✅ id（相同理念） |
| **时间戳** | ❌ ts（无标准） | ✅ timestamp（ISO 8601） |
| **互操作性** | ❌ 无法互操作 | ✅ 可与 Google 系统互操作 |

### 7.3 s17 吸收了哪些 A2A 理念？

```
s17 从 A2A 吸收的理念：

✅ request-response 模式
   - shutdown_request / shutdown_response
   - plan_approval_request / plan_approval_response
   - 类似 FIPA request / agree

✅ request_id 匹配
   - 用于关联请求和响应
   - 类似 FIPA conversation-id

✅ 状态管理
   - pending → approved → rejected
   - 类似 FIPA 协议状态机

✅ 消息路由
   - Lead → teammate
   - teammate → Lead
   - 类似 FIPA sender/receiver

✅ 协议优先级
   - shutdown_request 优先处理
   - 类似 FIPA 的协议优先级
```

---

## 八、如何选择 A2A 协议？

### 8.1 选择标准

```
选择 A2A 协议的维度：

1. 标准化程度
   - 需要互操作 → FIPA ACL（最标准）
   - 不需要互操作 → 自定义协议（更简单）

2. 复杂度
   - 需要完整功能 → FIPA ACL（几十种协议）
   - 需要简单快速 → Google A2A（轻量级）

3. 框架绑定
   - 使用 LangChain → LangChain Agent Protocol
   - 使用 CrewAI → CrewAI Protocol
   - 不使用框架 → FIPA ACL / Google A2A

4. 语义需求
   - 需要语义共享 → FIPA ACL（Ontology）
   - 不需要语义 → Google A2A / 自定义

5. 学习成本
   - 高容忍度 → FIPA ACL（学习成本高）
   - 低容忍度 → Google A2A / 自定义（学习成本低）
```

### 8.2 推荐方案

```
推荐方案：

┌─────────────────────────────────────┐
│  生产级系统                          │
│  推荐：FIPA ACL（或 Google A2A）     │
│  原因：                              │
│  - 需要互操作性                      │
│  - 需要标准化                        │
│  - 需要完整功能                      │
│  - 需要语义共享                      │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│  教学演示系统                        │
│  推荐：自定义简化协议（类似 s17）    │
│  原因：                              │
│  - 不需要互操作性                    │
│  - 需要简单易懂                      │
│  - 不需要完整功能                    │
│  - 学习成本低                        │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│  框架绑定系统                        │
│  推荐：框架内置协议                  │
│  原因：                              │
│  - 框架内置，易于使用                │
│  - 无需额外学习                      │
│  - 快速集成                          │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│  轻量级系统                          │
│  推荐：Google A2A                    │
│  原因：                              │
│  - 轻量级                            │
│  - 易于实现                          │
│  - JSON-RPC 风格                     │
│  - 学习成本低                        │
└─────────────────────────────────────┘
```

---

## 总结

### A2A 协议的核心价值

```
A2A 协议的核心价值：

✅ 标准化：不同系统可互操作
✅ 语义化：Agent 能理解消息含义
✅ 结构化：消息格式统一
✅ 可扩展：支持新协议类型

核心理念：
- Performatives：定义动作类型和意图
- conversation-id：关联请求和响应
- Ontology：共享语义理解
- 协议类型：定义交互模式
```

### 选择建议

```
实际应用建议：

1. 生产系统：采用标准 A2A 协议
   - FIPA ACL（最完整）
   - Google A2A（最现代）

2. 教学演示：采用简化自定义协议
   - 吸收 A2A 核心理念
   - 简化实现（如 s17）

3. 框架集成：采用框架内置协议
   - LangChain / CrewAI / AutoGen
   - 快速集成

4. 混合策略：LLM + 协议
   - LLM 提供语义理解
   - 协议提供结构化交互
   - 结合两者的优势
```

---

**参考资料**：
- [FIPA ACL Specification](http://www.fipa.org/specs/fipa00061/)
- [FIPA Communicative Act Library](http://www.fipa.org/specs/fipa00037/)
- [Google A2A Protocol](https://github.com/google/a2a-protocol)
- [KQML Specification](https://www.cs.cmu.edu/~kqml/)
- [LangChain Agent Protocol](https://python.langchain.com/docs/modules/agents/)
- [Microsoft Semantic Kernel](https://github.com/microsoft/semantic-kernel)
- [CrewAI Documentation](https://docs.crewai.com/)
- [AutoGen Documentation](https://microsoft.github.io/autogen/)
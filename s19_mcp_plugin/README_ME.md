# s19 MCP Plugin - 深度解析

## 目录

- [架构设计](#架构设计)
- [整体思想](#整体思想)
- [实现细节](#实现细节)
- [实际应用场景](#实际应用场景)
- [与其他模块的关系](#与其他模块的关系)
- [优缺点分析](#优缺点分析)
- [最佳实践](#最佳实践)

---

## 架构设计

### 1. 整体架构概览

s19_mcp_plugin 的核心目标是让 Agent 能够通过标准协议（MCP）接入外部工具。整体架构如下：

```
┌─────────────────────────────────────────────────────────┐
│                     Agent Loop                           │
│  (Lead Agent 主循环)                                     │
│                                                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │          assemble_tool_pool()                     │  │
│  │                                                   │  │
│  │  ┌─────────────┐      ┌──────────────────────┐  │  │
│  │  │ Builtin     │      │ MCP Tools            │  │  │
│  │  │ Tools       │      │ (mcp__server__tool)  │  │  │
│  │  │ - bash      │      │ - mcp__docs__search  │  │  │
│  │  │ - read_file │      │ - mcp__deploy__trigger│ │  │
│  │  │ - ...       │      │ - ...                │  │  │
│  │  └─────────────┘      └──────────────────────┘  │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
         │                              │
         │                              │
         ▼                              ▼
┌─────────────────┐          ┌──────────────────────┐
│ Builtin Handlers│          │   MCP Clients        │
│ (Python 函数)    │          │                      │
└─────────────────┘          │  ┌────────────────┐ │
                              │  │ docs server    │ │
                              │  │ - search()     │ │
                              │  │ - get_version()│ │
                              │  └────────────────┘ │
                              │  ┌────────────────┐ │
                              │  │ deploy server  │ │
                              │  │ - trigger()    │ │
                              │  │ - status()     │ │
                              │  └────────────────┘ │
                              └──────────────────────┘
```

### 2. 核心组件关系

#### 2.1 MCPClient 类

`MCPClient` 是连接外部 MCP Server 的客户端，负责：
- **工具发现**：从 server 获取工具列表（tools/list）
- **工具调用**：调用 server 提供的工具（tools/call）

```python
class MCPClient:
    def __init__(self, name: str):
        self.name = name
        self.tools: list[dict] = []      # 发现的工具列表
        self._handlers: dict[str, callable] = {}  # 工具处理器

    def register(self, tool_defs, handlers):
        """注册工具定义和处理器（模拟 tools/list）"""
        self.tools = tool_defs
        self._handlers = handlers

    def call_tool(self, tool_name: str, args: dict) -> str:
        """调用工具（模拟 tools/call）"""
        handler = self._handlers.get(tool_name)
        if not handler:
            return f"MCP error: unknown tool '{tool_name}'"
        return handler(**args)
```

**关键点**：
- 教学版使用 mock handler 模拟真实 server
- 真实版会通过 stdio/HTTP/WebSocket 与子进程通信
- 使用 JSON-RPC 协议进行消息传递

#### 2.2 connect_mcp 工具

`connect_mcp` 是 Agent 可调用的工具，用于连接 MCP Server：

```python
def connect_mcp(name: str) -> str:
    # 1. 检查是否已连接
    if name in mcp_clients:
        return f"MCP server '{name}' already connected"

    # 2. 查找 server 工厂函数
    factory = MOCK_SERVERS.get(name)
    if not factory:
        return f"Unknown server '{name}'. Available: ..."

    # 3. 创建 client 实例并连接
    mcp_client = factory()
    mcp_clients[name] = mcp_client

    # 4. 返回发现的工具列表
    tool_names = [t["name"] for t in mcp_client.tools]
    return f"Connected to '{name}'. Discovered: {tool_names}"
```

**执行流程**：
1. 检查重复连接
2. 查找可用的 server
3. 实例化 MCPClient
4. 返回发现的工具列表

#### 2.3 assemble_tool_pool 工具池组装

这是最核心的函数，负责将内置工具和 MCP 工具组装成统一的工具池：

```python
def assemble_tool_pool() -> tuple[list[dict], dict]:
    """组装内置工具 + 所有 MCP 工具"""
    # 1. 从内置工具开始
    tools = list(BUILTIN_TOOLS)
    handlers = dict(BUILTIN_HANDLERS)

    # 2. 遍历所有已连接的 MCP server
    for server_name, mcp_client in mcp_clients.items():
        # 3. 规范化 server 名称
        safe_server = normalize_mcp_name(server_name)

        # 4. 为每个工具添加前缀
        for tool_def in mcp_client.tools:
            safe_tool = normalize_mcp_name(tool_def["name"])
            prefixed = f"mcp__{safe_server}__{safe_tool}"

            # 5. 添加到工具池
            tools.append({
                "name": prefixed,
                "description": tool_def.get("description", ""),
                "input_schema": tool_def.get("inputSchema", {}),
            })

            # 6. 创建闭包绑定 handler
            handlers[prefixed] = (
                lambda *, c=mcp_client, t=tool_def["name"], **kw:
                    c.call_tool(t, kw)
            )

    return tools, handlers
```

**关键设计**：
- **前缀命名**：`mcp__{server}__{tool}` 避免命名冲突
- **名称规范化**：`normalize_mcp_name` 防止特殊字符注入
- **闭包绑定**：lambda 捕获 client 和原始工具名
- **动态组装**：每次调用都重新构建，支持运行时动态添加工具

### 3. 数据流图

```
用户输入: "Connect to docs server and search for API"
    │
    ▼
Agent Loop (lead agent)
    │
    ├─> 调用 connect_mcp("docs")
    │   ├─> 创建 MCPClient("docs")
    │   ├─> 注册工具: search, get_version
    │   └─> 返回: "Connected to 'docs'. Discovered: search, get_version"
    │
    ├─> 重新组装工具池 assemble_tool_pool()
    │   ├─> 添加 mcp__docs__search
    │   └─> 添加 mcp__docs__get_version
    │
    └─> 调用 mcp__docs__search({"query": "API"})
        ├─> MCPClient.call_tool("search", {"query": "API"})
        └─> 返回: "[docs] Found 3 results for 'API'"
```

---

## 整体思想

### 1. 设计理念：标准化插件协议

#### 1.1 问题背景

在 s01-s18 中，所有工具都是手写的：

```python
# s01-s18: 手动添加工具
BUILTIN_TOOLS = [
    {"name": "bash", ...},
    {"name": "read_file", ...},
    {"name": "write_file", ...},
    # 每个工具都需要手动实现
]
```

**痛点**：
- 要接入新服务（Jira、Notion、部署系统），需要写大量代码
- 不同服务接口各异，难以统一管理
- 维护成本高，扩展性差

#### 1.2 解决思路：MCP 协议

MCP（Model Context Protocol）定义了标准接口：

```typescript
// Server 必须实现的接口
interface MCPServer {
  // 1. 工具发现
  tools/list(): {
    tools: Array<{
      name: string;
      description: string;
      inputSchema: JSONSchema;
    }>;
  };

  // 2. 工具调用
  tools/call(request: {
    name: string;
    arguments: object;
  }): {
    content: Array<{
      type: "text" | "image" | "resource";
      text?: string;
    }>;
    isError?: boolean;
  };
}
```

**优势**：
- Server 只需实现标准接口
- Agent 自动发现和调用
- 可用任意语言实现（Python、Node.js、Go...）
- 一次实现，多处复用

### 2. 核心概念

#### 2.1 工具发现（Tool Discovery）

MCP 采用**动态发现**机制：

```python
# 1. Server 声明提供的工具
server.register(
    tool_defs=[
        {"name": "search", "description": "Search docs. (readOnly)", ...},
        {"name": "get_version", "description": "Get version. (readOnly)", ...},
    ],
    handlers={"search": ..., "get_version": ...}
)

# 2. Client 连接时自动发现
mcp_client = factory()
print(mcp_client.tools)  # 自动获取工具列表
# 输出: [{"name": "search", ...}, {"name": "get_version", ...}]
```

**好处**：
- Server 可以动态增减工具
- Client 无需预知工具详情
- 支持版本升级和功能扩展

#### 2.2 命名空间隔离

使用 `mcp__{server}__{tool}` 前缀避免冲突：

```python
# 场景：两个 server 都有 "search" 工具
docs_server.tools = [{"name": "search", ...}]    # 文档搜索
wiki_server.tools = [{"name": "search", ...}]    # Wiki 搜索

# 组装后的工具池
tools = [
    {"name": "mcp__docs__search", ...},   # 文档搜索
    {"name": "mcp__wiki__search", ...},   # Wiki 搜索
]
```

**为什么用双下划线**：
- 清晰分隔 server 和 tool
- 避免与内置工具冲突（内置工具没有 `mcp__` 前缀）
- 便于解析来源

#### 2.3 名称安全规范化

`normalize_mcp_name` 防止注入攻击：

```python
_DISALLOWED_CHARS = re.compile(r'[^a-zA-Z0-9_-]')

def normalize_mcp_name(name: str) -> str:
    """将非 [a-zA-Z0-9_-] 的字符替换为 _"""
    return _DISALLOWED_CHARS.sub('_', name)

# 示例
normalize_mcp_name("my-server!")  # => "my_server_"
normalize_mcp_name("tool$v1")     # => "tool_v1"
```

**安全考虑**：
- 防止特殊字符导致解析错误
- 避免注入恶意代码
- 确保名称在工具池中唯一

### 3. 关键设计决策

#### 3.1 为什么去掉 Prompt Cache

s10-s18 使用 prompt cache 优化性能：

```python
# s18: 有缓存
def agent_loop(messages, context):
    tools = BUILTIN_TOOLS  # 固定不变
    system = assemble_system_prompt(context)  # 可以缓存
    # ...
```

s19 去掉了缓存：

```python
# s19: 无缓存
def agent_loop(messages, context):
    tools, handlers = assemble_tool_pool()  # 每次重新构建
    system = assemble_system_prompt(context)  # 每次重新生成

    # 特别处理：connect_mcp 后重建
    if any(b.name == "connect_mcp" for b in response.content):
        tools, handlers = assemble_tool_pool()
        system = assemble_system_prompt(context)
```

**原因**：
- `connect_mcp` 后工具池变化
- 缓存的工具列表是旧的
- 模型无法调用新工具

**代价**：
- 每次调用多花序列化时间
- 但换来了动态扩展能力

#### 3.2 为什么 MCP 工具只给 Lead Agent

教学版中，MCP 工具只对 Lead Agent 可用：

```python
# Lead Agent: 动态工具池
tools, handlers = assemble_tool_pool()  # 包含 MCP 工具

# Teammate Agent: 固定 8 个工具
sub_tools = [
    "bash", "read_file", "write_file",
    "send_message", "submit_plan", "list_tasks",
    "claim_task", "complete_task",
]
```

**教学简化原因**：
- 避免代码复杂度过高
- 展示核心概念即可

**真实 CC 的做法**：
- Teammate 继承父级的 MCP 配置
- 每个 agent 都可以使用 MCP 工具

---

## 实现细节

### 1. MCPClient 类实现

#### 1.1 基础结构

```python
class MCPClient:
    """MCP 客户端（教学版 mock）"""

    def __init__(self, name: str):
        self.name = name
        self.tools: list[dict] = []      # 工具定义列表
        self._handlers: dict[str, callable] = {}  # 工具处理器映射

    def register(self, tool_defs: list[dict], handlers: dict[str, callable]):
        """
        注册工具（模拟 tools/list 响应）

        Args:
            tool_defs: 工具定义列表
                [{"name": "search", "description": "...", "inputSchema": {...}}]
            handlers: 工具名 -> 处理函数的映射
                {"search": lambda query: ...}
        """
        self.tools = tool_defs
        self._handlers = handlers

    def call_tool(self, tool_name: str, args: dict) -> str:
        """
        调用工具（模拟 tools/call 请求）

        Args:
            tool_name: 工具名（原始名称，无前缀）
            args: 工具参数

        Returns:
            工具执行结果（字符串）
        """
        handler = self._handlers.get(tool_name)
        if not handler:
            return f"MCP error: unknown tool '{tool_name}'"

        try:
            return handler(**args)
        except Exception as e:
            return f"MCP error: {e}"
```

**关键点**：
- `tools` 存储工具定义，用于发现阶段
- `_handlers` 存储处理器，用于调用阶段
- 异常捕获确保错误不会中断 agent

#### 1.2 Mock Server 示例

教学版提供了两个 mock server：

```python
def _mock_server_docs():
    """文档搜索 server"""
    client = MCPClient("docs")
    client.register(
        tool_defs=[
            {
                "name": "search",
                "description": "Search documentation. (readOnly)",
                "inputSchema": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"]
                }
            },
            {
                "name": "get_version",
                "description": "Get API version. (readOnly)",
                "inputSchema": {"type": "object", "properties": {}, "required": []}
            },
        ],
        handlers={
            "search": lambda query: f"[docs] Found 3 results for '{query}'",
            "get_version": lambda: "[docs] API v2.1.0",
        })
    return client


def _mock_server_deploy():
    """部署系统 server"""
    client = MCPClient("deploy")
    client.register(
        tool_defs=[
            {
                "name": "trigger",
                "description": "Trigger a deployment. (destructive — requires approval in real CC)",
                "inputSchema": {
                    "type": "object",
                    "properties": {"service": {"type": "string"}},
                    "required": ["service"]
                }
            },
            {
                "name": "status",
                "description": "Check deployment status. (readOnly)",
                "inputSchema": {
                    "type": "object",
                    "properties": {"service": {"type": "string"}},
                    "required": ["service"]
                }
            },
        ],
        handlers={
            "trigger": lambda service: f"[deploy] Triggered: {service}",
            "status": lambda service: f"[deploy] {service}: running (v1.4.2)",
        })
    return client
```

**注意标注**：
- `(readOnly)`：只读操作，不需要权限确认
- `(destructive)`：破坏性操作，真实 CC 需要用户确认

### 2. 工具池组装算法

#### 2.1 assemble_tool_pool 核心逻辑

```python
def assemble_tool_pool() -> tuple[list[dict], dict]:
    """
    组装内置工具 + 所有 MCP 工具

    Returns:
        (tools, handlers): 工具定义列表和处理器映射
    """
    # 1. 从内置工具开始（固定）
    tools = list(BUILTIN_TOOLS)
    handlers = dict(BUILTIN_HANDLERS)

    # 2. 遍历所有已连接的 MCP server
    for server_name, mcp_client in mcp_clients.items():
        # 3. 规范化 server 名称
        safe_server = normalize_mcp_name(server_name)

        # 4. 为每个工具添加前缀
        for tool_def in mcp_client.tools:
            safe_tool = normalize_mcp_name(tool_def["name"])
            prefixed = f"mcp__{safe_server}__{safe_tool}"

            # 5. 构建工具定义
            tools.append({
                "name": prefixed,
                "description": tool_def.get("description", ""),
                "input_schema": tool_def.get("inputSchema", {}),
            })

            # 6. 创建处理器闭包
            # 关键：使用默认参数捕获当前值，避免闭包陷阱
            handlers[prefixed] = (
                lambda *, c=mcp_client, t=tool_def["name"], **kw:
                    c.call_tool(t, kw)
            )

    return tools, handlers
```

**闭包陷阱说明**：

```python
# ❌ 错误示例：闭包陷阱
for tool_def in mcp_client.tools:
    prefixed = f"mcp__{tool_def['name']}"
    # 错误：lambda 捕获的是变量引用，不是值
    handlers[prefixed] = lambda **kw: mcp_client.call_tool(tool_def["name"], kw)
# 结果：所有 handler 都调用最后一个工具

# ✅ 正确做法：使用默认参数捕获值
for tool_def in mcp_client.tools:
    prefixed = f"mcp__{tool_def['name']}"
    # 正确：默认参数在定义时求值
    handlers[prefixed] = (
        lambda *, t=tool_def["name"], **kw: mcp_client.call_tool(t, kw)
    )
```

#### 2.2 工具定义结构

```python
# MCP 工具定义（server 提供）
{
    "name": "search",           # 工具名（原始）
    "description": "...",       # 描述（含权限标注）
    "inputSchema": {           # JSON Schema
        "type": "object",
        "properties": {
            "query": {"type": "string"}
        },
        "required": ["query"]
    }
}

# 组装后的工具定义（给 LLM）
{
    "name": "mcp__docs__search",  # 加前缀
    "description": "...",         # 原样复制
    "input_schema": {...}         # 改名 inputSchema -> input_schema
}
```

### 3. connect_mcp 实现

```python
# 全局 MCP client 字典
mcp_clients: dict[str, MCPClient] = {}

# Server 工厂映射
MOCK_SERVERS = {
    "docs": _mock_server_docs,
    "deploy": _mock_server_deploy,
}

def connect_mcp(name: str) -> str:
    """
    连接 MCP server 并发现工具

    Args:
        name: server 名称（如 "docs", "deploy"）

    Returns:
        连接结果信息
    """
    # 1. 检查重复连接
    if name in mcp_clients:
        return f"MCP server '{name}' already connected"

    # 2. 查找 server
    factory = MOCK_SERVERS.get(name)
    if not factory:
        available = ", ".join(MOCK_SERVERS.keys())
        return f"Unknown server '{name}'. Available: {available}"

    # 3. 创建 client
    mcp_client = factory()
    mcp_clients[name] = mcp_client

    # 4. 返回发现的工具
    tool_names = [t["name"] for t in mcp_client.tools]
    print(f"  \033[31m[mcp] connected: {name} → {tool_names}\033[0m")
    return (f"Connected to MCP server '{name}'. "
            f"Discovered {len(mcp_client.tools)} tools: {', '.join(tool_names)}")
```

### 4. Agent Loop 集成

```python
def agent_loop(messages: list, context: dict):
    """Lead Agent 主循环（动态工具池，无缓存）"""

    # 1. 初始组装工具池
    tools, handlers = assemble_tool_pool()
    system = assemble_system_prompt(context)

    while True:
        # 2. 调用 LLM
        response = client.messages.create(
            model=MODEL, system=system, messages=messages,
            tools=tools, max_tokens=8000
        )

        messages.append({"role": "assistant", "content": response.content})

        # 3. 结束条件
        if response.stop_reason != "tool_use":
            return

        # 4. 执行工具
        results = []
        for block in response.content:
            if block.type != "tool_use":
                continue

            handler = handlers.get(block.name)
            output = handler(**block.input) if handler else "Unknown"
            results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": output
            })

        messages.append({"role": "user", "content": results})

        # 5. 关键：connect_mcp 后重建工具池
        if any(b.name == "connect_mcp" for b in response.content
               if b.type == "tool_use"):
            tools, handlers = assemble_tool_pool()  # 重建工具池
            context = update_context(context, messages)
            system = assemble_system_prompt(context)  # 重建 prompt
```

**关键逻辑**：
- 每次循环开始时组装工具池
- 检测到 `connect_mcp` 调用后立即重建
- 重建包括工具池和系统提示（工具列表在 prompt 中）

### 5. 名称规范化实现

```python
import re

# 非法字符正则
_DISALLOWED_CHARS = re.compile(r'[^a-zA-Z0-9_-]')

def normalize_mcp_name(name: str) -> str:
    """
    规范化 MCP 工具/服务器名称

    规则：
    - 允许：字母、数字、下划线、短横线
    - 其他：替换为下划线

    Args:
        name: 原始名称

    Returns:
        规范化后的名称

    Examples:
        >>> normalize_mcp_name("my-server!")
        'my_server_'
        >>> normalize_mcp_name("tool$v1")
        'tool_v1'
        >>> normalize_mcp_name("API_v2.0")
        'API_v2_0'
    """
    return _DISALLOWED_CHARS.sub('_', name)
```

---

## 实际应用场景

### 1. 场景一：接入公司 Jira API

#### 1.1 Server 实现

```python
# jira_mcp_server.py
import requests

class JiraMCPServer:
    def __init__(self, base_url: str, api_token: str):
        self.base_url = base_url
        self.headers = {"Authorization": f"Bearer {api_token}"}

    def list_tools(self):
        """返回工具定义"""
        return [
            {
                "name": "search_issues",
                "description": "Search Jira issues. (readOnly)",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "jql": {"type": "string", "description": "JQL query"},
                        "max_results": {"type": "integer", "default": 10}
                    },
                    "required": ["jql"]
                }
            },
            {
                "name": "create_issue",
                "description": "Create a Jira issue. (destructive)",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "project": {"type": "string"},
                        "summary": {"type": "string"},
                        "description": {"type": "string"},
                        "issue_type": {"type": "string"}
                    },
                    "required": ["project", "summary", "issue_type"]
                }
            }
        ]

    def call_tool(self, name: str, args: dict) -> str:
        """执行工具调用"""
        if name == "search_issues":
            return self._search_issues(args["jql"], args.get("max_results", 10))
        elif name == "create_issue":
            return self._create_issue(args)
        return f"Unknown tool: {name}"

    def _search_issues(self, jql: str, max_results: int) -> str:
        response = requests.get(
            f"{self.base_url}/rest/api/2/search",
            params={"jql": jql, "maxResults": max_results},
            headers=self.headers
        )
        issues = response.json()["issues"]
        return f"Found {len(issues)} issues:\n" + "\n".join(
            f"- {i['key']}: {i['fields']['summary']}" for i in issues
        )

    def _create_issue(self, args: dict) -> str:
        response = requests.post(
            f"{self.base_url}/rest/api/2/issue",
            json={
                "fields": {
                    "project": {"key": args["project"]},
                    "summary": args["summary"],
                    "description": args.get("description", ""),
                    "issuetype": {"name": args["issue_type"]}
                }
            },
            headers=self.headers
        )
        issue = response.json()
        return f"Created issue {issue['key']}"
```

#### 1.2 使用方式

```python
# Agent 端
connect_mcp("jira")  # 连接 Jira server
# 工具池新增：
# - mcp__jira__search_issues
# - mcp__jira__create_issue

# Agent 可以直接调用
mcp__jira__search_issues({"jql": "assignee = currentUser() AND status = 'In Progress'"})
mcp__jira__create_issue({
    "project": "PROJ",
    "summary": "Fix bug in MCP integration",
    "issue_type": "Bug"
})
```

### 2. 场景二：接入部署系统

#### 2.1 Server 实现

```python
class DeployMCPServer:
    def __init__(self, api_url: str):
        self.api_url = api_url
        self.deployments = {}  # 模拟部署状态

    def list_tools(self):
        return [
            {
                "name": "trigger_deploy",
                "description": "Trigger a deployment. (destructive)",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "service": {"type": "string"},
                        "version": {"type": "string"},
                        "environment": {"type": "string", "enum": ["staging", "prod"]}
                    },
                    "required": ["service", "version", "environment"]
                }
            },
            {
                "name": "get_status",
                "description": "Get deployment status. (readOnly)",
                "inputSchema": {
                    "type": "object",
                    "properties": {"deployment_id": {"type": "string"}},
                    "required": ["deployment_id"]
                }
            },
            {
                "name": "rollback",
                "description": "Rollback a deployment. (destructive)",
                "inputSchema": {
                    "type": "object",
                    "properties": {"deployment_id": {"type": "string"}},
                    "required": ["deployment_id"]
                }
            }
        ]

    def call_tool(self, name: str, args: dict) -> str:
        if name == "trigger_deploy":
            return self._trigger_deploy(**args)
        elif name == "get_status":
            return self._get_status(**args)
        elif name == "rollback":
            return self._rollback(**args)
        return f"Unknown tool: {name}"

    def _trigger_deploy(self, service, version, environment):
        deploy_id = f"deploy-{time.time_ns()}"
        self.deployments[deploy_id] = {
            "service": service,
            "version": version,
            "environment": environment,
            "status": "running",
            "start_time": time.time()
        }
        return f"Deployment triggered: {deploy_id}"

    def _get_status(self, deployment_id):
        if deployment_id not in self.deployments:
            return f"Deployment {deployment_id} not found"
        return json.dumps(self.deployments[deployment_id], indent=2)

    def _rollback(self, deployment_id):
        if deployment_id not in self.deployments:
            return f"Deployment {deployment_id} not found"
        self.deployments[deployment_id]["status"] = "rolled_back"
        return f"Rolled back {deployment_id}"
```

#### 2.2 使用示例

```python
# Agent 端
connect_mcp("deploy")

# 触发部署
result = mcp__deploy__trigger_deploy({
    "service": "api-gateway",
    "version": "v2.1.0",
    "environment": "staging"
})
# 输出: "Deployment triggered: deploy-1234567890"

# 检查状态
status = mcp__deploy__get_status({"deployment_id": "deploy-1234567890"})
# 输出: {"service": "api-gateway", "status": "running", ...}

# 回滚（destructive，真实 CC 需要用户确认）
rollback = mcp__deploy__rollback({"deployment_id": "deploy-1234567890"})
```

### 3. 场景三：接入知识库

```python
class NotionMCPServer:
    def __init__(self, api_key: str):
        self.api_key = api_key
        self.headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Notion-Version": "2022-06-28"
        }

    def list_tools(self):
        return [
            {
                "name": "search_pages",
                "description": "Search Notion pages. (readOnly)",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "filter": {"type": "object"}
                    },
                    "required": ["query"]
                }
            },
            {
                "name": "create_page",
                "description": "Create a Notion page. (destructive)",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "parent_id": {"type": "string"},
                        "title": {"type": "string"},
                        "content": {"type": "string"}
                    },
                    "required": ["parent_id", "title"]
                }
            },
            {
                "name": "get_page",
                "description": "Get page content. (readOnly)",
                "inputSchema": {
                    "type": "object",
                    "properties": {"page_id": {"type": "string"}},
                    "required": ["page_id"]
                }
            }
        ]
```

---

## 与其他模块的关系

### 1. 继承关系

s19 基于 s18，继承了以下功能：

| 模块 | 继承的功能 | 变化 |
|------|-----------|------|
| s10 | 系统提示组装 | 无变化 |
| s11 | 错误恢复 | 无变化 |
| s12 | 任务系统 | 无变化 |
| s13 | 后台任务 | 无变化 |
| s14 | 定时调度 | 无变化 |
| s15 | Agent 团队 | 无变化 |
| s16 | 团队协议 | 无变化 |
| s17 | 自主 Agent | 无变化 |
| s18 | Worktree 隔离 | 无变化 |
| **s19** | **MCP 插件** | **新增** |

### 2. 新增内容

```python
# s19 新增的组件
+ MCPClient              # MCP 客户端类
+ normalize_mcp_name     # 名称规范化函数
+ assemble_tool_pool     # 工具池组装函数
+ connect_mcp            # 连接 MCP 工具
+ mcp_clients            # 全局 MCP 客户端字典
+ MOCK_SERVERS           # Mock server 工厂
```

### 3. 修改内容

```python
# s19 修改的组件

# 1. BUILTIN_TOOLS 新增 connect_mcp
BUILTIN_TOOLS = [
    # ... 原有 17 个工具
    {"name": "connect_mcp", ...},  # 新增
]

# 2. BUILTIN_HANDLERS 新增处理器
BUILTIN_HANDLERS = {
    # ... 原有处理器
    "connect_mcp": run_connect_mcp,  # 新增
}

# 3. agent_loop 去掉缓存，动态组装工具池
def agent_loop(messages, context):
    tools, handlers = assemble_tool_pool()  # 动态组装
    system = assemble_system_prompt(context)  # 无缓存

    # connect_mcp 后重建
    if any(b.name == "connect_mcp" for b in response.content):
        tools, handlers = assemble_tool_pool()  # 重建
        system = assemble_system_prompt(context)
```

### 4. 与 s20 的关系

s19 是 s20 综合版本的前置章节：

```
s01 → s02 → ... → s18 → s19 → s20
                               ↑
                               └── 综合所有机制
```

s20 会将 s01-s19 的所有机制整合到一个完整的 harness 中。

---

## 优缺点分析

### 1. 优点

#### 1.1 标准化与扩展性

✅ **标准协议**
- Server 只需实现 MCP 接口
- Client 自动发现和调用
- 可用任意语言实现

✅ **动态扩展**
- 运行时添加新工具
- 无需重启 Agent
- 即插即用

✅ **命名空间隔离**
- 避免工具名冲突
- 清晰的来源追溯
- 安全的名称规范化

#### 1.2 开发效率

✅ **减少重复代码**
```python
# 之前：每个服务都要写工具代码
def jira_search_issues(...): ...
def jira_create_issue(...): ...
def deploy_trigger(...): ...
# ... 大量样板代码

# 之后：Server 只需实现接口
class MyServer:
    def list_tools(self): ...
    def call_tool(self, name, args): ...
```

✅ **统一管理**
- 所有外部工具通过 MCP 接入
- 统一的权限标注
- 统一的错误处理

#### 1.3 安全性

✅ **权限标注**
```python
"description": "Trigger deployment. (destructive)"
# 真实 CC 会拦截并要求用户确认
```

✅ **名称规范化**
- 防止注入攻击
- 避免路径遍历
- 确保名称唯一

### 2. 缺点

#### 2.1 性能开销

❌ **无缓存**
```python
# s18: 有缓存，工具池固定
tools = BUILTIN_TOOLS  # O(1)

# s19: 无缓存，每次重建
tools, handlers = assemble_tool_pool()  # O(n+m)
```

**影响**：
- 每次循环都要序列化工具列表
- 增加 API 调用成本
- LLM context 增大

**缓解**：
- 真实 CC 使用增量缓存
- 只在 connect_mcp 后重建

#### 2.2 教学简化

❌ **MCP 工具只给 Lead Agent**
- Teammate 无法使用 MCP 工具
- 限制了并行能力
- 真实 CC 支持继承

❌ **Mock 实现**
- 无法展示真实网络通信
- 无法展示进程管理
- 无法展示错误重试

#### 2.3 协议局限

❌ **单向调用**
- Agent → Server 主动调用
- Server 无法主动推送消息
- 真实 CC 支持反向通知（Channel）

❌ **无认证**
- 教学版假设 server 不需要认证
- 真实 CC 支持 OAuth 2.0 + PKCE

### 3. 权衡

| 方面 | 教学版 | 真实 CC |
|------|--------|---------|
| Transport | Mock stdio | stdio/SSE/HTTP/WS/SSE-IDE/SDK (6种) |
| 认证 | 无 | OAuth 2.0 + PKCE |
| 反向通知 | 无 | Channel notifications |
| 错误处理 | try/except | 分级错误 + 重连 |
| 配置来源 | 硬编码 | 多层配置优先级 |
| 工具继承 | 无 | 子 agent 继承父级配置 |
| 缓存策略 | 无缓存 | 增量缓存 |

---

## 最佳实践

### 1. Server 实现

#### 1.1 完善的工具描述

```python
# ✅ 好的描述
{
    "name": "search_issues",
    "description": (
        "Search Jira issues using JQL syntax. "
        "Returns up to max_results issues with key, summary, and status. "
        "(readOnly)"
    ),
    "inputSchema": {...}
}

# ❌ 差的描述
{
    "name": "search",
    "description": "Search stuff",  # 太模糊
    "inputSchema": {...}
}
```

#### 1.2 清晰的权限标注

```python
# ✅ 明确标注权限
{
    "name": "delete_issue",
    "description": "Delete a Jira issue. (destructive — requires approval)",
    "inputSchema": {...}
}

# ✅ 只读操作
{
    "name": "get_issue",
    "description": "Get issue details. (readOnly)",
    "inputSchema": {...}
}
```

#### 1.3 健壮的错误处理

```python
def call_tool(self, name: str, args: dict) -> str:
    try:
        # 验证参数
        if name == "search_issues":
            if not args.get("jql"):
                return "Error: jql parameter is required"
            return self._search_issues(args["jql"])

        return f"Error: Unknown tool '{name}'"

    except requests.HTTPError as e:
        return f"HTTP Error: {e.response.status_code}"
    except Exception as e:
        return f"Internal Error: {type(e).__name__}: {e}"
```

### 2. Client 使用

#### 2.1 按需连接

```python
# ✅ 按需连接
if need_jira:
    connect_mcp("jira")

if need_deploy:
    connect_mcp("deploy")

# ❌ 一次性连接所有
connect_mcp("jira")
connect_mcp("deploy")
connect_mcp("notion")
connect_mcp("github")
# 会增加 context 大小
```

#### 2.2 合理的命名

```python
# ✅ 清晰的 server 名称
MOCK_SERVERS = {
    "jira-api": jira_server,
    "deploy-system": deploy_server,
}

# ❌ 模糊的名称
MOCK_SERVERS = {
    "server1": jira_server,
    "server2": deploy_server,
}
```

### 3. 工具池管理

#### 3.1 避免工具爆炸

```python
# ❌ 过多的工具
tools = [
    "mcp__jira__search",
    "mcp__jira__create",
    "mcp__jira__update",
    "mcp__jira__delete",
    "mcp__jira__comment",
    "mcp__jira__assign",
    # ... 50+ 个工具
]
# LLM context 过大，性能下降

# ✅ 精简的工具集
tools = [
    "mcp__jira__search_issues",
    "mcp__jira__create_issue",
    # 只保留高频工具
]
```

#### 3.2 工具描述优化

```python
# ✅ 详细的 schema
{
    "name": "trigger_deploy",
    "inputSchema": {
        "type": "object",
        "properties": {
            "service": {
                "type": "string",
                "description": "Service name (e.g., 'api-gateway', 'web-frontend')"
            },
            "environment": {
                "type": "string",
                "enum": ["staging", "production"],
                "description": "Target environment"
            },
            "version": {
                "type": "string",
                "pattern": "^v\\d+\\.\\d+\\.\\d+$",
                "description": "Version in format vX.Y.Z"
            }
        },
        "required": ["service", "environment", "version"]
    }
}
```

### 4. 安全考虑

#### 4.1 输入验证

```python
def normalize_mcp_name(name: str) -> str:
    # ✅ 严格限制字符
    return _DISALLOWED_CHARS.sub('_', name)

def call_tool(self, name: str, args: dict) -> str:
    # ✅ 验证工具名
    if name not in self._handlers:
        return f"Error: Unknown tool '{name}'"

    # ✅ 验证参数
    schema = self._get_schema(name)
    validate(args, schema)  # JSON Schema 验证

    return self._handlers[name](**args)
```

#### 4.2 权限控制

```python
# 真实 CC 的实现
def check_permission(tool_name: str, args: dict) -> bool:
    tool = get_tool(tool_name)

    # 检查 destructive 标注
    if tool.get("destructive"):
        return ask_user_confirmation(tool_name, args)

    # 检查 readOnly 标注
    if tool.get("readOnly"):
        return True  # 自动批准

    # 默认需要确认
    return ask_user_confirmation(tool_name, args)
```

---

## 总结

s19_mcp_plugin 引入了 MCP（Model Context Protocol）插件系统，让 Agent 能够通过标准协议接入外部工具。核心价值在于：

### 核心创新

1. **标准协议**：Server 只需实现 `tools/list` + `tools/call` 接口
2. **动态发现**：连接后自动发现工具，无需预定义
3. **命名隔离**：`mcp__{server}__{tool}` 避免冲突
4. **运行时扩展**：支持运行时添加新工具

### 关键实现

- `MCPClient`：模拟 MCP 客户端
- `connect_mcp`：连接 MCP server
- `assemble_tool_pool`：动态组装工具池
- `normalize_mcp_name`：名称安全规范化
- 去掉 prompt cache 以支持动态工具池

### 实际价值

- **减少重复代码**：不再为每个服务写工具代码
- **统一管理**：所有外部工具通过 MCP 接入
- **易于扩展**：新服务只需实现 MCP 接口
- **安全可控**：权限标注 + 名称规范化

### 下一步

s20 Comprehensive Agent 会将 s01-s19 的所有机制整合到一个完整的 harness 中，形成一个真正可用的 AI Agent 框架。

---

## 参考资料

- [MCP Specification](https://modelcontextprotocol.io/)
- [Claude Code MCP Documentation](https://docs.anthropic.com/claude/docs/mcp)
- s18 Worktree Isolation
- s20 Comprehensive Agent
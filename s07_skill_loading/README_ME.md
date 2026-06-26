# s07 Skill Loading — 深度理解笔记

## 核心问题

```
你的项目有一套 React 组件规范、一份 SQL 风格指南、一份 API 设计文档。
你希望 Agent 自动遵守这些规范。

最直接的想法，全塞进 system prompt：

SYSTEM = (
    f"You are a coding agent. "
    + open("docs/react-style.md").read()       # 2000 行
    + open("docs/sql-style.md").read()         # 1500 行
    + open("docs/api-design.md").read()        # 3000 行
)

问题：
  ├─ 6500 行 system prompt
  ├─ Agent 每次调用 LLM 都带着这些文档
  ├─ 不管是在改 CSS 颜色还是修 SQL 查询
  ├─ 99% 的内容和当前任务无关
  ├─ 白白消耗 token
  ├─ 上下文窗口被无关知识占满
  └─ 真正重要的上下文（当前对话、文件内容）被稀释

类比：
  ├─ 就像随身带着整个图书馆
  ├─ 但你只需要查一本书
  ├─ 其他书占着背包空间
  └─ 真正需要的书反而找不到
```

---

## 一、宏观设计理念

### 1.1 核心设计："用到时再加载，别全塞 prompt 里"

```
设计理念：
  ├─ 知识不是一开始就全部加载
  ├─ 先告诉 Agent"有哪些知识可用"（目录）
  ├─ Agent 自己决定"需要哪个知识"
  ├─ 用到的时候才加载完整内容
  └─ 通过 tool_result 注入，不塞 system prompt

类比理解：
  ├─ 图书馆索引卡：先看索引卡（目录），知道有哪些书
  ├─ 按需借书：需要时才去书架拿书（加载完整内容）
  ├─ 不背包里塞满书：不把所有书都背在身上
  └─ 只拿需要的书：节省背包空间（上下文）
```

### 1.2 两级加载的设计

```
两级设计：

Layer 1（便宜，总是存在）：
  ├─ 位置：system prompt
  ├─ 时机：启动时注入（harness 扫描 skills/）
  ├─ 内容：技能名称 + 一行描述
  ├─ 代价：~100 tokens/skill
  ├─ 特点：每轮都带
  └─ 目的：让 Agent 知道"有哪些技能可用"

Layer 2（昂贵，按需）：
  ├─ 位置：tool_result
  ├─ 时机：Agent 调用 load_skill 时
  ├─ 内容：完整 SKILL.md 内容
  ├─ 代价：~2000 tokens/skill
  ├─ 特点：用到才花 token
  └─ 目的：提供完整的知识内容

关键区别：
  ├─ 技能内容不是 system prompt 的一部分
  ├─ 它作为一次工具结果进入当前 messages
  ├─ 后续调用会随历史一起携带
  ├─ 直到上下文压缩、截断或会话结束
  └─ 这和 s08 的 compact 自然衔接
```

---

## 二、技能的结构

### 2.1 skills/ 目录结构

```
skills/
  agent-builder/SKILL.md
  code-review/SKILL.md
  mcp-builder/SKILL.md
  pdf/SKILL.md
```

每个技能：
  ├─ 一个子目录
  ├─ 包含 SKILL.md 文件（技能定义）
  ├─ 可包含 references/、scripts/、assets/ 等资源
  └─ SKILL.md 可以指引后续资源访问

### 2.2 SKILL.md 的结构

```markdown
---
name: code-review
description: Code review skill for reviewing code changes
---

# Code Review Skill

## When to use
Use this skill when you need to review code changes...

## Instructions
1. Read the changed files
2. Check for common issues...
3. ...

## References
- See `references/checklist.md` for detailed checklist
- Run `scripts/run_linter.sh` for linting
```

**YAML frontmatter**：
```
解析字段：
  ├─ name：技能名称（显示名）
  ├─ description：一行描述（用于目录）
  └─ 其他字段（CC 中有更多字段）

Body：
  ├─ 完整的技能内容
  ├─ 使用说明
  ├─ 具体步骤
  └─ 资源引用
```

---

## 三、实现细节详解

### 3.1 启动时：扫描和注册

```python
# 技能注册表
SKILL_REGISTRY: dict[str, dict] = {}

def _scan_skills():
    """扫描 skills/ 目录，填充注册表"""
    if not SKILLS_DIR.exists():
        return
    for d in sorted(SKILLS_DIR.iterdir()):
        if not d.is_dir():
            continue
        manifest = d / "SKILL.md"
        if manifest.exists():
            raw = manifest.read_text()
            meta, body = _parse_frontmatter(raw)
            name = meta.get("name", d.name)
            desc = meta.get("description", raw.split("\n")[0].lstrip("#").strip())
            SKILL_REGISTRY[name] = {
                "name": name,
                "description": desc,
                "content": raw  # 存储完整内容
            }

# 启动时执行一次
_scan_skills()
```

**关键设计**：
```
启动时扫描：
  ├─ 扫描 skills/ 目录的所有子目录
  ├─ 解析每个 SKILL.md 的 YAML frontmatter
  ├─ 只提取 name 和 description（轻量）
  ├─ 存入 SKILL_REGISTRY 字典
  └─ 完整内容也存储（但暂不注入）

安全设计：
  ├─ 注册表查找，不走文件路径
  ├─ 没有路径遍历风险
  └─ load_skill 通过注册表查找
```

### 3.2 Frontmatter 解析

```python
def _parse_frontmatter(text: str) -> tuple[dict, str]:
    """解析 YAML frontmatter"""
    if not text.startswith("---"):
        return {}, text
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text
    try:
        meta = yaml.safe_load(parts[1]) or {}
    except yaml.YAMLError:
        meta = {}
    return meta, parts[2].strip()
```

**Frontmatter 格式**：
```markdown
---
name: skill-name
description: One-line description
---

Body content here...
```

**解析逻辑**：
```
检查：
  ├─ 必须以 "---" 开头
  ├─ 分割成三部分：["", YAML部分, Body部分]
  └─ 解析 YAML 部分（yaml.safe_load）

结果：
  ├─ meta：YAML 字典（name、description 等）
  └─ body：Body 文本（去除 frontmatter）
```

### 3.3 目录注入 SYSTEM

```python
def list_skills() -> str:
    """生成技能目录（名称 + 描述）"""
    if not SKILL_REGISTRY:
        return "(no skills found)"
    return "\n".join(
        f"- **{s['name']}**: {s['description']}" 
        for s in SKILL_REGISTRY.values()
    )

def build_system() -> str:
    """构建 SYSTEM prompt，注入技能目录"""
    catalog = list_skills()
    return (
        f"You are a coding agent at {WORKDIR}. "
        f"Skills available:\n{catalog}\n"
        "Use load_skill to get full details when needed."
    )

SYSTEM = build_system()  # 启动时构建
```

**SYSTEM prompt 示例**：
```
You are a coding agent at /path/to/workdir.
Skills available:
- **agent-builder**: Build custom agents with specific capabilities
- **code-review**: Review code for bugs and improvements
- **mcp-builder**: Build MCP servers and tools
- **pdf**: Extract text from PDF files

Use load_skill to get full details when needed.
```

**关键设计**：
```
目录注入：
  ├─ 只包含名称 + 描述（轻量）
  ├─ ~100 tokens/skill
  ├─ 每轮都带（因为 system prompt 每轮都发送）
  └─ Agent 知道"有哪些技能可用"

不注入完整内容：
  ├─ 完整内容 ~2000 tokens/skill
  ├─ 如果注入所有技能，上下文爆满
  └─ 只在需要时才加载
```

### 3.4 运行时：按需加载

```python
def load_skill(name: str) -> str:
    """加载完整技能内容"""
    skill = SKILL_REGISTRY.get(name)  # 通过注册表查找
    if not skill:
        return f"Skill not found: {name}"
    return skill["content"]  # 返回完整内容
```

**load_skill 工具定义**：
```python
{
    "name": "load_skill",
    "description": "Load the full content of a skill by name.",
    "input_schema": {
        "type": "object",
        "properties": {
            "name": {"type": "string"}
        },
        "required": ["name"]
    }
}
```

**Agent 调用流程**：
```
Agent 决定："我需要 SQL 风格指南"
    ↓
Agent 调用：tool_use: load_skill
    input: {name: "sql-style"}
    ↓
TOOL_HANDLERS["load_skill"] = load_skill
    ↓
load_skill("sql-style")
    ├─ 从 SKILL_REGISTRY 查找
    ├─ 返回完整 SKILL.md 内容
    └─ ~2000 tokens
    ↓
tool_result 注入 messages：
    {"role": "user", "content": [tool_result(..., content=完整 SKILL.md)]}
    ↓
后续轮次：
    ├─ Agent 可以看到完整技能内容
    ├─ 按照技能说明执行任务
    └─ SKILL.md 可以指引后续资源访问
```

---

## 四、完整的执行流程

### 4.1 启动阶段

```
程序启动：
    ↓
_scan_skills() 执行一次：
    ├─ 扫描 skills/ 目录
    ├─ 解析每个 SKILL.md 的 frontmatter
    ├─ 填充 SKILL_REGISTRY
    └─ 存储：name、description、content
    ↓
build_system() 构建 SYSTEM：
    ├─ list_skills() 生成目录
    ├─ 格式化："Skills available:\n- **name**: description\n..."
    ├─ 注入 SYSTEM prompt
    └─ 每轮都带（~100 tokens/skill）
    ↓
SYSTEM = build_system()
    ↓
Agent loop 开始
```

### 4.2 运行阶段（不调用技能）

```
用户输入："修一个 CSS 颜色问题"
    ↓
Agent 分析：
    ├─ 从 SYSTEM 看到："Skills available: ..."
    ├─ 判断："当前任务不需要任何技能"
    └─ 不调用 load_skill
    ↓
Agent 直接执行：
    ├─ read_file: style.css
    ├─ edit_file: style.css
    └─ 完成任务
    ↓
Skill 未加载：
    ├─ ~100 tokens（目录）一直在 system prompt
    ├─ 完整内容（~2000 tokens）未加载
    └─ 节省 token ✓
```

### 4.3 运行阶段（调用技能）

```
用户输入："Review this PR"
    ↓
Agent 分析：
    ├─ 从 SYSTEM 看到："Skills available: **code-review**: ..."
    ├─ 判断："这是 code review 任务，需要加载技能"
    └─ 决定调用 load_skill
    ↓
tool_use: load_skill
    input: {name: "code-review"}
    ↓
load_skill("code-review") 执行：
    ├─ 从 SKILL_REGISTRY 查找
    ├─ 返回完整 SKILL.md 内容
    └─ ~2000 tokens
    ↓
tool_result 注入 messages：
    {"role": "user", "content": [
        {
            "type": "tool_result",
            "tool_use_id": "...",
            "content": "# Code Review Skill\n...\n完整内容"
        }
    ]}
    ↓
后续轮次：
    ├─ Agent 可以看到完整技能内容
    ├─ 按照技能说明执行：
    │   ├─ "1. Read the changed files"
    │   ├─ "2. Check for common issues"
    │   ├─ "3. ..."
    │   └─ SKILL.md 指引后续资源访问
    ├─ Agent 调用其他工具：
    │   ├─ read_file: changed_file.py
    │   ├─ read_file: references/checklist.md（SKILL.md 引导）
    │   ├─ bash: scripts/run_linter.sh（SKILL.md 引导）
    │   └─ ...
    └─ 完成任务
```

---

## 五、关键设计决策

### 5.1 为什么不是一开始就加载所有技能？

```
错误做法：
  SYSTEM = (
      f"You are a coding agent. "
      + load_all_skills()  # 加载所有技能完整内容
  )

问题：
  ├─ 如果有 10 个技能，每个 ~2000 tokens
  ├─ 总共 ~20000 tokens 在 system prompt
  ├─ 每轮都带（即使不需要）
  ├─ 99% 的情况下，大部分技能无关
  ├─ 白白消耗 token
  └─ 上下文窗口被无关知识占满

正确做法（两级加载）：
  ├─ Layer 1：只注入目录（~100 tokens/skill）
  ├─ Layer 2：按需加载（用到才花 ~2000 tokens）
  └─ 平均节省 ~90% 的 token ✓
```

### 5.2 为什么通过 tool_result 注入，不修改 system prompt？

```
设计原因：

System prompt：
  ├─ 每轮都会发送到 API
  ├─ 如果动态修改 system prompt
  ├─ Prompt Cache 无法命中（字节级不一致）
  └─ 每轮都要重新计算 system prompt

Tool_result：
  ├─ 只在当前 messages 中
  ├─ 不影响 system prompt 的稳定性
  ├─ Prompt Cache 可以命中 system prompt ✓
  ├─ 后续轮次会随历史携带
  └─ 直到上下文压缩（s08）
```

### 5.3 为什么用注册表查找，不走文件路径？

```
安全原因：

文件路径方式：
  ├─ load_skill("sql-style")
  ├─ open(f"skills/{name}/SKILL.md")  ← 路径拼接
  ├─ 可能路径遍历攻击：load_skill("../../etc/passwd")
  └─ 安全风险 ❌

注册表查找：
  ├─ SKILL_REGISTRY.get(name)  ← 字典查找
  ├─ 只能查找启动时扫描的技能
  ├─ 无法访问其他路径
  └─ 安全 ✓

类比：
  ├─ 文件路径：直接访问文件系统（危险）
  └─ 注册表：只能访问预定义的技能（安全）
```

### 5.4 SKILL.md 为什么可以指引后续资源访问？

```
设计原因：

SKILL.md 内容：
  # Code Review Skill
  
  ## Instructions
  1. Read the changed files
  2. Check for common issues...
  
  ## References
  - See `references/checklist.md` for detailed checklist
  - Run `scripts/run_linter.sh` for linting

作用：
  ├─ SKILL.md 不仅是静态知识
  ├─ 还可以指引 Agent 访问其他资源
  ├─ Agent 加载技能后，看到指引
  ├─ Agent 调用现有工具：
  │   ├─ read_file: references/checklist.md
  │   ├─ bash: scripts/run_linter.sh
  │   └─ glob: references/*.md
  └─ 技能只是一个"入口"，后续可以访问更多资源

类比：
  ├─ SKILL.md：图书馆的索引卡
  ├─ 索引卡告诉你：需要什么书，去哪个书架
  ├─ Agent 根据指引，去书架拿书（read_file）
  └─ 技能指引了后续的知识访问路径
```

---

## 六、ClaudeCode 的真实实现（基于源码）

### 6.1 技能来源：不是只有一个 skills/ 目录

**教学版的简化**：
```
教学版假设所有技能在 skills/ 目录
这是为了教学清晰，简化理解
```

**CC 的真实实现（多来源）**：

```
技能来源：

loadSkillsDir.ts：
  ├─ user skills（~/.claude/skills/）
  ├─ project skills（.claude/skills/）
  ├─ --add-dir skills（启动时指定的额外目录）
  └─ legacy commands（.claude/commands/）

bundledSkills.ts：
  ├─ 内置技能（随 CC 发布）
  └─ 如：claude-code-guide、statusline-setup

SkillTool.ts：
  ├─ MCP skills（远程技能）
  └─ 通过 MCP server 提供

commands.ts：
  └─ 命令聚合（skills 和 commands 的统一接口）

技能类型：
  ├─ managed/policy skills（组织级别的技能）
  ├─ user skills（用户自定义）
  ├─ project skills（项目自定义）
  ├─ --add-dir skills（临时添加）
  ├─ legacy commands（旧版命令格式）
  ├─ dynamic skills（运行时注入）
  ├─ conditional skills（条件激活）
  ├─ bundled skills（内置）
  ├─ plugin skills（插件提供）
  └─ MCP skills（远程）
```

### 6.2 SKILL.md Frontmatter 的完整字段

**教学版的简化**：
```
只解析 name 和 description
减少解析复杂度
```

**CC 的真实字段（parseSkillFrontmatterFields()）**：

| 字段 | 用途 |
|------|------|
| `name` / `description` | 显示名称和描述（目录层） |
| `when_to_use` | 指导模型何时调用 |
| `allowed-tools` | 技能可用工具的自动允许列表 |
| `context` | `inline`（默认）或 `fork`（作为子 Agent 运行） |
| `model` | 模型覆盖（haiku/sonnet/opus/inherit） |
| `hooks` | 技能级别的 hook 配置 |
| `paths` | 条件激活的 glob 模式 |
| `user-invocable` | 用户可以通过 `/name` 调用 |

**关键字段详解**：

#### `when_to_use`

```
作用：
  ├─ 指导模型何时调用这个技能
  ├─ 类似 system prompt 的"when to use"
  └─ 但技能级别的定制

示例：
  when_to_use: "Use this skill when you need to review code changes, 
                 check for bugs, or ensure code quality."

效果：
  ├─ 模型看到技能目录
  ├─ 目录包含 when_to_use（CC 中）
  ├─ 模型根据描述判断是否需要加载
  └─ 更精确的技能选择
```

#### `allowed-tools`

```
作用：
  ├─ 技能可用工具的自动允许列表
  ├─ 加载技能后，这些工具自动允许
  └─ 不需要用户手动批准

示例：
  allowed-tools: ["read_file", "bash"]

效果：
  ├─ Agent 加载 code-review 技能
  ├─ 技能允许 read_file 和 bash
  ├─ Agent 调用这些工具时，自动允许
  └─ 减少 permission prompts
```

#### `context: 'fork'`

```
作用：
  ├─ 技能作为子 Agent 运行
  ├─ 不是 inline（直接在当前对话）
  └─ spawn 一个子 Agent（类似 s06）

示例：
  context: fork

效果：
  ├─ Agent 调用 Skill 工具
  ├─ 不是返回完整内容
  ├─ 而是 spawn 一个子 Agent
  ├─ 子 Agent 专心执行技能任务
  └─ 完成后返回结果

关联 s06：
  ├─ Fork 模式：继承父对话上下文
  ├─ Forked Skills：技能级别的 fork
  └─ 每个技能可以选择 inline 或 fork
```

#### `model`

```
作用：
  ├─ 技能级别的模型覆盖
  ├─ 不同技能可以用不同模型
  └─ 优化成本和性能

示例：
  model: haiku  # 快速、便宜

效果：
  ├─ code-review 技能用 haiku（快速）
  ├─ agent-builder 技能用 sonnet（强大）
  ├─ 根据任务性质选择模型
  └─ 优化成本和性能
```

#### `paths`

```
作用：
  ├─ 条件激活的 glob 模式
  ├─ 当工作文件匹配 paths 时，自动激活技能
  └─ 不需要 Agent 手动判断

示例：
  paths: ["**/*.py", "**/test_*.py"]

效果：
  ├─ 用户打开 test_auth.py
  ├─ 文件路径匹配 paths（**/test_*.py）
  ├─ 测试技能自动激活
  ├─ 不需要 Agent 判断"需要测试技能"
  └─ 自动化的技能选择
```

#### `hooks`

```
作用：
  ├─ 技能级别的 hook 配置
  ├─ 加载技能后，注册额外的 hooks
  └─ 技能可以定制自己的行为

示例：
  hooks:
    PreToolUse: ["check_test_file"]
    PostToolUse: ["run_linter"]

效果：
  ├─ Agent 加载技能
  ├─ 技能注册自己的 hooks
  ├─ Agent 调用工具时，技能 hooks 执行
  └─ 技能级别的定制行为
```

#### `user-invocable`

```
作用：
  ├─ 用户可以通过 `/name` 调用
  ├─ 不需要 Agent 判断
  └─ 用户主动触发技能

示例：
  user-invocable: true

效果：
  ├─ 用户输入：/code-review
  ├─ 直接加载 code-review 技能
  ├─ 不需要 Agent 判断
  └─ 用户主动触发
```

### 6.3 两级加载的精确实现

#### Catalog（启动时）

```typescript
// CC 的真实实现

// 1. getSkillDirCommands()：扫描目录
function getSkillDirCommands(): Command[] {
  let commands = []
  
  // 扫描多个目录
  for (let dir of [userSkillsDir, projectSkillsDir, addDirSkills]) {
    for (let skillDir of dir.iterdir()) {
      let manifest = skillDir / "SKILL.md"
      if (manifest.exists()) {
        let meta = parseSkillFrontmatterFields(manifest)
        commands.push({
          name: meta.name,
          description: meta.description,
          whenToUse: meta.when_to_use,
          paths: meta.paths,
          context: meta.context || 'inline',
          model: meta.model || 'inherit',
          // ...只包含元数据，不包含完整内容
        })
      }
    }
  }
  
  return commands
}

// 2. getSkillListingAttachments()：格式化目录
function getSkillListingAttachments(): Attachment[] {
  let skills = getSkillDirCommands()
  
  // 预算：上下文窗口的 ~1%（上限 8000 字符）
  let budget = Math.min(8000, contextWindow * 0.01)
  
  let listing = skills.map(s => 
    `- **${s.name}**: ${s.description}`
  ).join("\n")
  
  // 如果超出预算，截断
  if (listing.length > budget) {
    listing = listing.slice(0, budget) + "\n... (more skills available)"
  }
  
  return [{
    type: "text",
    text: `Skills available:\n${listing}\nUse Skill tool to load full details.`
  }]
}
```

**关键设计**：
```
预算限制：
  ├─ 技能目录占用上下文窗口的 ~1%
  ├─ 上限 8000 字符
  ├─ 如果技能太多，截断
  └─ 防止目录占满上下文

只包含元数据：
  ├─ name、description、when_to_use、paths 等
  ├─ 不包含完整 SKILL.md 内容
  └─ 保持在轻量级别
```

#### Load（调用时）

```typescript
// CC 的真实实现

// 1. Skill 工具调用
async function SkillTool(input: {skill: string, args?: any}) {
  let skillName = input.skill
  let skill = findSkill(skillName)
  
  if (skill.context === 'fork') {
    // Fork 模式：spawn 子 Agent
    return spawnSkillSubagent(skill)
  } else {
    // Inline 模式：返回完整内容
    return loadInlineSkill(skill)
  }
}

// 2. Inline 模式
function loadInlineSkill(skill: Command): ToolResult {
  // getPromptForCommand()：展开完整 SKILL.md 内容
  let prompt = getPromptForCommand(skill)
  
  // 返回的 tool_result 只是提示
  let toolResult = `Launching skill: ${skill.name}`
  
  // 真正的内容通过 newMessages 注入
  let newMessages = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: prompt  // 完整 SKILL.md 内容
        }
      ]
    }
  ]
  
  return {
    toolResult,
    newMessages  // ← 关键：通过 newMessages 注入
  }
}

// 3. Fork 模式
function spawnSkillSubagent(skill: Command) {
  // 类似 s06 的 spawn_subagent
  let subAgent = createSubagent({
    system: skill.systemPrompt || "",
    tools: skill.allowedTools || ["*"],
    model: skill.model || "inherit",
    messages: [
      {
        role: "user",
        content: skill.prompt  // 技能的任务描述
      }
    ]
  })
  
  // 子 Agent 运行
  let result = await runAgent(subAgent)
  
  return result
}
```

**关键区别（教学版 vs CC）**：

```
教学版：
  ├─ load_skill 返回完整内容
  ├─ 直接通过 tool_result 注入
  └─ 简化实现

CC：
  ├─ Skill 工具返回 "Launching skill: {name}"
  ├─ 真正内容通过 newMessages 注入
  ├─ newMessages 是一个额外的消息列表
  └─ 会被追加到当前 messages

为什么这样设计？
  ├─ Tool_result 有大小限制
  ├─ 完整 SKILL.md 可能很大
  ├─ 通过 newMessages 可以注入更大内容
  └─ 更灵活的内容注入机制
```

### 6.4 Conditional Skills（条件技能）

```typescript
// CC 的真实实现

// 1. paths frontmatter 的解析
function parseSkillFrontmatterFields(manifest: string) {
  let meta = parseYaml(manifest)
  
  return {
    paths: meta.paths || [],  // glob 模式数组
    // ...其他字段
  }
}

// 2. 文件路径匹配
function shouldActivateSkill(skill: Command, filePath: string): boolean {
  if (!skill.paths || skill.paths.length === 0) {
    return false
  }
  
  // glob 模式匹配
  for (let pattern of skill.paths) {
    if (matchGlob(pattern, filePath)) {
      return true
    }
  }
  
  return false
}

// 3. 自动激活
function autoActivateSkills(filePath: string) {
  let skills = getSkillDirCommands()
  
  for (let skill of skills) {
    if (shouldActivateSkill(skill, filePath)) {
      // 自动加载技能
      loadSkill(skill.name)
    }
  }
}

// 4. 触发时机
// 当 Agent 调用 read_file 或其他文件相关工具时
// harness 检查文件路径是否匹配技能的 paths
// 如果匹配，自动激活技能
```

**设计意义**：
```
条件激活：
  ├─ 不需要 Agent 判断"需要什么技能"
  ├─ 根据工作文件路径自动判断
  ├─ 用户打开 test_auth.py → 测试技能激活
  ├─ 用户打开 api_design.md → API 技能激活
  └─ 自动化的技能选择 ✓

类比：
  ├─ 就像 IDE 的自动补全
  ├─ 打开 Python 文件 → Python 补全激活
  ├─ 打开 JavaScript 文件 → JS 补全激活
  └─ 根据上下文自动选择
```

---

## 七、教学版 vs 生产版对比

| 方面 | 教学版（s07） | 生产版（CC） |
|------|--------------|-------------|
| 技能来源 | 一个 skills/ 目录 | 多来源（user/project/--add-dir/MCP/bundled） |
| Frontmatter 字段 | 只解析 name、description | 完整字段（when_to_use、allowed-tools、context、model、hooks、paths、user-invocable） |
| 目录注入 | 直接注入 SYSTEM | 预算限制（~1% 上下文，上限 8000 字符） |
| 加载方式 | tool_result 直接返回完整内容 | tool_result 提示 + newMessages 注入完整内容 |
| 技能模式 | 只有 inline | inline + fork（技能级别 fork） |
| 条件激活 | 无 | paths frontmatter + glob 匹配 + 自动激活 |
| 技能 Hooks | 无 | hooks frontmatter + 技能级别 hooks |
| 模型覆盖 | 无 | model frontmatter + 技能级别模型 |

**教学版的简化是刻意的**：
```
简化目的：
  ├─ 多文件多来源 → 1 个 skills/ 目录：足以展示两级加载核心概念
  ├─ 多个 frontmatter 字段 → 只解析 name/description：减少解析复杂度
  ├─ forked skills → 省略：教学版只展示 inline 技能加载
  ├─ newMessages → 省略：简化为 tool_result 直接返回
  ├─ 条件激活 → 省略：避免自动化的复杂逻辑
  └─ 技能 Hooks → 省略：避免 hook 注册的复杂逻辑

目标：
  ├─ 概念清晰
  ├─ 理解核心设计
  └─ 不陷入实现细节
```

---

## 八、类比理解总结

```
两级加载：

图书馆类比：
  ├─ Layer 1（目录）：图书馆索引卡
  │   ├─ 索引卡告诉你有哪些书（技能名称 + 描述）
  │   ├─ 索引卡很轻（~100 tokens）
  │   └─ 你可以快速浏览，知道有哪些资源
  │
  ├─ Layer 2（内容）：去书架拿书
  │   ├─ 需要时才去拿书（按需加载）
  │   ├─ 书的内容丰富（~2000 tokens）
  │   └─ 只拿需要的书，不背满整个图书馆
  │
  └─ 关键：
      ├─ 不背包里塞满书（不把所有知识塞 system prompt）
      ├─ 只看索引卡（目录注入 SYSTEM）
      ├─ 需要时才拿书（load_skill）
      └─ 节省背包空间（上下文）

──────────────────────────────────────────────────────────

技能指引后续资源：

书籍引用类比：
  ├─ SKILL.md：一本书
  ├─ 书里说："参考资料请参阅第 X 章"
  ├─ Agent 根据指引，去读第 X 章（read_file references/checklist.md）
  ├─ 书里说："运行脚本请执行 script.sh"
  ├─ Agent 根据指引，执行脚本（bash scripts/run_linter.sh）
  └─ 技能只是一个"入口"，指引后续的知识访问

──────────────────────────────────────────────────────────

条件激活：

IDE 自动补全类比：
  ├─ 打开 Python 文件 → Python 补全激活
  ├─ 打开 JavaScript 文件 → JS 补全激活
  ├─ 不需要手动判断"需要什么补全"
  └─ 根据文件类型自动选择

CC 的条件激活：
  ├─ 打开 test_*.py → 测试技能激活
  ├─ 打开 api_design.md → API 技能激活
  ├─ 不需要 Agent 判断
  └─ 根据文件路径自动选择

──────────────────────────────────────────────────────────

Forked Skills：

专家顾问类比：
  ├─ inline 模式：顾问直接在你的会议室工作
  │   ├─ 所有对话都在当前会议室
  │   ├─ 顾问可以看到所有上下文
  │   └─ 但可能干扰当前会议
  │
  ├─ fork 模式：顾问在另一个房间工作
  │   ├─ 顾问有独立的房间（子 Agent）
  │   ├─ 完成后把结果带回你的会议室
  │   ├─ 不干扰当前会议
  │   └─ 更干净的上下文隔离
  │
  └─ 技能可以选择 inline 或 fork
```

---

## 九、关键要点总结

1. **两级加载**：
   - Layer 1：目录注入 SYSTEM（~100 tokens/skill）
   - Layer 2：按需加载完整内容（~2000 tokens/skill）
   - 节省 ~90% token

2. **设计理念**：
   - "用到时再加载，别全塞 prompt 里"
   - 先告诉 Agent"有哪些知识可用"
   - Agent 自己决定"需要哪个知识"
   - 通过 tool_result 注入，不塞 system prompt

3. **技能结构**：
   - skills/ 目录，每个技能一个子目录
   - SKILL.md 包含 YAML frontmatter + Body
   - frontmatter：name、description 等
   - Body：完整知识内容 + 资源指引

4. **安全设计**：
   - 注册表查找，不走文件路径
   - 防止路径遍历攻击

5. **技能指引后续资源**：
   - SKILL.md 可以引用 references/、scripts/、assets/
   - Agent 根据指引调用现有工具访问资源
   - 技能是"入口"，指引知识访问路径

6. **CC 的真实实现**：
   - 多来源（user/project/MCP/bundled）
   - 完整 frontmatter 字段
   - 预算限制（~1% 上下文）
   - newMessages 注入机制
   - Forked Skills（技能级别 fork）
   - Conditional Skills（条件激活）
   - 技能 Hooks（技能级别 hooks）

7. **与后续章节的衔接**：
   - s08 Context Compact：
     - 按需加载解决"不该提前带的不要带"
     - Compact 解决"该丢的怎么丢"
     - 自然衔接，技能内容会被 compact

---

**核心哲学**：
```
知识按需加载 + 不堆满上下文 + 技能指引后续访问 + 自动化选择（条件激活）
```

这就是 ClaudeCode Skill Loading 的完整设计理念。

---

<!-- 文档版本：v1.0 -->
<!-- 创建时间：2026-06-22 -->
<!-- 基于 s07 教学版和 CC 源码的深度分析 -->
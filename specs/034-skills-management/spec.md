# Feature Specification: skills 管理完善——按目录来源分类 + 允许/不允许 + Claude/Codex 外接

**Feature Branch**: `release/0.5.8-20261112`

**Created**: 2026-11-14

**Status**: Approved（2026-11-14 用户拍板：Q1=b 项目禁用写 project settings 需信任、Q2=ab 预设两开关+自定义外接目录、Q3=b 软开关可切换（改写 SKILL.md frontmatter）、Q4=a 提示条+一键 reload）

**Input**: 用户提出（2026-11-14）
> skills 管理完善，按不同的目录来源分类。如果能支持 skill 的允许和是否允许就好了，
> 要标记是全局的还是项目的。还有，听说 Claude 和 Codex 的 skill 都能读取，如果能设置个
> 开关就设置个开关，并且也要区分展示。去探索吧 什么情况告诉我 有问题询问我。

**可行性结论（取证后）**：**全部可做**。来源分类、硬开关（settings 排除条目）、外接目录
（Claude/Codex 式）三条通路全部真机实证；唯一无法交付的是「读取 pi 未内置的
`~/.claude/skills`」——pi 1.5.0 不内置该路径，但 settings `skills` 数组可外接**任意目录**
（探针 4 实证），所以做成**外接来源开关**，语义等价、且区分展示。

## 取证记录（全部真机实证，探针脚本 `scripts/probe-034-skills.mjs`，evidence/probe-034-skills.json）

### pi 1.5.0 的技能来源（六类）

| 来源 | 位置 | 实证 |
|---|---|---|
| 用户 `.pi` | `<agent>/skills`（PI_CODING_AGENT_DIR 可重定向） | 探针 1 |
| 用户规范目录 | `~/.agents/skills`（Agent Skills 规范，**真实 HOME，不受 agent-dir 重定向影响**） | 探针 1 意外实证：沙箱里真机 `~/.agents/skills` 的 6 个真实技能默认加载 |
| 项目 `.pi` | `<repo>/.pi/skills` | 002/现有实现 |
| 项目规范目录 | `.agents/skills`（**cwd 沿祖先上溯，止于 repo 根**——文档明示，插件现只扫项目根） | docs/skills.md |
| 包 | pi 包可携带 skills（openwiki 实例），落在 `<agent>/npm/node_modules/<pkg>/…` | docs/packages.md + 033 安装实例 |
| 外接 | settings `skills: string[]` 任意目录 | **探针 4 实证：外部 claude 式目录加载成功** |

### 允许/不允许 = settings.json `skills` 数组的排除条目（真机实证）

| 形式 | 结果 |
|---|---|
| `-<exactPath>/SKILL.md`（精确排除） | **生效**（beta 消失） |
| `!<glob>`（glob 排除） | **生效**（beta 消失） |
| `-beta`（裸名） | 无效 |
| 组合于隐式发现之上 | 是——无需先写正向条目 |

排除条目写 user 级 settings（`~/.pi/agent/settings.json`）或 project 级（`.pi/settings.json`，
需项目信任）。**运行中的 pi 进程在启动时读取**——切换后需 reload 进程才生效（插件已有
`restartPiProcess` 先例，027 providerSave 同款）。

### 软开关 ≠ 硬开关

frontmatter `disable-model-invocation: true` 只是「不进模型自动选择」（`/skill:name` 手动
调用仍可用）——探针 1 实证 dim-model 仍在 get_commands 里。与「从发现中排除」是两种语义，
UI 必须区分展示（**仅手动调用**徽章 vs **已禁用**态）。

### Claude / Codex 兼容的真相

pi 1.5.0 **不读** `~/.claude/skills` / `~/.codex/skills`（bundle 全文无此路径，文档仅提
CLAUDE.md 是上下文文件）。用户听说的「能读取」实际是两条通路：
1. **Agent Skills 规范目录**（`~/.agents/skills`）——Claude Code 等工具的 SKILL.md 是
   同一 spec 格式，放进规范目录即共享（且 pi 已默认加载该目录）；
2. **settings 外接任意目录**——把 `~/.claude/skills`、`~/.codex/skills` 加进 `skills`
   数组即接入（探针 4 实证）。

→ 插件交付「外接来源开关」：预设 `~/.claude/skills` 与 `~/.codex/skills` 两个开关 +
自定义外接目录，外接技能带来源标记。

## 现状缺口（插件侧）

1. `skillsList` 只扫 3 目录：漏用户规范目录 `~/.agents/skills`、漏项目祖先上溯、无来源细分、
   包来源技能完全缺失（其路径在 agent/npm 下，现被归入「user」）。
2. 无任何开关写路径；`disableModelInvocation` 仅只读展示。
3. UI 平铺列表，无分组、无来源徽章。

## User Scenarios & Testing

### US1 - 按目录来源分组展示 (P1)

技能面板按来源分组：**用户 .pi / 用户规范目录 / 项目 .pi / 项目规范目录 / 扩展包 / 外接**，
每组带徽章与路径说明；项目组在未信任时整体标「未生效」（沿用 002 语义）。

### US2 - 允许/不允许开关 (P1)

每个技能行一个开关：**开 = 保持发现**，**关 = 从发现中排除**（settings 排除条目，精确
`-path` 形式）。关掉的行显示「已禁用」态且仍可见（可随时开回）。切换后提示「重启 pi 进程
生效」并提供一键 reload（复用现有 restartPiProcess）。全局技能写 user settings；项目技能
的排除写 project settings（待 Q2）。

### US3 - Claude/Codex 外接开关 (P2)

「外接来源」区：`~/.claude/skills` 与 `~/.codex/skills` 两个预设开关（开 = 写入 user
settings `skills` 数组）+ 自定义外接目录添加。外接技能带「外接」来源徽章，与本地技能
区分展示。

### US4 - 软开关可见 (P2)

`disable-model-invocation: true` 的技能显示「仅手动调用」徽章（现已有字段，补 UI 呈现 +
说明文案），开关区不动文件——写用户技能文件属于越界，展示 + 文档指引即可。

## Requirements（草案）

- **FR-001** 技能列表 MUST 覆盖六类来源（用户 .pi / 用户规范目录 / 项目 .pi / 项目规范目录含
  祖先上溯 / 包 / 外接），每条带 `source` 标签与所在目录；包来源按路径（agent/npm 前缀）归属。
- **FR-002** 同名冲突（pi 取首个发现并警告）MUST 标注「重名，首次发现的生效」。
- **FR-003** 允许/不允许开关 MUST 通过 settings `skills` 数组排除条目实现（`-<SKILL.md 精确
  路径>`），MUST NOT 改写技能文件本身；开关状态 MUST 反映当前 settings（排除=关）。
- **FR-004** 切换 MUST 提示需要 reload 并提供一键 reload 进程（复用 restartPiProcess）。
- **FR-005** 外接来源 MUST 以开关形式写入/移除 user settings `skills` 数组；外接技能来源标记。
- **FR-006** 新增桥接四处同步；mock 旋钮覆盖分组/开关/外接/冲突。
- **FR-007** 新文案双语。

## Decisions（待拍板）

| # | 问题 | 选项 | 推荐默认 |
|---|---|---|---|
| Q1 | 项目技能的禁用写哪 | a. 一律写 user settings（排除项目路径，全局生效） b. 项目排除写 project `.pi/settings.json`（需信任，作用域精确） | **a**——user 级排除不需要信任、实现单一；b 做成后续增强 |
| Q2 | 外接预设 | a. 只预设 ~/.claude/skills 与 ~/.codex/skills 两个开关 b. 再加自定义外接目录输入 | **b**——自定义顺手，成本一行输入框 |
| Q3 | 软开关（disable-model-invocation） | a. 只展示徽章不改文件 b. 提供切换（插件改写 SKILL.md frontmatter） | **a**——改用户文件越界，展示+指引 |
| Q4 | reload 时机 | a. 切换后弹提示条 + 一键 reload 按钮 b. 自动 reload | **a**——用户可能连续切多个 |

## 不做的事

- 不做技能编辑器（SKILL.md 内容交给 IDE 编辑器，002 已有先例）
- 不改写技能文件（软开关只展示）
- 不做技能市场/安装（技能通过包管理 033 安装）
- 不实现「读取 pi 未内置的 ~/.claude/skills」的原生能力——以外接开关交付，等 pi 上游支持后自然收敛

## 验证计划

实现后填写（探针脚本已入库：`scripts/probe-034-skills.mjs`；evidence/probe-034-skills.json）。

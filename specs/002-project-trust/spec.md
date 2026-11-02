# Feature Specification: 项目级资源的信任模型

**Feature Branch**: `002-project-trust`

**Created**: 2026-11-02

**Status**: Draft

**Input**: 用户需求：「还有哪些需要实现的功能」→ 产品设计 P3-6 要求「项目级 `.pi/` 资源仅在信任后生效」，
插件侧完全未实现。同时发现 `skillsList()` 用相对路径扫描项目级目录，多项目窗口下会指向错误位置。

## 背景：pi 的信任语义（实测）

- pi 把信任状态持久化在 `~/.pi/agent/trust.json`，结构为 `{ "<项目绝对路径>": true }`。
- 项目级资源（`.pi/mcp.json`、`.pi/settings.json`、`.pi/skills` 等）**只在受信任的项目中生效**。
  `pi mcp --help` 原文：`Reads ~/.pi/agent/mcp.json and, in trusted projects, .pi/mcp.json`。
- 单次运行可用 `--approve` / `--no-approve` 覆盖；对项目级文件执行写操作需要 `--approve`
  （如 `pi config -l --approve`）。
- **没有** `pi trust` 子命令，信任只能通过 `trust.json` 或上述运行参数影响。

**现实状况**：本机 `trust.json` 当前只有 `jetbrains-cc-gui-queue-message-edit` 一个条目，
`pi-agent-idea` 自身**未被信任**——即在当前项目里打开插件，项目级 skills/MCP 配置不会生效，
而插件界面既不显示也不解释这一点。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 看清项目级配置到底生不生效 (Priority: P1)

用户在项目里放了 `.pi/skills/` 和 `.pi/mcp.json`，但在插件里对话时这些能力根本没出现。
他以为是自己写错了配置，反复检查格式，却不知道是项目未被信任。

**Why this priority**: 这是「静默失效」——用户做对了所有事，系统却什么都不发生，也不解释。
比功能缺失更伤信任，所以排第一。

**Independent Test**: 在一个未信任的项目里打开 Manage 面板 → 项目级条目显示「未生效（项目未信任）」
并有一键信任入口；信任后条目变为生效态。

**Acceptance Scenarios**:

1. **Given** 当前项目未被信任且存在 `.pi/skills/`，**When** 用户打开 Manage 面板，**Then**
   这些 skills 显示为「项目级 · 未生效」，并给出原因「该项目尚未被 pi 信任」。
2. **Given** 当前项目已信任，**When** 用户打开同一面板，**Then** 项目级条目显示为生效态，不再有警告。
3. **Given** 项目级条目未生效，**When** 用户点击条目上的说明，**Then** 能看到一句可操作的解释
   （不是「请信任项目」这种循环废话，而是「信任后 pi 会加载该项目的 skills 与 MCP 配置」）。

---

### User Story 2 - 一键信任当前项目 (Priority: P1)

用户确认这个项目是自己写的、可以信任，想直接在当前 IDE 里把信任打开，而不是去终端敲 `pi --approve` 跑一轮。

**Why this priority**: 与 US1 成对——只显示问题不给解法等于没解决问题。

**Independent Test**: 点「信任本项目」→ 确认框列出即将生效的具体资源 → 确认后 `trust.json` 增加该项目条目，
无需重启即生效（或明确告知需新会话）。

**Acceptance Scenarios**:

1. **Given** 未信任的项目，**When** 用户点「信任本项目」，**Then** 弹出确认框，明确列出「将信任哪些内容」
   （项目级 skills / MCP / settings / 扩展），避免用户盲点。
2. **Given** 用户确认，**When** 操作完成，**Then** `trust.json` 中新增该项目的绝对路径且值为 `true`，
   面板状态立即更新。
3. **Given** 当前有运行中的会话，**When** 信任刚被打开，**Then** 提示「需新会话生效」，
   或由插件自动以 `--approve` 重启 pi 进程（二选一，实现时定）。
4. **Given** 写入 `trust.json` 失败（权限/磁盘），**When** 操作失败，**Then** 显示原始错误，且不谎报成功。

---

### User Story 3 - 撤销信任 (Priority: P2)

用户把项目分享给别人，或者克隆来一个不受信任的仓库，想确保项目级的配置不会被执行。

**Why this priority**: 安全兜底，但使用频率低于前两条。

**Independent Test**: 对已信任项目点「撤销信任」→ 二次确认 → `trust.json` 条目被移除 → 面板回到未生效态。

**Acceptance Scenarios**:

1. **Given** 已信任项目，**When** 用户点「撤销信任」，**Then** 需二次确认（信任是有安全含义的操作）。
2. **Given** 用户确认撤销，**When** 操作完成，**Then** `trust.json` 中该条目被删除，项目级条目立即变为未生效。
3. **Given** 本次 IDE 会话已按信任态启动过 pi，**When** 撤销信任，**Then** 明确提示需新会话（或重启进程）才彻底失效，
   不得让用户误以为当前进程已停止加载。

---

### User Story 4 - 项目级 skills 列对位置、标清来源 (Priority: P2)

用户在 `pi-agent-idea` 项目里放了 `.pi/skills/foo/SKILL.md`，但插件列的 skills 里既看不到它，
或者看到了却不知道它来自哪个层级。

**Why this priority**: 与 US1 同源（都是「项目级资源不可见/不可信」），但属于具体实现缺陷，修起来独立。

**Independent Test**: 在含 `.pi/skills/foo` 的项目里打开面板 → 列表出现 `foo` 且标注「项目级」；
切到另一个不含该目录的项目 → 列表中没有 `foo`。

**Acceptance Scenarios**:

1. **Given** 项目根下有 `.pi/skills/foo/SKILL.md`，**When** 用户查看 skills 列表，**Then** 出现 `foo`，
   标注来源为项目级，并显示其绝对路径。
2. **Given** 同一 IDE 打开了两个项目，**When** 分别在各自窗口查看 skills，**Then** 各自只看到自己的项目级 skills
   （不得因为当前工作目录相同而串台）。
3. **Given** `.pi/skills` 存在但项目未信任，**When** 用户查看列表，**Then** 该项以「未生效」样式呈现，
   与「用户级」条目视觉可区分。
4. **Given** 项目级目录不存在，**When** 用户查看列表，**Then** 不显示空的「项目级」分组，也不报错。

---

### Edge Cases

- **`trust.json` 不存在**：视为「无任何信任项目」，所有项目级条目为未生效；不得因文件缺失而报错。
- **`trust.json` 内容损坏**：显示明确原因（解析失败），且默认按「未信任」处理（fail-safe），
  不允许静默当作已信任。
- **Windows 路径大小写与分隔符**：`D:\code\Foo` 与 `d:/code/foo` 必须判定为同一项目，否则信任永远对不上。
- **符号链接的项目根**：以 IDE 认定的项目 basePath 为准，并同时比对 real path，避免链接路径导致失配。
- **同一项目同时被 IDE 和终端使用**：任一方修改 `trust.json` 后，另一方的状态可能滞后；
  插件在每次打开面板时重新读取，不做长缓存。
- **项目根是 IDE 的多模块子目录**：以打开的项目为单位，不为每个 module 单独判定。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 系统 MUST 能判定当前项目是否被信任，判定依据与 pi 一致（同一 `trust.json`、同一路径语义）。
- **FR-002**: 路径比较 MUST 归一化（大小写不敏感、分隔符统一），并兼容符号链接。
- **FR-003**: 未信任时，所有项目级资源条目 MUST 以「未生效」呈现并给出原因，不得仅灰掉而不解释。
- **FR-004**: 项目级与用户级条目 MUST 在视觉上可区分（层级标签）。
- **FR-005**: 用户 MUST 能一键信任当前项目；操作前 MUST 明确列出将生效的资源类别。
- **FR-006**: 信任写入 MUST 遵循宪法第 IV 条：写前备份 `trust.json`、写前 JSON 校验、失败原样呈现错误。
- **FR-007**: 用户 MUST 能撤销信任，且撤销需二次确认。
- **FR-008**: 信任状态变化后，若存在运行中的会话，MUST 提示需新会话（或自动以对应参数重启进程）。
- **FR-009**: 项目级 skills 的扫描 MUST 以当前项目根为基准（绝对路径），不得使用进程工作目录。
- **FR-010**: skills 列表 MUST 标注每项来源层级（用户级 / 项目级）与绝对路径。
- **FR-011**: `trust.json` 缺失时 MUST 按「未信任」处理且不报错；损坏时 MUST 报错并按未信任处理。
- **FR-012**: 面板每次打开 MUST 重新读取信任状态（不做跨会话长缓存）。

### Key Entities

- **信任条目**：项目路径（归一化后）、是否信任、记录来源（插件写入 / 外部写入）。
- **项目级资源**：类型（skills / MCP / settings / 扩展）、路径、生效与否、未生效原因。
- **信任操作**：动作（信任 / 撤销）、影响资源清单、是否需新会话。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 在未信任项目中，用户能通过界面**准确判断**项目级配置为何不生效——不再需要去终端或文档排查。
- **SC-002**: 从「发现项目级配置不生效」到「信任并让它生效」的操作步数 ≤ 3 步（打开面板 → 点信任 → 确认）。
- **SC-003**: skills 列表在双项目窗口下零串台（各自只显示本项目条目）。
- **SC-004**: `trust.json` 损坏的项目不会因插件操作而进一步损坏（fail-safe 一致性）。
- **SC-005**: 信任/撤销操作的失败路径 100% 在界面上可见原始错误。

## Assumptions

- 信任语义完全由 pi 定义，插件只读写其既有的 `trust.json`，**不引入第二套信任存储**。
- `trust.json` 的 schema 为「绝对路径 → 布尔」，实测样本：`{ "D:\\code\\github\\xxx": true }`；
  若未来 pi 扩展该结构，按「未知字段保留、只改对应键」原则处理。
- 不实现「信任但不加载某类资源」的细粒度控制——那是 pi 的职责范围。
- 项目级资源的具体渲染复用 001 引入的层级标签能力，两规格共享同一套 `scope` 概念。

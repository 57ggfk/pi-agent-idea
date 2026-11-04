# Feature Specification: IDE 集成修复与增强（右键图标 / 子菜单可用性 / 目录到 pi / 文件刷新）

**Feature Branch**: `release/0.5.2`

**Created**: 2026-11-04

**Status**: Draft

**Input**: 用户缺陷三条 + 一条需求：
「IDE（JetBrains 全系）右键菜单第一层（Pi Agent）加图标」；
「项目文件树右键子菜单灰色不能点，之前就有这问题；然后增加『添加目录到 pi』的功能」；
「新增文件通知 IDE 刷新」。

**难度定位**：中等偏上。改动集中在 Kotlin 侧（`plugin.xml` + actions），
但「灰色」这一条的根因必须先在真机确认，不能靠猜。

## 问题陈述

插件在 IDE 侧的入口有三个：工具窗、编辑器右键、项目树右键。前两个正常，第三个长期有问题：

| 现象 | 现状 |
|---|---|
| 右键菜单里的「Pi Agent」分组没有图标 | 纯文字分组，在一排带图标的菜单项里很显眼 |
| 项目树右键 → Pi Agent 子菜单整片灰 | 用户第一反应是「插件坏了」 |
| 想把整个目录交给 pi | 没有入口；只能自己 `@` 一个个文件 |
| pi 刚创建的文件，项目树里看不到 | 需要手动 `File → Reload from Disk` 或等文件监听器 |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 右键分组带图标 (Priority: P2)

用户在项目树 / 编辑器标签上右键，看到「Pi Agent」这一行前面有 π 字形的小图标，
与相邻的系统分组（Open In、Git…）视觉一致，深浅主题都清楚。

**Why this priority**: 纯装饰性，但成本极低（一个 svg + 一个属性），顺手做完。

**Independent Test**: 装插件后右键，目视分组前有图标；`plugin.xml` 断言 `<group>` 带 `icon` 属性。

**Acceptance Scenarios**:

1. **Given** 浅色主题，**When** 项目树右键，**Then** 「Pi Agent」左侧有 π 图标，与文字基线对齐。
2. **Given** 深色主题（Darcula），**Then** 图标为深色主题变体（`_dark.svg`），不出现深灰看不清。
3. **Given** 编辑器标签右键，**Then** 同一个图标出现（两个菜单共用同一分组图标）。
4. **Given** 13–16px 的菜单行高，**Then** 图标不被拉伸变形、不模糊。

---

### User Story 2 - 子菜单不再整片灰 (Priority: P1)

用户右键**文件**或**目录**时，Pi Agent 子菜单里至少有一项是可点的；
确实不能点的项（二进制、超大文件）要写清原因，而不是无声变灰。

**Why this priority**: 这是用户最直接的「插件坏了」感知，且已有一次修复失败的历史（0.5.1 前修过一次），
必须这次把根因钉死。

**Independent Test**: 真机上右键五种目标（普通文本文件 / 目录 / 二进制 / >256KB 文件 / 多选），
逐项记录可用状态与原因文案；自动化侧用纯函数覆盖判定逻辑。

**Acceptance Scenarios**:

1. **Given** 右键一个普通文本文件，**Then** `Send File to Pi` 与 `Explain File with Pi` 都可点。
2. **Given** 右键一个目录，**Then** 子菜单**不整片灰**：`Add Directory to Pi` 与 `Explain Folder with Pi` 可点，
   文件类动作变灰且描述写「Folders cannot be sent as a file — use Add Directory to Pi」。
3. **Given** 右键二进制文件，**Then** 只剩 `Explain File with Pi` 可点（它可以只送路径让 pi 自己读），
   描述写「Binary file: pi will read it from disk」。
4. **Given** 右键 >256KB 的文本文件，**Then** `Send File` 灰（含原因），`Explain File` 可用。
5. **Given** 多选 3 个文件，**Then** 子菜单项都可点（按首个文件执行），不因多选变灰。
6. **Given** 在一个空项目里右键项目根，**Then** 子菜单仍有可点项。

---

### User Story 3 - 添加目录到 pi (Priority: P1)

用户右键一个目录，选「Add Directory to Pi」，输入框里出现该目录的结构摘要
（相对路径 + 文件列表，按扩展名分组或截断），用户补充一句「看看这个模块有什么问题」再发送。

**Why this priority**: 它同时是 US2 的解法（目录有可用项）和一条真实的新能力。

**Independent Test**: 对 `web/src/components` 执行动作 → 断言 composer 收到含目录路径与 N 个文件名的文本、
输入框高度自适应、不超上限。

**Acceptance Scenarios**:

1. **Given** 一个有 12 个文件的目录，**When** 执行动作，**Then** composer 收到：目录相对路径 + 文件清单
   （每行一个相对路径），不含文件内容。
2. **Given** 一个 3000 个文件的目录，**Then** 清单被截断到上限（如 200 条）并注明「已省略 N 个」，
   不卡住 EDT，不产生 MB 级文本。
3. **Given** 目录含 `build/`、`node_modules/`、`.git/`、`dist/`，**Then** 这些默认被排除。
4. **Given** 目录在项目外（外部库 / 收藏夹），**Then** 使用绝对路径并照常工作。
5. **Given** 执行动作后，**Then** 工具窗自动激活、焦点在输入框末尾、输入框已按内容增高。

---

### User Story 4 - pi 改动的文件，IDE 立刻能看到 (Priority: P2)

pi 在会话里创建、修改、删除文件后，用户切回编辑器/项目树就能看到，不需要 `Reload from Disk`。

**Why this priority**: 影响信任（用户会以为 pi 没写成功）；实现上是「监听工具调用 + 防抖刷新」，
风险在于刷太勤导致卡顿。

**Independent Test**: 让 pi 创建一个新文件 → 断言 `VirtualFileManager` 能查到该文件（Kotlin 侧集成测试可用
临时项目 + 真实文件系统）；真机侧在项目树里直接看到。

**Acceptance Scenarios**:

1. **Given** pi 通过 `write` 工具创建 `tmp/probe.txt`，**Then** 工具调用结束后 1 秒内，
   项目树可见该文件（无需手动刷新）。
2. **Given** pi 通过 `bash` 删除了一个文件，**Then** 项目树中被删除的条目消失。
3. **Given** 一轮对话里 pi 连续写了 10 个文件，**Then** 刷新被合并（防抖），不出现 10 次连续刷新造成的卡顿。
4. **Given** 用户在编辑器里有未保存修改，**When** pi 同时改了同一个文件，**Then** 用户的未保存内容不被静默丢弃
   （刷新只更新 VFS，不覆盖内存文档）。
5. **Given** pi 只是读取文件（`read` / `grep`），**Then** 不触发刷新。

### Edge Cases

- **项目根右键**：根目录也应有可用项（`Add Directory to Pi` 对项目根同样可用）。
- **符号链接目录**：不跟随（避免无限递归与重复列举）。
- **超深目录**（> 20 层）：限制遍历深度并注明。
- **文件编码非 UTF-8**：发送文件内容时按 detection 失败处理，回退为「只送路径」。
- **刷新与索引**：`asyncRefresh` 之后索引更新是异步的，`files.list` 的 30s 缓存必须一并失效，
  否则 `@` 补全仍看不到新文件。
- **多项目窗口**：动作只作用于当前 project 的 VFS 刷新，不全局刷新。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `PiAgent.FilePopup` 与 `PiAgent.EditorPopup` 两个分组 MUST 带图标，且 MUST 提供深色主题变体。
- **FR-002**: 图标 MUST 为单色描线（颜色写在 path 上），MUST NOT 使用填充底色徽章（宪法「技术约束」）。
- **FR-003**: 项目树右键一个目录时，Pi Agent 子菜单 MUST 至少有一个可用项（`Add Directory to Pi`）。
- **FR-004**: 任何被禁用的动作 MUST 通过 `presentation.description` 给出禁用原因（可读英文，008 之后区分语言）。
- **FR-005**: `Explain File with Pi` 对目录 MUST 可用（语义改为「解释这个目录的结构」），对二进制文件 MUST 可用
  （只送路径，由 pi 自行读取）。
- **FR-006**: `Send File to Pi` MUST 保持对目录 / 二进制 / >256KB 禁用，并给出各自原因。
- **FR-007**: `Add Directory to Pi` MUST 生成「目录相对路径 + 文件清单（截断到上限）+ 省略说明」的文本，
  并 MUST 默认排除 `.git` / `build` / `out` / `dist` / `node_modules` / `.gradle` / `target`。
- **FR-008**: 目录遍历 MUST 限制文件数量（≤200 条清单、≤5000 个条目遍历）与深度（≤12 层），
  并 MUST 在后台线程执行（不得阻塞 EDT）。
- **FR-009**: 目录遍历 MUST 不跟随符号链接，且 MUST 对不可读条目跳过而非中断。
- **FR-010**: 执行任何「送到 composer」的动作后，工具窗 MUST 激活、焦点落在输入框末尾、输入框按内容增高。
- **FR-011**: pi 的写类工具调用（`write` / `edit` / `bash` / `powershell` / 删除类）结束后
  MUST 在 ≤1s 内刷新对应 VFS 路径；一轮结束（settle）时 MUST 再做一次整体刷新。
- **FR-012**: 刷新 MUST 防抖合并（窗口 400ms），MUST NOT 因 `read` / `grep` 等只读工具触发。
- **FR-013**: 刷新后 MUST 使 `files.list` 的缓存失效（`@` 补全立刻能看到新文件）。
- **FR-014**: 刷新 MUST NOT 覆盖编辑器中的未保存文档内容。
- **FR-015**: 上述动作 MUST 在每个 JetBrains IDE（233–263）上工作：只依赖平台通用 DataKeys 与标准 group id。

### Key Entities

- **动作可用性判定**：`actionAvailability(target) → { enabled: boolean, reason: string | null }`，
  按 `file | directory | binary | oversized | multi` 五类目标给出结果（纯函数，可单测）。
- **目录清单**：`{ rootPath, entries: string[], omitted: number, truncated: boolean }`。
- **刷新请求**：`{ paths: string[], wholeProject: boolean }`，由工具调用参数推导，防抖合并后执行。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 右键目录时子菜单可点项数 ≥1（现在为 0），SC-002 与它一起在真机矩阵里逐格勾选。
- **SC-002**: 五类目标的可用性矩阵与原因文案 100% 符合 FR-003…FR-006（Kotlin 单测 + 真机逐格对照）。
- **SC-003**: 「把整个目录交给 pi」从「逐个 `@` 文件」变为 1 次右键 + 0 次输入。
- **SC-004**: pi 写完文件到用户看到它 ≤1s，且连续写入 10 个文件时 IDE 无可感知卡顿。

## Assumptions

- **「子菜单灰色」的主因按目录处理**：0.5.1 已修过「项目树只给 `VIRTUAL_FILE_ARRAY`」，
  若用户仍见整片灰，最可能是**在目录上右键**——两个动作都拒绝目录，整组自然全灰。
  实施时先在真机复核文件场景；若文件场景也灰，则按 plan 的备选根因（DataContext 取值 / 分组更新）继续排查。
- **图标复用工具窗字形**：`icons/piAgent.svg` 已是 16×16 单色描线并带 `_dark`，菜单分组直接引用它，
  不新画一套（menu 图标会被平台缩放到 13×13，描线在 16 网格里留了 1px 余量，缩后仍清晰）。
- **刷新范围以「路径级刷新 + 一轮一次整体刷新」组合**：路径级保证快，整体刷新兜住 `bash` 里间接改动的文件。
- **不做 IDE 侧「目录内容注入」的 diff/变更集**：一次送清单，pi 自己按需读取文件内容。

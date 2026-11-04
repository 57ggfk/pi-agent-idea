# Feature Specification: 中英双语（跟随 IDE 语言，可手动覆盖）

**Feature Branch**: `release/0.5.2`

**Created**: 2026-11-04

**Status**: Draft

**Input**: 用户需求「多语言环境，支持中文和英文，默认跟随 IDE，参考 theme」。经澄清：范围覆盖
**Web UI + IDE 侧**（右键菜单文案、通知、设置页）。

**难度定位**：本版**工作量最大**的一项，且必须放在最后做——它会扫过前面四个 feature 新增的所有文案，
先做等于写两遍。

## 问题陈述

插件是纯英文界面：工具窗里每一句提示、每一个按钮、每一条错误，以及 IDE 右键菜单与通知，都是硬编码英文。
中文用户读得懂但不顺手，且与 IDE 自身语言（中文语言包）割裂——菜单里一半中文一半英文。

同时，现有代码里**没有**任何文案抽象层：字符串直接写在 JSX 与 Kotlin 里，改一处文案要翻五个文件。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 界面跟随 IDE 语言 (Priority: P1)

中文语言包的 IDE 里，工具窗打开就是中文；英文 IDE 里就是英文。用户不需要做任何配置。

**Why this priority**: 默认行为决定绝大多数用户的体验，也是「多语言」这个词的本意。

**Independent Test**: `env.locale` 为 `zh` 时渲染，断言 tabs 文案为 聊天/会话/管理；为 `en` 时为 Chat/Sessions/Manage。

**Acceptance Scenarios**:

1. **Given** IDE 语言为中文、偏好为「跟随 IDE」，**When** 打开工具窗，**Then** 主要界面为中文
   （tabs、输入框占位、发送/停止、空态文案、Sessions 与 Manage 的标题与按钮）。
2. **Given** IDE 语言为英文、偏好为「跟随 IDE」，**Then** 界面为英文，且**没有**中文残留（混排视为缺陷）。
3. **Given** IDE 语言为日语/德语等非中英语言，**Then** 回退英文（不出现空文案、不出现 key 名）。
4. **Given** 用户在 Options 里切到「English」而 IDE 是中文，**Then** UI 立即变英文（无需重启），
   刷新工具窗后仍是英文（持久化）。

---

### User Story 2 - 手动切换语言，三段式与主题一致 (Priority: P1)

Options 菜单里 Language 一行有「跟随 IDE / 中文 / English」三个分段，样式与行为跟 Theme 那一行完全一致。

**Why this priority**: 与 US1 同属可用性基础；三段式复用现有 Theme 组件，成本低、一致性天然。

**Independent Test**: Options 中把三段各点一次，断言 UI 文案随之变化、`config.setPrefs` 被调用、
重开工具窗后保持选择。

**Acceptance Scenarios**:

1. **Given** Options 打开，**Then** Language 行位于 Theme 行下方，三段宽度与样式与 Theme 行一致。
2. **Given** 选择「跟随 IDE」，**Then** 语言由 `env.locale` 决定，IDE 语言变化后下一次 `env` 事件即生效。
3. **Given** 选择「中文」/「English」，**Then** 与 IDE 语言无关地固定为该语言。
4. **Given** 切换语言，**Then** 不丢失会话内容、不重置滚动位置、不打断流式输出。

---

### User Story 3 - IDE 侧文案本地化 (Priority: P2)

右键菜单、气泡通知、设置页、状态栏提示，在中文 IDE 里显示中文，英文 IDE 里显示英文。

**Why this priority**: 用户明确要求覆盖 IDE 侧；但它跟随 IDE 语言（不做应用内覆盖），
实现上走标准 resource bundle，风险低、量不小。

**Independent Test**: 中文 IDE 中右键项目树，断言分组标题与动作文案为中文；触发一次完成通知，标题为中文。

**Acceptance Scenarios**:

1. **Given** 中文 IDE，**When** 项目树右键，**Then** 分组与动作文案均为中文（`Pi Agent` / `添加到 Pi` 等）。
2. **Given** 中文 IDE，**When** 后台运行完成，**Then** 通知标题与正文为中文。
3. **Given** 中文 IDE，**When** 打开发送导出对话框，**Then** 标题与描述为中文。
4. **Given** 英文 IDE，**Then** 上述全部为英文，且与 0.5.1 文案逐字一致（不因翻译改动而回退）。
5. **Given** 工具窗标题与插件名，**Then** 保持 `Pi Agent`（品牌名不翻译），
   `getToolWindow("Pi Agent")` 的查找仍可用。

### Edge Cases

- **语言切换时正在流式输出**：已渲染的消息不回译（已生成的文本属于历史），只有「界面文案」变化。
- **复数与量词**：`12 msgs`、`3 hits` 需按语言处理（英文 `1 msg / 12 msgs`，中文 `12 条消息`）。
- **长文案溢出**：德语/英语长文案在 360px 下不得把按钮撑出窗口；中文更短，但英文必须测。
- **日期格式**：会话列表时间按当前语言本地化（`Intl.DateTimeFormat`）。
- **错误信息中的原始输出**：pi 的 stderr、命令输出**不翻译**（保留原文），只翻译包裹它的说明文字。
- **`t()` 缺 key**：渲染为 `⟦key⟧` 并在控制台告警，不得渲染空字符串（否则界面像坏了）。
- **Kotlin 侧语言与应用内语言不一致**：允许并明确说明（IDE 侧跟随 IDE，Web 侧可覆盖），
  在 Options 的 Language 行加一句说明文案。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 新增语言偏好 `language: "system" | "zh" | "en"`，默认 `"system"`，持久化到既有偏好存储，带版本迁移。
- **FR-002**: Web UI MUST 通过统一入口取文案（`t(key, params)`），MUST NOT 在 JSX 中直接写用户可见英文。
- **FR-003**: 字典 MUST 为 `zh` 与 `en` 两套，键集合 MUST 完全一致（编译期或单测强制）。
- **FR-004**: `system` 时语言取自宿主 `env.locale`；非 `zh*` 一律回退 `en`。
- **FR-005**: Options MUST 提供三段式 Language 选择器，DOM 结构与 Theme 行一致（同一个 `.segmented` 组件）。
- **FR-006**: 切换语言 MUST 即时生效（无需重启、不丢会话、不打断流式）。
- **FR-007**: 已生成的对话内容 MUST NOT 被翻译或重新渲染成另一种语言。
- **FR-008**: 数量与日期 MUST 按当前语言格式化（`Intl.NumberFormat` / `Intl.DateTimeFormat`）。
- **FR-009**: 缺 key MUST 渲染 `⟦key⟧` 并告警，MUST NOT 渲染空白。
- **FR-010**: IDE 侧文案 MUST 走 resource bundle（`messages/PiAgentBundle*.properties`），
  `plugin.xml` 中的可见文案 MUST 使用 `%key`。
- **FR-011**: 中文 bundle 的键集合 MUST 与英文 base 一致（单测强制）；缺失时回退英文且不报错。
- **FR-012**: 品牌名 `Pi Agent`、工具窗 id、命令 id MUST 保持英文，不被翻译。
- **FR-013**: 原始错误输出（stderr / 命令结果）MUST 原样保留，不进入翻译层。
- **FR-014**: 所有新增文案 MUST 在 360px 宽度下不撑破按钮（用英文最长文案验收）。

### Key Entities

- **文案 key**：`<area>.<element>[.<state>]`，如 `composer.send`、`sessions.empty`、`confirm.fork.message`；
  area 限定为 `chat` / `sessions` / `manage` / `common` / `confirm` / `error`。
- **语言偏好**：`{ language: "system" | "zh" | "en" }`，与 `theme` 同层存储。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Web UI 中用户可见英文硬编码数量为 0（以「`t(` 之外的 JSX 文本节点」为准，逐文件盘点）。
- **SC-002**: 中英两套字典键数完全相等，`npm test` 有对应用例；Kotlin 两个 bundle 同理。
- **SC-003**: 中文 IDE 下从打开工具窗到发消息的全流程无英文残留（截图逐屏核对：Chat/Sessions/Manage/确认框）。
- **SC-004**: 切换语言到界面重绘 ≤100ms，不丢失当前会话消息（e2e 断言消息条数不变）。

## Assumptions

- **应用内语言只覆盖 Web UI**：IDE 侧文案跟随 IDE 语言包（平台机制），不做运行期覆盖；
  Options 里会写明这一点，避免用户以为「切了英文但菜单还是中文」是 bug。
- **不引入 i18n 框架**：字典 + `t()` 约 80 行即可，`react-i18next` 带来的是依赖与 bundle 体积，
  而本插件只有一种 DOM 宿主（JCEF），不需要 SSR/懒加载那套。
- **翻译以人工为准**：文案由开发者按现有语气改写，不接机器翻译 API；技术名词（MCP、token、fork、steer）
  在中文里保留英文。
- **不新增语言**：只做 zh/en，字典结构预留 `Locale` 参数但暂不注册第三语言。

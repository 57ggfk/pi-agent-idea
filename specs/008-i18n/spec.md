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

### User Story 2 - 手动切换语言，控件随语言数自适应 (Priority: P1)

Options 菜单里 Language 一行有「跟随 IDE / 中文 / English」三个分段，样式与行为跟 Theme 那一行完全一致。
**新增语言后，同一行自动从分段控件退化为下拉选择**，无需改动组件代码。

**Why this priority**: 与 US1 同属可用性基础；三段式复用现有 Theme 组件，成本低、一致性天然。

**Independent Test**: Options 中把三段各点一次，断言 UI 文案随之变化、`config.setPrefs` 被调用、
重开工具窗后保持选择；把注册语言数临时改为 4，断言该行渲染为 `<select>` 且四项都在。

**Acceptance Scenarios**:

1. **Given** Options 打开，**Then** Language 行位于 Theme 行下方，三段宽度与样式与 Theme 行一致。
2. **Given** 选择「跟随 IDE」，**Then** 语言由 `env.locale` 决定，IDE 语言变化后下一次 `env` 事件即生效。
3. **Given** 选择「中文」/「English」，**Then** 与 IDE 语言无关地固定为该语言。
4. **Given** 切换语言，**Then** 不丢失会话内容、不重置滚动位置、不打断流式输出。
5. **Given** 已注册语言超过 3 种（含「跟随 IDE」共 4 项以上），**Then** 该行渲染为原生下拉，
   选项按 `LANGUAGES` 声明顺序排列，当前值正确选中；分段控件的样式类不再出现在该行。
6. **Given** 偏好里存着一种已下线的语言代码（如 `ja` 被移除），**Then** 回退到「跟随 IDE」
   并把偏好纠正写回，界面不空白、不报错。

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
- **复数与量词**：MUST 走 CLDR 复数分类，而不是 `n === 1 ? a : b`。英文要 `1 msg / 12 msgs`，
  中文只有一个形态，俄语需要 `one/few/many/other` 四种。**新增语言时，该语言需要的分类集合由
  `Intl.PluralRules` 决定，字典必须补齐，缺一个即测试失败**（见 FR-015）。
- **长文案溢出**：德语/俄语长文案在 360px 下不得把按钮撑出窗口；中文更短，但英文、德文必须测。
  俄语平均比英语长 15%、德语长 30%，这是布局验收的上界参照。
- **日期与数字格式**：会话列表时间、消息计数 MUST 走 `Intl.DateTimeFormat` / `Intl.NumberFormat`，
  不手工拼接 `YYYY-MM-DD`。注意阿拉伯语等语言的数字字形差异（本版不涉及，但不得写死 ASCII 数字格式）。
- **书写方向（RTL）**：本版不支持阿拉伯语/希伯来语。`dir` 属性在初始化时按语言设置（本版恒为 `ltr`），
  **但现有 CSS 大量使用 `margin-left` 等物理属性，直接开 RTL 会错位**——这一点作为已知债记录在
  plan.md 的风险表里，是将来加 RTL 语言的前置条件，不在本版范围。
- **错误信息中的原始输出**：pi 的 stderr、命令输出**不翻译**（保留原文），只翻译包裹它的说明文字。
- **`t()` 缺 key**：渲染为 `⟦key⟧` 并在控制台告警，不得渲染空字符串（否则界面像坏了）。
- **Kotlin 侧语言与应用内语言不一致**：允许并明确说明（IDE 侧跟随 IDE，Web 侧可覆盖），
  在 Options 的 Language 行加一句说明文案。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 新增语言偏好 `language: "system" | <语言代码>`，默认 `"system"`，持久化到既有偏好存储。
  存储的值 MUST 是已注册语言的代码，读到未知代码时回退 `"system"` 并纠正写回。
  旧用户没有该键，缺省即 `"system"`，与「跟随 IDE」语义一致，不需要版本迁移。
- **FR-002**: Web UI MUST 统一通过 i18n 库的翻译入口取文案（`t(key, params)`），
  MUST NOT 在 JSX 中直接写用户可见英文。**i18n 必须是可替换的一层**：组件只依赖
  `useT()` 这一个自有 hook，不直接 import 第三方库的 hook。
- **FR-003**: 字典 MUST 按语言各一套，**键集合的一致性 MUST 由编译期类型检查保证**
  （键类型从基准语言字典推导，缺键即 `tsc` 报错），单测只兜「空值 / 值与键相同 / 未翻译」。
- **FR-004**: `system` 时语言取自宿主 `env.locale`，按 BCP-47 前缀匹配已注册语言；
  无匹配（如 `ja`）一律回退基准语言 `en`。
- **FR-005**: Options MUST 提供语言选择器：已注册语言（含「跟随 IDE」）≤3 项时渲染分组按钮，
  >3 项时自动渲染下拉；两种形态共用同一份 `LANGUAGES` 声明，组件不写死选项。
- **FR-006**: 切换语言 MUST 即时生效（无需重启、不丢会话、不打断流式）。
- **FR-007**: 已生成的对话内容 MUST NOT 被翻译或重新渲染成另一种语言。
- **FR-008**: 数量与日期 MUST 按当前语言格式化（`Intl.NumberFormat` / `Intl.DateTimeFormat` /
  `Intl.RelativeTimeFormat`），MUST NOT 手工拼接日期字符串。
- **FR-009**: 缺 key MUST 渲染 `⟦key⟧` 并告警（同一 key 只告警一次），MUST NOT 渲染空白。
- **FR-010**: IDE 侧文案 MUST 走 resource bundle（`messages/PiAgentBundle*.properties`），
  `plugin.xml` 中的可见文案 MUST 使用 `%key`。
- **FR-011**: 中文 bundle 的键集合 MUST 与英文 base 一致（单测强制）；缺失时回退英文且不报错。
- **FR-012**: 品牌名 `Pi Agent`、工具窗 id、命令 id MUST 保持英文，不被翻译。
- **FR-013**: 原始错误输出（stderr / 命令结果）MUST 原样保留，不进入翻译层。
- **FR-014**: 所有新增文案 MUST 在 360px 宽度下不撑破按钮（用英文与德语级长文案验收）。
- **FR-015**: 含数量占位的文案 MUST 为每个**该语言需要的 CLDR 复数分类**各提供一个变体；
  该分类集合 MUST 由 `Intl.PluralRules(locale).resolvedOptions().pluralCategories` 在单测中枚举，
  字典缺少任一分类即测试失败。MUST NOT 用 `n === 1` 之类的条件表达式在组件里分派。
- **FR-016**: 新增一种语言 MUST 只需「加一个字典文件 + 在 `LANGUAGES` 注册一行 + 补一份 properties」，
  MUST NOT 需要修改任何组件、store 逻辑或选择器结构。该性质由单测锁定（注册表与字典文件一致性）。
- **FR-017**: 非基准语言的字典 MUST 按语言代码拆分为独立 chunk 按需加载；
  基准语言随主包同步加载，保证首屏无闪烁、离线可用（webview 由 loopback HTTP 提供，动态 import 可用）。
- **FR-018**: Web 侧字典与 IDE 侧 properties **各自独立维护**，MUST NOT 试图共享键表或互相生成
  （两侧语言来源不同：IDE 侧由语言包决定、不可应用内覆盖）。

### Key Entities

- **文案 key**：`<area>.<element>[.<state>]`，如 `composer.send`、`sessions.empty`、`confirm.fork.message`；
  area 限定为 `chat` / `sessions` / `manage` / `common` / `confirm` / `error`。
  key 表达**语义**而非英文原文，改文案不让其他语言的翻译失效。
  复数变体在 key 后加 `_<CLDR 分类>`（`_one` / `_other` / `_few` …），由 FR-015 校验完整性。
- **语言注册项**：`{ code, label, bcp47 }`，集中在 `web/src/i18n/languages.ts` 一处声明；
  基准语言标记为 `fallback: true`，其字典随主包加载。
- **语言偏好**：`{ language: "system" | <已注册 code> }`，与 `theme` 同层存储。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Web UI 中用户可见英文硬编码数量为 0（以「`t(` 之外的 JSX 文本节点」为准，逐文件盘点）。
- **SC-002**: 任一语言字典缺键都会让 `npm run typecheck` 失败（类型推导，不依赖人工检查）；
  Kotlin 两个 bundle 的键集合由 `PiAgentBundleTest` 断言相等。
- **SC-003**: 中文 IDE 下从打开工具窗到发消息的全流程无英文残留（截图逐屏核对：Chat/Sessions/Manage/确认框）。
- **SC-004**: 切换语言到界面重绘 ≤100ms，不丢失当前会话消息（e2e 断言消息条数不变）。
- **SC-005**: **加语言的成本可度量**：在一个临时分支上注册一个假语言（`xx`，只需加字典与注册行），
  要求 `git diff --stat` 中**组件目录 `web/src/components/` 改动文件数 = 0**，且该语言下界面可正常渲染。
- **SC-006**: 复数完整性可自动验证：以 `Intl.PluralRules` 枚举 `en` / `zh` 的复数分类，
  断言全部数量类文案的分类覆盖率为 100%（本版复数键仅 2–5 处，全量枚举成本可忽略）。

## Assumptions

- **应用内语言只覆盖 Web UI**：IDE 侧文案跟随 IDE 语言包（平台机制），不做运行期覆盖；
  Options 里会写明这一点，避免用户以为「切了英文但菜单还是中文」是 bug。
- **引入成熟 i18n 库，而不是手写 `t()`**：用户明确要求「后续开放更多语言」，
  复数分类（俄语 4 种、阿拉伯语 6 种）、按语言拆包、翻译工作流都不是 80 行能覆盖的。
  选型为 `i18next` + `react-i18next`（理由与备选对比见 [plan.md](./plan.md) 的 D0）。
  关键约束：**组件只依赖自有的 `useT()`**，第三方库只在 `web/src/i18n/index.ts` 里出现一次，
  将来换库只改这一个文件与字典加载方式。
- **本版只交付 `zh` / `en` 两种语言**，但架构按「加语言不动组件」设计（FR-016）：
  加第三种语言 = 加字典文件 + 注册一行 + 补 properties，不碰 UI 代码。
  第三种语言**不在本版验收范围**，只验证该性质可达成（用一个假的第三语言在单测里跑通）。
- **翻译以人工为准**：文案由开发者按现有语气改写，不接机器翻译 API；技术名词（MCP、token、fork、steer）
  在中文里保留英文。
- **RTL 不在本版**：加阿拉伯语/希伯来语前必须先改造 CSS 物理属性为逻辑属性，作为前置条件记录，
  不提前付这笔改造成本。

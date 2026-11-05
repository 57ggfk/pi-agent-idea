---
description: "Task list for 008-i18n"
---

# Tasks: 多语言（当前交付 zh/en，架构支持继续加语言）

**Input**: Design documents from `/specs/008-i18n/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)

**Tests**: vitest（键覆盖、复数分类、注册表一致性）+ JUnit5（bundle 一致性）+ playwright e2e（切换、无残留）
+ 真机双语。

**验证命令**：`cd web && npm run typecheck && npm test && npx playwright test e2e/i18n.spec.ts`；`./gradlew test`。

## Format: `[ID] [P?] [Story] Description — 验证：...`

- **US1** = 跟随 IDE / **US2** = 手动切换 / **US3** = IDE 侧本地化
- **[P]** = 可并行（不共享文件）
- 涉及框架的 task 注明对应 plan.md 的决策编号（D0–D8）

---

## Phase 1: 盘点与地基

- [x] **T001** [地基] 跑 `plan.md` 技术上下文里的两条盘点命令，把待翻译条目数按 area 写进 `plan.md`
  — 验证：数字与 `grep` 输出一致，作为后续「归零」的基线

- [x] **T002** [地基] **装依赖并验证懒加载成立（阻塞后续）**：`npm i i18next react-i18next`（仅此两个，见 D0）；
  建一个最小 `import.meta.glob('./locales/*.ts')` 的加载器与两个占位字典，跑 `npm run build`
  — 验证：`web/dist/assets/` 下**出现独立的 `zh-*.js` chunk**（基准语言 `en` 在主包内）；
  若未切出 chunk，**停下并报告**——这意味着懒加载方案需改为全量同步打包，属架构级分叉。
  *规划期已用最小用例验证可行（切出 `zh-*.js`，主包 gz +16.3KB），此处只需在真实目录结构下复验*

- [x] **T003** [地基] 按 D2 建 `web/src/i18n/`：`languages.ts`（`LANGUAGES` 注册表 + `FALLBACK` + `isRegistered`）、
  `locales/en.ts`（`as const`，先只含 `common.*` 与 `chat.tabs.*`）、`locales/zh.ts`
  （`satisfies Record<keyof typeof en, string>`）、`index.ts`（初始化：`keySeparator:false`、
  `escapeValue:false`、`parseMissingKeyHandler` 返回 `⟦key⟧`、`react.useSuspense:false`、`ensureLanguage`）、
  `useT.ts`、`resources.d.ts`（`CustomTypeOptions`）
  — 验证：**先写** `i18n.test.ts`（键覆盖、占位符、缺 key 返回 `⟦key⟧`、`LANGUAGES` 与 `locales/` 文件一一对应），
  红 → 绿；故意写一个不存在的 key 调 `t()`，`npm run typecheck` 必须报错

- [x] **T004** [P][地基] `PiUserPrefs` 增加 `languagePreference()` / `setLanguagePreference()`；
  `BridgeService.envInfo()` 加 `locale`（取 `Locale.getDefault().language`）；`getPrefs/setPrefs` 支持 `language`
  — 验证：`./gradlew test` 绿；`env` 响应里 `locale` 非空（真机 `zh`/`en` 各一次）

- [x] **T005** [P][地基] `web/src/bridge/types.ts` 加 `EnvInfo.locale` / prefs 的 `language`；`mock.ts` 提供
  `locale` 与语言持久化 — 验证：`npm test` 绿；mock 下 `config.setPrefs({language:"en"})` 后
  `config.getPrefs` 返回 `en`

**Checkpoint**: 语言链路打通（偏好 → env → store → 字典），且懒加载在构建产物中被证实。

---

## Phase 2: US1 + US2（链路与入口）

- [x] **T006** [US1] `index.ts` 的 `resolveLanguage(pref, envLocale)` + `store.init()`：已注册 code 直接用；
  `system` 或未知值 → `env.locale` 按 BCP-47 前缀匹配 → 无匹配用 `en`；未知代码回退 `system` 并写回偏好（D1）；
  store 暴露 `language` 与 `languagePref`；初始化时 **先 `await ensureLanguage()` 再渲染**
  — 验证：vitest 覆盖四种输入（`zh` 已注册、`system`+`zh-CN`、`system`+`ja`、`ja` 未注册）；
  切语言过程中界面不空白（e2e 断言文本非空）

- [x] **T007** [US2] `OptionsPopover` 的 Language 行按 D4 自适应：`1 + LANGUAGES.length <= 3` 用 `.segmented`
  （与 Theme 行同结构），`> 3` 用原生 `<select>`；选项文字用语言自身写法（`English` / `中文`），不经 `t()`；
  下方加说明「IDE 菜单与通知跟随 IDE 语言包」
  — 验证：e2e 断言当前 3 项时该行是 `.segmented` 且与 Theme 行子按钮数一致；点击后 `config.setPrefs` 被调用

- [x] **T008** [US1] 切换即时生效且不丢状态 — 验证：e2e 先发一条消息，再切语言，断言消息条数不变、
  `.message-list` 的 `scrollTop` 变化 ≤ 2px、界面文案已切换、`document.body` 无 `⟦` 字符

- [x] **T009** [US1] tabs / 空态 / composer 首批文案走 `useT()` — 验证：e2e 断言 `zh` 下 tabs 为
  聊天/会话/管理、占位符为中文、空态副标题为中文；`en` 下为英文

---

## Phase 3: 文案搬迁（按 area，每批跑一次 typecheck + e2e）

- [x] **T010** [P][US1] `chat.*`：`Composer` / `SendButton` / `MessageList` / `MessageActions` / `ToolCard` /
  `QueueBar` / `ApprovalCard` / `StatusBar` / `SetupCard` / `ModelPicker` / `ThinkingPicker` / `Markdown`
  — 验证：`npm run typecheck` 通过；`npx playwright test e2e/chat.spec.ts e2e/features.spec.ts e2e/queue.spec.ts e2e/approval.spec.ts` 绿

- [x] **T011** [P][US1] `sessions.*`：`SessionsView`（含 6 处动作 tooltip、空态、`N msgs`）
  — 验证：`npx playwright test e2e/sessions.spec.ts` 绿；中文态断言 `条消息`

- [x] **T012** [P][US1] `manage.*`：`ManageView` + 6 个面板（含按钮、空态、错误、表格表头）
  — 验证：`npx playwright test e2e/manage.spec.ts e2e/setup.spec.ts e2e/diagnostics.spec.ts` 绿；
  英文态断言 `.manage-*` 区域无中文（正则 `[\u4e00-\u9fa5]` 计数为 0）

- [x] **T013** [US1] `confirm.*` / `error.*` / `common.*` / `language.*`：确认框四个调用点、
  `store.ts` 的 `appendError` 文案、语言选择器的无障碍标签
  — 验证：e2e 断言中文态确认框标题为中文、错误系统条目为中文；`npx playwright test e2e/confirm.spec.ts` 绿

- [x] **T014** [US1] **复数与格式化按 D3 收口**：`i18n/format.ts`（`formatNumber`/`formatDate`/`formatRelative`）；
  数量文案改为 `t(key, { count })` + `_<CLDR 分类>` 变体；**禁止组件里 `count === 1 ?` 分派**
  — 验证：`i18n.test.ts` 用 `Intl.PluralRules(bcp47).resolvedOptions().pluralCategories` 枚举每种语言的分类，
  断言每个复数基 key 的分类覆盖率为 100%（`zh` 只需 `_other`，`en` 需 `_one`+`_other`）；
  e2e 断言 `zh` 下 `1 条消息`/`2 条消息`，`en` 下 `1 message`/`2 messages`

---

## Phase 4: US3 IDE 侧

- [x] **T015** [P][US3] 新增 `messages/PiAgentBundle.properties` + `_zh_CN.properties`，
  覆盖 `plugin.xml` 全部可见文案 key（2 个 group + 6 个 action 的 text/description、设置页名）
  — 验证：**先写** `PiAgentBundleTest`（两 bundle key 集合相等、无空值、中文与英文至少 10 个键不同），红 → 绿

- [x] **T016** [US3] `plugin.xml`：加 `<resource-bundle>`，`text` / `description` / `displayName` 改 `%key`
  — 验证：`./gradlew buildPlugin` 成功；真机中文 IDE 右键菜单为中文，英文 IDE 为英文，
  且不出现 `%key` 字面量

- [x] **T017** [P][US3] Kotlin 文案：`notifyIfSettledInBackground`（通知标题/正文/按钮）、
  `sessionsExportHtml`（对话框标题/描述）、`PiStatusBarWidget`（tooltip）、`PiAgentSettingsConfigurable`（表单标签）、
  `PiCliRunner`/`PiEnvironment` 的包裹文案 — 验证：`./gradlew test` 绿；真机触发一次完成通知与一次导出，
  文案随 IDE 语言变化；**原始 stderr 不翻译**

- [x] **T018** [US3] 品牌名与 id 不动 — 验证：`grep -n "Pi Agent" plugin.xml` 里 `toolWindow id` 与 action id 未改；
  `getToolWindow("Pi Agent")` 相关代码未动，工具窗可正常打开

---

## Phase 5: 复核与收尾

- [x] **T019** [复核] **加语言的可扩展性验证（SC-005）**：临时加 `locales/xx.ts` + 在 `LANGUAGES` 注册一行
  — 验证：`git diff --stat web/src/components/` **改动文件数 = 0**；Language 行自动变 `<select>`；
  界面可渲染（无 `⟦`）。验证完**删除**临时语言并再跑一次 typecheck

- [x] **T020** [复核] 重跑盘点命令，残留数写回 `plan.md`；逐条确认残留属于 D6 白名单
  — 验证：残留列表与白名单一一对应，没有「漏掉的真文案」

- [x] **T021** [复核] 360px 英文态重跑几何断言 — 验证：
  `npx playwright test e2e/layout-regressions.spec.ts` 绿；无按钮溢出、无横向滚动；
  额外把最长的英文文案手工替换成「德语级长词」跑一次，确认不撑破

- [x] **T022** [集成] 全量回归 — 验证：`npm run typecheck && npm test && npx playwright test` 全绿；
  `./gradlew test` 全绿

- [x] **T023** [集成] 真机双语截图：Chat / Sessions / Manage / 确认框 / 右键菜单 / 通知
  — 验证：12 张截图（2 语言 × 6 屏）存入 `specs/008-i18n/verify/`，run report 里逐屏记录无混排

- [x] **T024** [收尾] `MANUAL_TEST.md` 新增「多语言（v0.5.2）」段 5 条 — 验证：可勾选、含中英各一轮；
  第 5 条测「加语言不动组件」的手工复核步骤（供将来加第三种语言时复用）

- [x] **T025** [收尾] 在 `specs/008-i18n/plan.md` 的 D0 末尾补一节「加语言的操作清单」
  （加 `locales/<code>.ts` → 注册 `LANGUAGES` 一行 → 补复数分类 → 补 `_zh_CN` 式 properties → 跑测试），
  作为将来加语言时的唯一入口文档 — 验证：清单可照着做完加一种语言，无隐含步骤

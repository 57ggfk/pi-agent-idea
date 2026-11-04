---
description: "Task list for 008-i18n"
---

# Tasks: 中英双语

**Input**: Design documents from `/specs/008-i18n/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)

**Tests**: vitest（字典一致性、`t()` 行为）+ JUnit5（bundle 一致性）+ playwright e2e（切换、无残留）+ 真机双语。

**验证命令**：`cd web && npm run typecheck && npm test && npx playwright test e2e/i18n.spec.ts`；`./gradlew test`。

## Format: `[ID] [P?] [Story] Description — 验证：...`

- **US1** = 跟随 IDE / **US2** = 手动切换 / **US3** = IDE 侧本地化
- **[P]** = 可并行（不共享文件）

---

## Phase 1: 盘点与地基

- [ ] **T001** [地基] 跑 `plan.md` 里的两条盘点命令，把待翻译条目数按 area 写进 `plan.md` 表格上方
  — 验证：数字与 `grep` 输出一致，作为后续「归零」的基线
- [ ] **T002** [P][地基] 新增 `web/src/i18n/en.ts` / `zh.ts`（先只含 `common.*` 与 `chat.tabs.*`）与
  `index.ts`：`t(key, params)`、`useT()`、`setLanguage()`、缺 key 返回 `⟦key⟧`
  — 验证：**先写** `i18n/index.test.ts`（键集合一致、占位符替换、缺 key 行为、复数 `_one`），红 → 绿
- [ ] **T003** [P][地基] `PiUserPrefs` 增加 `languagePreference()` / `setLanguagePreference()`；
  `BridgeService.envInfo()` 加 `locale`；`getPrefs/setPrefs` 支持 `language`
  — 验证：`./gradlew test` 绿；`env` 响应里 `locale` 非空（真机 `zh`/`en` 各一次）
- [ ] **T004** [地基] `web/src/bridge/types.ts` 加 `EnvInfo.locale` / prefs 的 `language`；`mock.ts` 提供
  `locale` 与语言持久化 — 验证：`npm test` 绿；mock 下 `config.setPrefs({language:"en"})` 后
  `config.getPrefs` 返回 `en`

**Checkpoint**: 语言链路打通（偏好 → env → store → 字典）。

---

## Phase 2: US1 + US2（链路与入口）

- [ ] **T005** [US1] `store.init()` 解析生效语言：`prefs.language` → `env.locale`（`zh*` → zh，其余 en）；
  store 暴露 `language` 与 `languagePref` — 验证：vitest 覆盖三种输入（prefs=zh、locale=zh-CN、locale=ja）
- [ ] **T006** [US2] `OptionsPopover` 加 Language 三段式（跟随 IDE / 中文 / English），结构与 Theme 行一致，
  下方加说明「IDE 菜单与通知跟随 IDE 语言包」— 验证：e2e 断言两个 `.segmented` 结构一致（子按钮数、类名）、
  点击后 `config.setPrefs` 被调用（mock 记录）
- [ ] **T007** [US1] 切换即时生效且不丢状态 — 验证：e2e 先发一条消息，再切语言，断言消息条数不变、
  `.message-list` 的 `scrollTop` 变化 ≤ 2px、界面文案已切换
- [ ] **T008** [US1] tabs / 空态 / composer 首批文案走 `t()` — 验证：e2e 断言 `zh` 下 tabs 为
  聊天/会话/管理、占位符为中文、空态副标题为中文；`en` 下为英文

---

## Phase 3: 文案搬迁（按 area，每批跑一次 typecheck + e2e）

- [ ] **T009** [P][US1] `chat.*`：`Composer` / `SendButton` / `MessageList` / `MessageActions` / `ToolCard` /
  `QueueBar` / `ApprovalCard` / `StatusBar` / `SetupCard` / `ModelPicker` / `ThinkingPicker` / `Markdown`
  — 验证：`npm run typecheck` 通过；`npx playwright test e2e/chat.spec.ts e2e/features.spec.ts e2e/queue.spec.ts e2e/approval.spec.ts` 绿
- [ ] **T010** [P][US1] `sessions.*`：`SessionsView`（含 6 处动作 tooltip、空态、`N msgs` 复数）
  — 验证：`npx playwright test e2e/sessions.spec.ts` 绿；中文态断言 `条消息`
- [ ] **T011** [P][US1] `manage.*`：`ManageView` + 6 个面板（含按钮、空态、错误、表格表头）
  — 验证：`npx playwright test e2e/manage.spec.ts e2e/setup.spec.ts e2e/diagnostics.spec.ts` 绿；
  英文态断言 `.manage-*` 区域无中文（正则 `[\u4e00-\u9fa5]` 计数为 0）
- [ ] **T012** [US1] `confirm.*` / `error.*` / `common.*`：确认框四个调用点、`store.ts` 的 `appendError` 文案
  — 验证：e2e 断言中文态确认框标题为中文、错误系统条目为中文；`npx playwright test e2e/confirm.spec.ts` 绿
- [ ] **T013** [US1] 数量与日期本地化（`12 msgs` / `3 hits` / 会话时间）— 验证：e2e 断言 `zh` 下
  时间格式含中文月份或 `月/日`，`en` 下为英文缩写；单数场景 `1 条消息`

---

## Phase 4: US3 IDE 侧

- [ ] **T014** [P][US3] 新增 `messages/PiAgentBundle.properties` + `_zh_CN.properties`，
  覆盖 `plugin.xml` 全部可见文案 key（2 个 group + 6 个 action 的 text/description、设置页名）
  — 验证：**先写** `PiAgentBundleTest`（两 bundle key 集合相等、无空值、中文与英文至少 10 个键不同），红 → 绿
- [ ] **T015** [US3] `plugin.xml`：加 `<resource-bundle>`，`text` / `description` / `displayName` 改 `%key`
  — 验证：`./gradlew buildPlugin` 成功；真机中文 IDE 右键菜单为中文，英文 IDE 为英文，
  且不出现 `%key` 字面量
- [ ] **T016** [P][US3] Kotlin 文案：`notifyIfSettledInBackground`（通知标题/正文/按钮）、
  `sessionsExportHtml`（对话框标题/描述）、`PiStatusBarWidget`（tooltip）、`PiAgentSettingsConfigurable`（表单标签）、
  `PiCliRunner`/`PiEnvironment` 的包裹文案 — 验证：`./gradlew test` 绿；真机触发一次完成通知与一次导出，
  文案随 IDE 语言变化；**原始 stderr 不翻译**
- [ ] **T017** [US3] 品牌名与 id 不动 — 验证：`grep -n "Pi Agent" plugin.xml` 里 `toolWindow id` 与 action id 未改；
  `getToolWindow("Pi Agent")` 相关代码未动，工具窗可正常打开

---

## Phase 5: 复核与收尾

- [ ] **T018** [复核] 重跑盘点命令，残留数写回 `plan.md`；逐条确认残留属于 D4 白名单
  — 验证：残留列表与白名单一一对应，没有「漏掉的真文案」
- [ ] **T019** [复核] 360px 英文态重跑几何断言（英文最长文案）— 验证：
  `npx playwright test e2e/layout-regressions.spec.ts` 绿；无按钮溢出、无横向滚动
- [ ] **T020** [集成] 全量回归 — 验证：`npm run typecheck && npm test && npx playwright test` 全绿；
  `./gradlew test` 全绿
- [ ] **T021** [集成] 真机双语截图：Chat / Sessions / Manage / 确认框 / 右键菜单 / 通知
  — 验证：12 张截图（2 语言 × 6 屏）存入 `specs/008-i18n/verify/`，run report 里逐屏记录无混排
- [ ] **T022** [收尾] `MANUAL_TEST.md` 新增「多语言（v0.5.2）」段 4 条 — 验证：可勾选、含中英各一轮

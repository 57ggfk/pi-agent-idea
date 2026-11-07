---
description: "Task list for 011-0.5.4-defects"
---

# Tasks: 0.5.4 缺陷批次（模型选择器 / skill 引用 / 更新回显）

**Input**: Design documents from `/specs/011-0.5.4-defects/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)

**Tests**: vitest（分组/折叠纯函数）+ playwright e2e（几何/行为断言，mock bridge）+ JUnit（CLI 字节解码）+ JCEF 真机目视。

**验证命令**：类型 `cd web && npm run typecheck`；单测 `cd web && npm test`；
e2e `cd web && npx playwright test <file>`；Kotlin `./gradlew test`；
真机 `powershell -ExecutionPolicy Bypass -File scripts\e2e-ide.ps1`（macOS/Linux 用 `scripts/e2e-ide.sh`）。

## Format: `[ID] [P?] [Story] Description — 验证：...`

- **US1** = 弹出定位 / **US2** = 供应商分组 / **US3** = 点外部关闭 / **US4** = skill 引用 / **US5** = 更新回显
- **[P]** = 可与其他任务并行（无共享文件）
- **[前置]** = 阻塞性取证任务，**仅 T001 阻塞 Phase 2**（沿用 009 T001 先例）
- **[取证]** = 补证据 / 记规模，不阻塞实现（D5 根因已由用户补充与 `b2d32b2` 确证）
- 基线（0.5.3 执行报告）：`typecheck 0 错误` / `vitest 165` / `playwright 176` / `gradlew test ✅`

---

## Phase 0: 真机取证（仅 T001 阻塞）

- [ ] **T001** [前置][US4] 抓一次真实 `pi --mode rpc` 里引用 `/skill:<name>` 后的消息事件原始报文（会话 jsonl / `message_end` / `get_messages` 均可），记录：展开内容落在哪个字段、是否带 skill 元数据、用户原问题在何处、回放时形态是否一致；结论写回 `plan.md` D4 — 验证：`plan.md` D4 的三条分支（a/b/c）中明确选定一条并附报文片段；未拿到则**停下报告**，不得写 FR-013 实现
- [ ] **T002** [取证][US5] **Windows 真机**上抓 `pi update --self` 的结果条截图、stdout 字节与 `chcp` 当前控制台代码页，记录出现位置（`env-update-result` 还是 Packages 结果条）；根因已确证为「DOS/OEM 本地代码页输出 vs JVM 默认 UTF-8」，不再靠样例猜方案 — 验证：`plan.md`「现状与目标」补一行实测结论（代码页号 + 字节片段）；截图作为 SC-004 验收证据，**不阻塞 Phase 3 开工**
- [ ] **T003** [取证][US1][US2] 记录真机 `get_available_models` 的条目数、provider 数、provider 大小写是否混用，写回 `plan.md` 技术上下文 — 验证：表格里有具体数字与采样时间；作为「不引虚拟列表」与 FR-007 是否归一大小写的决策依据

**Checkpoint**: T001 未拿到则**不进 Phase 2**；Q1 已关闭（Windows 代码页 + `b2d32b2`），Q2–Q4 关闭或标注「按默认实现、待真机确证」即可开工 Phase 1/3。

---

## Phase 1: 模型选择器（US1 / US2 / US3，纯前端，可与 Phase 0 并行）

- [ ] **T004** [P][US2] 新增 `web/src/lib/modelGroups.ts`：`buildModelGroups(models, current, keywords)`（当前组置顶、其余按 pi 原序、空 provider 归兜底组、过滤后重建组）与 `flattenGroups(groups, cap)`（平铺索引 + 剩余数）— 验证：**先写** `modelGroups.test.ts`（空列表/单组/3 组置顶/跨组过滤/空 provider/>200 截断/同名 id 不同 provider/大小写混用），红 → 绿
- [ ] **T005** [US2] `web/src/bridge/mock.ts` 补 fixture：3 个 provider 共 12 条、200 条长列表（当前模型置于第 180 位）、1 条空 provider — 验证：`get_available_models` 返回上述数据，既有 `chat.spec.ts` 的模型断言仍绿（fixture 由 `?models=` 之类的开关控制，不污染默认场景）
- [ ] **T006** [US2] `ModelPicker.tsx` 改用 `buildModelGroups` + `flattenGroups` 渲染组标题（provider + 计数）与组内选项；`highlight`/`pick()` 继续用一维索引，`data-testid="model-option"` 语义不变 — 验证：`web/e2e/model-picker.spec.ts` 断言组数 = 3、当前组在第一位、组内计数正确、`model-option` 总数 = 12
- [ ] **T007** [US2] 过滤与截断接回新结构：过滤词沿用空格 AND 语义、只留有命中的组、`MAX_RENDERED` 按总条目数截断并显示剩余数 — 验证：e2e 断言过滤后组数/计数、`model-empty` 仍出现、201 条时提示文字含「1」；`chat.spec.ts:81-111` 全绿
- [ ] **T008** [US1] 新增 `ensureVisible(list, el)`：读一次 `offsetTop/offsetHeight` 与 `scrollTop/clientHeight`，仅不可见时赋 `list.scrollTop`；打开时在单次 rAF 内按 `provider/id` 查 `[data-model-key]`，设 `highlight` 为当前项并定位 — 验证：e2e 用 200 条 fixture 断言当前项完整落在 `.model-list` 可见矩形内且 `data-active="true"`；消息列表与 `.app` 的 `scrollTop` 不变
- [ ] **T009** [US1] 收敛滚动 effect：`highlight` 变化时先判可见再滚，去掉无条件 `scrollIntoView` 与对 `matches.length` 的触发；分组/索引计算 `useMemo` 化 — 验证：e2e 断言「当前项已可见」场景打开前后 `scrollTop` 差值 = 0；↑↓ 连续导航 30 次无异常滚动、无控制台错误
- [ ] **T010** [US1] 兜底：无当前模型 / 当前模型不在 `models`（自定义、加载失败）/ models 异步晚到 — 验证：单测与 e2e 断言不滚动、不报错、`highlight = 0`；`sources.models` 由 loading→ready 后打开仍定位到新到的当前项
- [ ] **T011** [US3] 复用 `OptionsPopover.tsx:62-78` 模式：`rootRef` 挂 `.model-picker`（**必须包住 chip**），仅 `open` 时挂 document `mousedown`，落在外部即关，关闭即移除 — 验证：e2e 外部点击矩阵 4 个目标（消息列表/输入框/弹窗内搜索框/chip 自身）逐一断言开关结果；断言 chip 点击是「关一次」而非「点不动」
- [ ] **T012** [US3] 共存回归：Esc 仍只关模型弹窗且不清空输入框文字；ConfirmDialog / OptionsPopover / slash / `@` 菜单与模型弹窗互不干扰 — 验证：e2e 逐个打开组合场景断言；`document` 上不残留 `mousedown` 监听（用注入计数器断言 add/remove 次数相等）
- [ ] **T013** [P][US2][US3] `styles.css` 加 `.model-group-title`（组标题、计数、sticky 与否由几何断言决定）、间距；`en.ts`/`zh.ts` 加 `model.group.other` 等新增文案 — 验证：360/430/900px 三档下组标题不越出 popover、无横向滚动；`i18n.spec.ts` 全绿，中英文都不出现键名

**Checkpoint**: 三条缺陷在同一组件内闭合；`chat.spec.ts` / `layout.spec.ts` 既有断言全绿，若因 DOM 结构变化修正断言，提交信息注明「基线变化，非回归」。

---

## Phase 2: skill 引用只显示标记（US4，依赖 T001）

- [ ] **T014** [US4] 按 T001 选定的分支实现 `web/src/lib/skillDisplay.ts`：`displayText(raw, originalPrompt?)` + 识别函数；只有「本会话发送过 `/skill:`」的消息才折叠，相似手写文本不折叠 — 验证：**先写** `skillDisplay.test.ts`（a/b/c 三种报文形态各一组 + 普通消息逐字不变 + 手写相似文本不折叠 + 多个 skill + 空问题），红 → 绿
- [ ] **T015** [US4] 数据层保留 pi 原文（若 T001 是独立块则给 `ContentBlock` 增 `skillref` 变体并归一化）；`MessageList.tsx` 渲染改走 `displayText()` — 验证：`web/e2e/skill-reference.spec.ts` 断言页面文本不含 SKILL.md 特征串、气泡只显示 `/skill:<name>` + 用户问题；切历史会话回放一致
- [ ] **T016** [US4] 消息操作统一：`MessageActions.tsx` 的 Copy / Quote / 编辑重发 / 重新生成，以及 `store.ts` 对应回填路径，全部取折叠文本 — 验证：e2e 逐个操作断言输入框/剪贴板得到 `/skill:name 问题` 而非全文；Fork 后新会话同样不回显全文
- [ ] **T017** [P][US4] mock 补「pi 展开后的 skill 用户消息」fixture（含 frontmatter / 多 skill / 无边界三种），并补双语文案（若有）— 验证：fixture 由开关控制、不污染默认会话；`i18n.spec.ts` 全绿
- [ ] **T018** [US4] 回归 006 搜索与 `SessionHtmlExporter`：确认两者仍按原文工作且未被折叠逻辑意外改坏 — 验证：`session-search.spec.ts` / `session-navigation.spec.ts` 全绿；导出 HTML 单测（若有）或手工抽查一条含 skill 的会话，全文仍在归档里（Non-goals 明确行为）

**Checkpoint**: 「全文不进气泡」由 DOM 断言锁死，且复制/引用不会把全文搬到输入框；数据层与归档语义未变。

---

## Phase 3: 更新 pi 结果不再乱码（US5，最后做，全局读入层）

- [ ] **T019** [US5] `PiCliRunner.drainThread` 改为按字节读 + `OsProcess.decodeOutput(bytes)`（严格 UTF-8 → 失败回退 `native.encoding`）；规范化 CRLF 并保留 `appendLine` 原语义 — 验证：**先写** JUnit 用构造字节数组覆盖两个方向：UTF-8 中文 / emoji（pi-node 侧）、CP936/GBK 字节含中文安装路径 `D:\软件\...`（Windows 侧）、`Ã©` 型误解码输入、纯 ASCII、CRLF、NUL、超长无换行，断言精确字符串且无 `\uFFFD` / `?`；**macOS 开发机也要能跑**，`PiCliRunnerTest` 既有按行断言全绿
- [ ] **T020** [P][US5] 新增 `sanitizeCliOutput(text)`：按 CSI 语法剥离 ANSI、处理 `\r` 进度条与 `\b`，不动普通 `[`/中文/换行；新增 `safeTruncate(text, 2000)` 按 code point 截断并加省略标记 — 验证：JUnit 逐项断言（含第 2000 位是 emoji 一半、合法含 `\u001B`、stdout/stderr 交错），纯 ASCII 输出与改动前逐字节一致
- [ ] **T021** [US5] `PiManage.envUpdate:373` 与 `cliToElement:517` 统一调用 `cliOutput(result)` helper，消除两处重复 `take(2000)`；`ok`/`exitCode`/`version` 字段原样保留 — 验证：`PiManageUpdateTest` 断言中文+emoji+ANSI 样例的输出文本精确匹配、失败场景 stdout/stderr 都可诊断
- [ ] **T022** [US5] 前端结果条回归：`ManageView.tsx` 的 `OutcomeBanner` 与 PackagesPanel 结果条展示清洗后文本 — 验证：`web/e2e/update-output.spec.ts` 断言 `env-update-result` 文本等于期望字符串、不含 `\uFFFD`/`Ã`/`\u001B[`；`manage.spec.ts` 全绿
- [ ] **T023** [US5] 全 CLI 命令 + setup 检测回归：mcp / packages / auth / settings / provider 等仍走同一 `drainThread`，JSON 解析不受影响；`PiEnvironment.toolVersion` / `npmConfiguredRegistry` 同批受益 — 验证：`./gradlew test` 全绿（含 `PiCliRunnerTest`、`PiManageTest`、`PiManageProviderTest`、`PiMcpConfigTest`、`PiEnvironmentTest`、`OsProcessTest`）；补一条「Windows 中文安装路径 + npm 中文警告 + 版本号仍是 ASCII」用例断言版本解析不破；逐个在 mock e2e 里打开 Manage 六个页签与 SetupCard，无解析错误

**Checkpoint**: 解码与清洗只有一处实现；两条更新链路 + 其它 CLI 命令都验证过，没有「修好中文、弄坏 JSON」的回归。

---

## Phase 4: 收尾

- [ ] **T024** [收尾] 全量四件套：`typecheck`、`npm test`、`npx playwright test`（连跑两轮查 flaky）、`./gradlew test`，数字回填 `specs/0.5.4-run-report.md` — 验证：四个命令 exit 0，报告里写明与 165/176 基线的差值及新增用例数
- [ ] **T025** [P][收尾] `MANUAL_TEST.md` 新增「0.5.4 缺陷回归」段：模型弹窗（定位/分组/点外关闭，含 360px 窄窗）、`/skill:` 引用后气泡与 Copy、中文更新结果条 — 验证：每条可由人手执行且有明确通过判据；截图存档路径写进执行记录
- [ ] **T026** [P][收尾] `CHANGELOG.md` 补 `## 0.5.4` 的「修复」/「Fixed」条目（中文在前、英文一一对应，遵守既有每分区 1–3 条、全段 ≤10 条的约束）— 验证：逐条对照本批次 5 条缺陷，无遗漏、无夸大
- [ ] **T027** [收尾] 真机目视：**必须在 Windows（中文系统 / 中文安装路径）跑一遍 T025 清单**，macOS 只能验 UI 不能验乱码；重点确认 `env-update-result` 与 Packages 结果条里中文还原、setup 检测 Node/npm/pi 版本仍正常、Q4（点工具窗外是否需关闭）— 验证：Windows 截图 + `chcp` 输出写进执行记录；Q4 若用户要求「工具窗外也关」，在本文件新开 task 并更新 spec FR-009/plan D3
- [ ] **T028** [收尾] 关闭 spec「开放问题」表：Q1 已关闭（Windows 代码页 + `b2d32b2`），Q2–Q4 逐条标注结论或「按默认实现、留待后续」；`specs/README.md` 的 0.5.4 段状态同步 — 验证：`spec.md` 表格无悬空问号；`git status` 仅剩本批次预期改动

---

## 完成判据

- 每个 task 自带「— 验证：…」，无断言覆盖的改动不得勾选（宪法 II）。
- **仅 T001 阻塞 Phase 2**（T002 降级为 Windows 验收证据、T003 为规模记录）；Phase 1 / Phase 3 不受阻塞，可先行。
- 真机目视项必须留截图或日志；CUA 不可用时不伪造结论，按 0.5.3 执行报告 §4 的写法记录阻塞与替代证据。
- 全量测试绿、`MANUAL_TEST.md` / `CHANGELOG.md` / `specs/README.md` 同步完成，方可标记本 feature 完成。

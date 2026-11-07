---
description: "Task list for 012-0.5.4-features"
---

# Tasks: 0.5.4 需求批次（会话标题 / 提示 / AGENTS.md / 引导与配置 / 图片预览）

**Input**: Design documents from `/specs/012-0.5.4-features/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)

**Tests**: vitest（标题同步 / tooltip 定位 / 图片集合纯函数）+ playwright e2e（独占门控、表单、模态框几何，mock bridge）+ JUnit（AGENTS.md 路径枚举、凭据写入）+ JCEF 真机目视。

**验证命令**：类型 `cd web && npm run typecheck`；单测 `cd web && npm test`；
e2e `cd web && npx playwright test <file>`；Kotlin `./gradlew test`；
真机 `powershell -ExecutionPolicy Bypass -File scripts\e2e-ide.ps1`（macOS/Linux 用 `scripts/e2e-ide.sh`）。

## Format: `[ID] [P?] [Story] Description — 验证：...`

- **US1** = 会话标题 / **US2** = tooltip / **US3** = AGENTS.md / **US4** = 安装独占 / **US5** = 配置引导 / **US6** = auth 管理 / **US7** = 图片预览
- **[P]** = 可与其他任务并行（无共享文件）
- **[前置]** = 阻塞性取证任务（**T101 卡 Phase 1、T102 卡 Phase 3、T103 卡 Phase 5**）
- **[取证]** = 记录基线，不阻塞实现
- **编号 101 起**：与同批次的 011（`T001–T028`）区分，派工时须显式写「012 的 T1xx」
- 基线（0.5.3 执行报告）：`typecheck 0 错误` / `vitest 165` / `playwright 176` / `gradlew test ✅`

---

## Phase 0: 契约取证

- [ ] **T101** [前置][US1] 抓一次真实 `pi --mode rpc` 会话，确认 pi **是否自动生成会话标题**、`session_info_changed` 的触发时机与字段、jsonl 里 `session_info` 的写入时点；结论写回 `plan.md` D1 — 验证：`plan.md` D1 明确写「pi 自动生成，插件只接管」或「降级为首条消息截断」二选一，并附事件片段；**未拿到不得写 FR-102 实现，更不得改成调模型生成摘要**
- [ ] **T102** [前置][US3] 确认 pi 实际加载 AGENTS.md 的**路径集合与优先级**（项目根 / 子目录 / 全局 `agentDir()` 各自是否生效、同名谁覆盖），记录 `PiCliRunner.agentDir()` 真机路径；结论写回 `plan.md` D4 — 验证：`plan.md` D4 有一张「层级 → 路径 → 优先级」实测表；未拿到不得定义 `AgentsFileEntry` 的层级枚举
- [ ] **T103** [前置][US5][US6] 确认 provider 凭据写入通道（pi 原生 `auth` 子命令 argv / 交互形态，或 `auth.json` 准确 schema）与 `models.json` 自定义 provider 最小必填字段；**同时请用户关闭 Q3**（是否推翻 README「不做表单式编辑 models.json」的历史决策）— 验证：`plan.md` D3 写定新方法名与返回契约，spec Q3 有结论；未拿到不得写任何凭据写入代码
- [ ] **T104** [取证][US2] 统计全部 `<button>` 数量与缺提示清单（含 manage 面板硬编码英文），写回 `plan.md` 作为覆盖率基线 — 验证：表格含「组件 / 按钮数 / 已有提示数 / 待补数」与统计命令；已知 0 提示组件为 `ManageView`(9)、`PackagesPanel`(4)、`ApprovalCard`(2)、`ConfirmDialog`(2)、`SettingsPanel`(2)、`MessageList`(1)

**Checkpoint**: T101/T102/T103 分别解锁 Phase 1 / 3 / 5；Q1–Q3 关闭或明确标注「按默认方案实现、待真机确证」；T104 只记基线。

---

## Phase 1: 会话标题（US1，T101 解锁）

- [ ] **T105** [US1] `store.ts:730` 的 `session_info_changed` 分支同步更新 `sessions` 中对应 `file` 的 `name`（或触发恰好一次 `refreshSessions()`），二者择一 — 验证：vitest 推送事件后 `sessions.find(f).name` 与 `sessionName` 相等；e2e 断言状态栏与列表行 `toHaveText` 相同，且 `sessions.list` 请求计数 ≤ 1
- [ ] **T106** [US1] store 增加 `editingSessionTitle` 与 `manualTitle` 标记，实现「手动标题优先于后续自动命名事件」，并在会话切换/删除时清理 — 验证：vitest 覆盖「手动改名后又收到自动事件 → 名称不变」「事件晚到但已切走会话 → 不写到别的会话」「会话删除后事件到达 → 不报错」
- [ ] **T107** [US1] `SessionsView.tsx:150-198` 增加 `data-testid="session-rename"` 与行内输入框：当前名为初值，Enter / 失焦提交、Esc 取消、空串与超长有可见校验，失败保留旧名 — 验证：e2e 覆盖 Enter/Esc/空值/失败 4 类；DOM 中同时存在的编辑框 ≤ 1；`set_session_name` 收到期望 name（mock 记录 argv/参数）
- [ ] **T108** [US1] `StatusBar.tsx:39` 的标题可点进入编辑，且与 T107 共用同一状态源 — 验证：e2e 从状态栏改名后会话列表同步变化；两处不会同时出现两个输入框
- [ ] **T109** [US1] 按 T101 结论实现自动命名接管；若结论为「pi 无自动命名」，实现首条用户消息截断降级（去换行/连续空白、限长、CJK 按字符计、只触发一次）— 验证：vitest 覆盖 CJK/emoji/超长/纯图片消息；断言**没有任何额外的 prompt/RPC 模型请求**；无标题时仍走 `preview → id → "Untitled"` 回退

---

## Phase 2: 按钮悬浮提示（US2，可先行）

- [ ] **T110** [P][US2] 新增 `web/src/components/Tooltip.tsx` + CSS：`getBoundingClientRect` 定位、视口翻转/夹取、hover/focus 双触发、延迟、`role="tooltip"` + `aria-describedby`、Esc/blur/卸载关闭、不拦截 pointer events — 验证：vitest 覆盖定位纯函数（四边翻转）；e2e 断言浮层矩形四条边均在视口内，且点击按钮的原有动作仍触发
- [ ] **T111** [P][US2] 按 T104 基线逐组件接入 Tooltip，优先补齐 0 提示组件；所有无文字图标按钮都有文案 — 验证：`plan.md` 基线表「待补数」全部归零；e2e 遍历图标按钮 hover/focus 均出现浮层，文案与字典一致
- [ ] **T112** [US2] 窄布局 `data-density=1/2`（`styles.css:2795-2805`）下折叠掉文字的按钮提示含当前值（当前模型 / 思考级别 / 语言）— 验证：e2e 把容器压到 density=2，断言 `model-chip` / `thinking-picker` 折叠后 hover 浮层含当前值文本
- [ ] **T113** [P][US2] 把 `AuthPanel.tsx:109-152`、`SettingsPanel.tsx:36-56` 等 manage 面板硬编码英文纳入 `en.ts` / `zh.ts` — 验证：`npm run typecheck` 0 错误（`en as const` 缺键会直接报错）；e2e 切到 zh 后面板无英文残留、无键名
- [ ] **T114** [US2] tooltip 与确认框 / 模型弹层 / 图片模态框共存时不叠加、不抢焦点 — 验证：e2e 打开 `confirm-dialog` 后 hover 其底部按钮，断言浮层 z-index 低于对话框或干脆不显示；`document.activeElement` 仍在对话框内

---

## Phase 3: AGENTS.md 多层级管理（US3，T102 解锁）

- [ ] **T115** [US3][P] Kotlin `manage.agentsList`：按 T102 实测层级枚举路径，返回 `{scope, path, relativePath?, exists, priority}`；**排除** `node_modules` / `.git` / 构建产物，深度与条目数设上限，异步执行 — 验证：JUnit 用临时目录构造「项目根 1 + 子目录 2 + 全局 1 + `node_modules` 内 3 个诱饵」，断言返回 4 行且诱饵 0；单次扫描 stat 调用数有上限断言
- [ ] **T116** [US3][P] Kotlin `manage.agentsOpen`：复用 `BridgeService.kt:660-673` 的 `LocalFileSystem` + `OpenFileDescriptor(...).navigate(true)` 打开指定路径，中文路径按 UTF-8 — 验证：JUnit 断言路径拼接与 `created=false` 语义；真机目视中文路径能在 IDE 编辑器打开且不乱码
- [ ] **T117** [US3][P] Kotlin `manage.agentsCreate`：复用 `PiManage.kt:208-224` 的模板写入模式（UTF-8、`mkdirs`、存在则幂等）+ VFS refresh（009 约定）— 验证：JUnit 连点 2 次仍 1 个文件、内容 UTF-8 中文往返无损；写只读目录时返回可见错误而非抛异常
- [ ] **T118** [US3] 桥接四处同步：`bridge/types.ts` 的 `BridgeMethod`、`manage.ts`、`BridgeService.kt:125-151` 分发、`bridge/mock.ts` fixture — 验证：`?agents=…` query 开关能驱动 3 层 fixture；漏任一处的 typecheck / e2e `unknown method` 用例会失败
- [ ] **T119** [US3] 新增 `AgentsPanel.tsx` 并在 `ManageView.tsx:14-22` 注册页签：层级标签、绝对路径、存在状态、优先级说明、打开 / 创建按钮；项目未信任时按 002 `PiTrust` 给可见解释 — 验证：e2e 断言 4 行、顺序与 T102 表一致、每行 `data-testid` 可定位；未信任 fixture 下显示原因横幅而非空白
- [ ] **T120** [US3] 补测试与文案：JUnit 路径/编码用例 + e2e 列表/优先级/幂等/中文 + `en.ts`/`zh.ts` 全量键 — 验证：`./gradlew test` 与 `npx playwright test` 对应用例全绿；`MANUAL_TEST.md` 留一条「在 IDE 编辑器打开 AGENTS.md」的真机项

---

## Phase 4: 首次安装全程独占（US4，建议早做以稳住 e2e 基线）

- [ ] **T121** [US4] store 增加 `setupGate: { needsSetup, state:"loading"|"ready"|"error", error? }`，把 `envDetect` 收敛为**唯一一次**调用；`setTab` 在 `setupRequired` 时为 no-op — 验证：vitest 断言 `envDetect` 调用计数 = 1；独占态调 `setTab("manage")` 后 `tab` 不变
- [ ] **T122** [US4] `App.tsx:74-138` 增加门控分支：`setupRequired` 时**提前 return 只渲染引导子树**，tabs / chat / sessions / manage / status bar / composer / confirm 全部不挂载；`state==="error"` 时显示可见错误 + 重试，按「不误判为需要安装」兜底 — 验证：e2e `?setup=missing` 下六类元素 `toHaveCount(0)`（不是 `not.toBeVisible()`）；mock 让 `envDetect` 抛错时主界面仍出现且错误可见
- [ ] **T123** [US4] `SetupCard.tsx` 移除「稍后」（`:142`）与内部 `detect()`（`:51-65`），改为消费 T121 的状态；保留安装源 / 自定义 registry / 手动路径 / 计时 / 日志 / 错误 — 验证：e2e `setup-dismiss`（若保留 testid 则 `toHaveCount(0)`）；`?setup=nonode` 的 node 警告与手动路径仍可见
- [ ] **T124** [US4] 停止安装（复用 `envCancelInstall`）后**保持独占**并恢复安装按钮；安装成功或 `envSetPath` 成功且 `restartPi()` 后 `piStatus==="running"` 才解除 — 验证：e2e `?install=hang` 点 `setup-cancel` 后 `tabs` 仍 `toHaveCount(0)`、`setup-install` 可点且 `setup-notice` 有「停止」文案；`?setup=missing` 安装成功后 `tabs` 出现、`setup-card` 消失
- [ ] **T125** [US4] 改写 `web/e2e/setup.spec.ts` 7 条：#4「失败后两条路径仍可用」、#5「成功解除独占」、#7「停止后仍可重试」按新语义更新，并新增独占断言组（Esc / setTab / 六类元素 / 检测失败）— 验证：`npx playwright test e2e/setup.spec.ts` 全绿；每条断言都是量化 `toHaveCount` / `toHaveText`
- [ ] **T126** [US4] 核对其它 e2e 的隐含前提：默认 mock 保持 `needsSetup=false`，逐个跑 `layout.spec.ts` / `i18n.spec.ts` / `chat.spec.ts` 等，确认零回归 — 验证：`npx playwright test` 全绿；执行记录里注明哪些用例因门控改了基线（标注「基线变化，非回归」）

---

## Phase 5: provider 配置链路（US5 / US6，T103 + Q3 解锁）

- [ ] **T127** [US5][US6] Kotlin 凭据写入/删除方法（名称与契约以 T103 为准）：只返回「成功/失败 + provider 名」，沿用 `PiManage.kt:463` 敏感 key 名单与 `modelsReadProvider` 的 `sanitize`；失败（无效 key / 命令不存在 / 权限）返回可见错误 — 验证：JUnit 断言返回体与日志中**零明文凭据**；`authOverview()` 在写入后包含该 provider、删除后不再包含
- [ ] **T128** [US5][US6] 桥接四处同步（同 T118 清单）+ mock fixture（含「已有凭据」与「写入失败」两种 query 开关）— 验证：e2e 两种 fixture 各自可复现；`npm run typecheck` 0 错误
- [ ] **T129** [P][US5][US6] 新增共用 `ProviderForm.tsx`：字段、校验、提交、错误、提交后清空本地 state，引导与 auth 页签复用同一组件 — 验证：vitest 覆盖必填/特殊字符/超长；e2e 断言两处入口 DOM 结构一致且校验文案相同
- [ ] **T130** [US5] 安装成功后进入「配置 provider」引导步骤：`authOverview()` 检测到已配置时给提示，提供明确「跳过」入口；按 Q8 结论决定是否用 `config.getPrefs/setPrefs` 持久化跳过 — 验证：e2e 断言跳过不写任何配置、主界面出现、二次启动不重复弹；提交后 `authOverview` 能看到 provider、`Check` 按钮可用
- [ ] **T131** [US6] `AuthPanel.tsx` 在保留 Refresh / Check / 展开 / 打开 `models.json` 四项能力的前提下，接入新增 / 编辑 / 删除；删除走 007 的 `ConfirmDialog`（不是原生 `confirm`）— 验证：e2e 覆盖四项旧能力零回归 + 新增/编辑/删除各一条；点删除出现 `confirm-dialog`，取消后 `authOverview` 不变
- [ ] **T132** [US6] `AuthPanel` 全量 i18n（T113 的一部分在此收口）+ `modelsState` 缺失/损坏/空三种态的可行动下一步；自定义 provider 表单范围按 Q3 结论（默认最小字段 + 「在编辑器打开 models.json」）— 验证：zh 界面无硬编码英文；三种 `modelsState` fixture 各有可见提示与按钮
- [ ] **T133** [US5][US6] 凭据零泄漏测试：DOM / console / bridge 响应 / e2e 快照四处断言明文不出现；失败场景（无效 key、命令不存在、网络）有可见错误文本 — 验证：e2e 用固定 sentinel 字符串填表，全局搜索快照中该串为 0 次；三条失败 fixture 各有断言

---

## Phase 6: 图片预览模态框（US7，UI 骨架可先行，桥接与 Phase 3/5 合并落地）

- [ ] **T134** [P][US7] 新增 `ImagePreview.tsx`：照抄 `ConfirmDialog.tsx` 的 `role="dialog"` + `aria-modal` + 遮罩点击 + `onWheel preventDefault` + 焦点陷阱 + Esc 关闭；等比缩放完整显示，点图片本身不关闭 — 验证：e2e 断言 `aria-modal="true"`、Esc/遮罩关闭、点图片不关闭、打开时消息列表 `scrollTop` 不变
- [ ] **T135** [P][US7] `ImagePreviewState` 从当前会话 items 按时间顺序收集 image 块（Q4 默认），←/→ 与界面按钮切换并显示 `当前/总数` — 验证：3 图 fixture 下指示为 `1/3`，按 → 变 `2/3`，边界不越界；vitest 覆盖空集合 / 单图 / 混排 text+image
- [ ] **T136** [P][US7] 缩放与拖拽：`scale` / `offset` 状态、wheel 与按钮、量化上下限、拖拽平移、复位 — 验证：e2e 断言连续滚轮后 `scale` 停在常量上限、复位后回到初始值、拖拽后 `transform` 数值变化；滚轮期间消息列表不滚动
- [ ] **T137** [US7] Kotlin `ide.saveImage` / `ide.copyImage`（JCEF 无 async clipboard API）：写用户选定路径 / 写系统剪贴板，取消保存不落盘，失败返回 `{ ok:false, error }`；桥接四处同步 — 验证：JUnit 断言取消时文件数为 0、成功时返回绝对路径；e2e mock 的失败分支能让 UI 显示错误
- [ ] **T138** [US7] 模态框「另存为 / 复制图片」按钮与结果提示，**失败必须可见、不得假装成功**（`clipboard.ts` 约定）— 验证：e2e 断言成功后有路径/成功文案、失败后有错误文案且无成功态；复制失败 fixture 单独一条
- [ ] **T139** [US7] `MessageList.tsx:17-20` 的 `.msg-image` 接入点击，复用 `types.ts:226-236` 的 `data:` 前缀 / 裸 base64 / mimeType 缺失兼容；未打开时不预渲染大图节点 — 验证：e2e 三种数据形态都能显示且点开模态框；DOM 里大图节点数 = 缩略图数（不额外复制）
- [ ] **T140** [US7] 补测试：3 图完整交互链 + 纯文本消息零回归 + 模态框打开时切换会话/清空消息不崩溃 — 验证：`npx playwright test` 对应用例全绿；纯文本消息的 DOM 快照与改动前一致

---

## Phase 7: 收尾与交付

- [ ] **T141** [收尾] i18n 全量核对：本批次所有新增可见文案 + manage 面板既有硬编码文案都在 `en.ts` / `zh.ts`，切换语言无键名 — 验证：`npm run typecheck` 0 错误；`i18n.spec.ts` 全绿；人工扫一遍 7 个 US 的新界面
- [ ] **T142** [收尾] 全量测试：`typecheck` / `vitest` / `playwright` / `gradlew test` 四项跑绿，把数字写进执行记录 — 验证：与 0.5.3 基线（`vitest 165` / `playwright 176`）对比，新增/变化用例逐条注明「基线变化，非回归」
- [ ] **T143** [收尾] `MANUAL_TEST.md` 新增「0.5.4 需求回归」段：7 条各一条真机目视项，重点 AGENTS.md 打开 IDE 编辑器、复制图片到系统剪贴板、另存对话框、Windows 中文路径、JCEF 下 tooltip 层级 — 验证：每条能在真机按步骤执行，留截图或日志
- [ ] **T144** [收尾] 关闭 spec 开放问题表：Q1–Q3 写取证结论，Q4–Q8 写结论或「按默认实现、留待后续」；同步 `specs/README.md` 的 0.5.4 需求段与 `plan.md` D1/D3/D4 — 验证：`spec.md` 表格无悬空问号；`git status` 只剩本批次预期改动
- [ ] **T145** [收尾] 真机目视：在 IDEA（含中文路径、Windows 若可得）跑一遍 T143 清单，确认独占引导不误锁、凭据不过桥、图片另存/复制真实可用 — 验证：截图/日志写进执行记录；若 IDE 剪贴板能力不足，按 Q6 缩减能力并在 spec 标注，**不得静默降级**

---

## Checkpoint 与完成判据

- **仅 T101 / T102 / T103 分别阻塞 Phase 1 / 3 / 5**；Phase 2、Phase 4、Phase 6 的 UI 骨架不受取证阻塞。
- 每个 task 自带「— 验证：…」；没有断言覆盖的改动不得标记完成（宪法 II）；几何/行为断言必须量化，不得只断言存在（010 约定）。
- 新增桥接方法必须四处同步（FR-135）；新增可见文案必须 `en.ts` / `zh.ts` 双份（008 约束）。
- 独占态一律用 `toHaveCount(0)` 断言「不渲染」，不用 `not.toBeVisible()`。
- 真机项留截图或日志；全量基线为 0.5.3 的 `typecheck 0 错误` / `vitest 165` / `playwright 176` / `gradlew test ✅`。
- **本批次只产出文档，不修改任何源码**（用户 2026-11-07 口径）；实现阶段另行派工。

## 实现记录

> 待执行时填充：取证结论、基线数字、真机截图路径、Q1–Q8 关闭情况。

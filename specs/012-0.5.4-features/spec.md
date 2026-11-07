# Feature Specification: 0.5.4 需求批次（会话标题 / 提示 / AGENTS.md / 引导与配置 / 图片预览）

**Feature Branch**: `release/0.5.4`

**Created**: 2026-11-07

**Status**: Draft（T101/T102/T103 取证未完成时不得进入对应 Phase，见「开工前置」）

**Input**: 用户 0.5.4 追加的 7 条需求清单：

1. 会话标题自动重命名与手动重命名
2. 按钮悬浮文字提示
3. Pi 的 AGENTS.md 管理
4. 引导用户安装，需要优化易用性，引导安装，不显示其他界面，更不允许切换关闭，但能允许用户点击按钮停止安装
5. 引导用户配置 provider
6. 配置里增加 auth 也就是 provider 管理
7. 图片预览点击弹出模态框预览

**澄清结论（2026-11-07，两轮提问）**：

| 项 | 用户决定 |
|---|---|
| 文档形态 | **新建 012 三段式**（spec / plan / tasks），7 条写成 7 个 User Story；011 缺陷批次保持独立不动，两批可分别交付 |
| 安装引导 | **初次检测到缺 pi 就全程独占**：整个工具窗只显示引导安装界面，隐藏聊天/会话/设置等其它一切内容与切换入口；不允许关闭；保留「停止安装」按钮。JCEF 内拦不住 IDE 侧关工具窗，写进 Non-goals |
| 配置 provider + auth | **一条链路，两者都做**：安装成功后引导配置 provider（**可跳过**）；Manage 的 auth 页签从只读升级为 provider 管理；两处共用同一套 `manage.*` API 与文案 |
| 会话标题 | **pi 自动生成，插件只接管**：插件只负责接收事件、同步显示、刷新列表、提供手动覆盖；不自己调模型生成标题。若取证发现 pi 没有自动命名，降级为「首条用户消息截断」 |
| AGENTS.md | **多层级列表 + 全局**：项目根、子目录、全局 `~/.pi/agent` 三层，逐项查看/编辑/新建，并说明生效优先级；不做启停/删除 |
| tooltip | **自定义 tooltip 组件**：统一应用内浮层，不依赖 JCEF 里不保证生效的原生 `title` |
| 图片预览 | **四项能力全做**：单图放大 + Esc/点遮罩关闭、多图左右切换、缩放与拖拽、另存为 / 复制图片 |

**约束基准**：`specs/README.md` 记载的 Spec Kit 宪法约束（`.specify/memory/constitution.md` 为 machine-local、被 `.gitignore` 忽略，当前工作机不存在，原文读不到）：第 II 条「无断言覆盖不得标记完成」、第 III 条「不得依赖运行时环境假设」，以及 010 沿用下来的「几何/行为断言不得只断言存在」。另受 008-i18n 约束：新增可见文案 MUST 同时进 `en.ts` / `zh.ts`。

**编号约定**：0.5.4 批次同时存在 011（FR-001–023 / T001–028）与 012 两份文档。为避免执行代理把两份 tasks.md 的 `T001` 混为一谈，**本 feature 的 FR 与 Task 一律从 101 起编号**（`FR-101…` / `T101…`），编号前缀不代表 spec 序号。

## 现状与差距（已核对代码，非推测）

| # | 诉求 | 代码定位 | 现状 / 差距 |
|---|---|---|---|
| G1 | 会话标题自动 + 手动重命名 | `web/src/store/store.ts:1319-1332` `renameSession(name)` 已实现（`set_session_name` RPC + `refreshSessions()`）；`:730-732` `session_info_changed` 事件只 `set({ sessionName })`；`:307` state 字段；`web/src/components/StatusBar.tsx:10,39` 显示标题；`web/src/components/SessionsView.tsx:157-196` 只有 switch/clone/export/delete；`web/src/bridge/mock.ts:1211`、`test/mock-pi/mock-pi.mjs:342` 已支持 `set_session_name` | **底层能力齐、UI 入口完全没有**。且事件到达时**不刷新会话列表**：`refreshSessions()` 只在 `setTab("sessions")`（`store.ts:798`）与 new/delete/clone/rename 后调用。Kotlin 侧 `session/PiSessionIndex.kt:93-94` 从 jsonl 的 `session_info` 条目读 name，`bridge/BridgeService.kt:379-395` 返回给前端，链路已通 |
| G2 | 按钮悬浮提示 | 全组件共约 65 处 `title=` / `aria-label=`；`web/src/styles.css:2795-2805` 窄布局 `data-density=1/2` 把按钮文字藏掉只留图标；**仓库没有任何 tooltip 组件或 CSS 类** | 缺提示最集中的组件：`ManageView.tsx`(9 按钮/0 提示)、`PackagesPanel.tsx`(4/0)、`ApprovalCard.tsx`(2/0)、`ConfirmDialog.tsx`(2/0)、`SettingsPanel.tsx`(2/0)、`MessageList.tsx`(1/0)、`AuthPanel.tsx`(4/1)。另有 manage 面板大量硬编码英文（`AuthPanel.tsx:109-152`、`SettingsPanel.tsx:36-56`）未走 008 字典 |
| G3 | AGENTS.md 管理 | **全仓库 0 处提及**（`.ts/.tsx/.kt/.md/.mjs` 全扫） | 完全从零。可复用：`manage/PiManage.kt:208-224` 写 SKILL.md 模板、`:312-340` `settingsRead/Write` 的文本读写、`bridge/BridgeService.kt:660-673` `modelsOpenFile`（`OpenFileDescriptor` 在 IDE 编辑器打开并跳行）、`:525-535` `ide.openFile`、`:176` `PiCliRunner.agentDir()` 全局目录 |
| G4 | 引导安装独占 | `web/src/App.tsx:74-138` 无条件渲染 tab 栏 + 当前 tab 内容 + `StatusBar` + `ConfirmDialog`；`web/src/components/SetupCard.tsx:136` `dismissed || !env?.needsSetup || piStatus === "running"` 决定卡片显隐、`:142` 有「稍后」按钮、`:51-65` **组件内部自己调 `envDetect`**；`src/main/kotlin/dev/pi/agent/manage/PiEnvironment.kt:220` `needsSetup = install == null`、`:73-106` `installing/installCancelled`；`BridgeService.kt:127,131` 分发 | `needsSetup` **只存在于 SetupCard 的局部 state**，App 拿不到 → 无法在 App 层做门控。独占需要把检测结果提升为共享状态，并处理「检测失败」「已有 pi 但进程未启动」等边界，否则可能把主界面永久锁死 |
| G5 | 引导配置 provider | `SetupCard.tsx:71-102` 安装成功后直接 `restartPi()` 并隐藏卡片；`web/src/manage.ts:220-221` 只有 `authOverview` / `authCheck`；`PiManage.kt:257-286` `authOverview` 返回 providers / withCredentials / modelsState | 安装成功后没有任何「下一步」。配置凭据的写入通道**目前不存在**（`PiManage.kt:290-308` 只有 `pi auth check --no-refresh`），需要先取证 pi 的写入命令或确定直写 `auth.json` |
| G6 | auth / provider 管理 | `web/src/components/ManageView.tsx:14-22,356-357` **已有 auth 页签**；`web/src/components/manage/AuthPanel.tsx` 全文只读（Refresh / Check / 展开 `models.json` 配置 / 打开文件）；`PiManage.kt:410-450` `modelsReadProvider` 带 `sanitize`、`:463` 敏感 key 名单 | 是「已有但需改造」，不是新增页签。增删改凭据与自定义 provider 全缺；面板文案硬编码英文；`sanitize` 约定（001 T019：原始凭据不过桥）必须保住 |
| G7 | 图片模态框预览 | `web/src/components/MessageList.tsx:17-20` inline `<img className="msg-image">`，无点击行为；`web/src/store/types.ts:11-12` image 块 `{ kind:"image", data, mimeType }`、`:226-236` 兼容 pi 的 `source.mediaType/data` 与 prompt 的 `data/mimeType`；`Markdown.tsx` 不渲染 `<img>`；`web/src/components/ConfirmDialog.tsx` 有可复用的 `role="dialog"` / `aria-modal` / Esc / 焦点陷阱 / `onWheel` 阻止背景滚动样板 | 图片只在 ContentBlock.image 一处，来源清晰。但 `web/src/lib/clipboard.ts:1-10` 注释明确「JCEF 不带 async clipboard API，只有 `execCommand("copy")` 兜底」——**复制图片二进制与另存为都必须新增 Kotlin 侧桥接**，前端做不到 |

**三处必须写进设计的既有事实**：

1. **自动命名的真实漏点**：`store.ts:730` 收到 `session_info_changed` 只改 `sessionName`（状态栏立即更新），不刷新 `sessions` 数组，`SessionsView.tsx:159` 的列表标题会滞后到下次切页。G1 的「自动」= 补这条同步，不是重新实现标题生成。
2. **历史决策冲突**：`specs/README.md`「未纳入本批」明确写着「**插件内表单式编辑 `models.json`**：会与 pi 的 schema 演进强耦合，001 采用『打开文件』而非自建编辑器」。G6 若做自定义 provider 的表单式 CRUD，等于推翻该决策。本 spec 的默认折中是「凭据走 pi 原生 `auth` 命令、自定义 provider 仍用打开文件」，是否推翻见开放问题 Q3。
3. **桥接四处同步**：新增 `manage.*` 或 `ide.*` 方法必须同时改 `web/src/bridge/types.ts`（`BridgeMethod`）、`web/src/manage.ts` / 前端调用方、`BridgeService.kt:125-151`（分发）、`web/src/bridge/mock.ts`（mock），否则 e2e 会拿到 `unknown method`。

## 开工前置

沿用 009/011 T001「先取证再改代码」的做法。三项均为**阻塞性**，各自卡住对应 Phase：

- **T101**（阻塞 Phase 1）：抓一次真实 `pi --mode rpc` 会话，确认 pi 是否**自动生成会话标题**、`session_info_changed` 事件的触发时机与字段、以及 `session_info` 在 jsonl 里的写入时点。若 pi 无自动命名，按用户口径降级为「首条用户消息截断」，结论写回 `plan.md` D1，**不得擅自改成调模型生成摘要**。
- **T102**（阻塞 Phase 3）：确认 pi 实际加载 AGENTS.md 的**路径集合与优先级**（项目根、子目录、全局 `~/.pi/agent` 各自是否生效、同名时谁覆盖），并检查 `agentDir()` 的真实位置。文件列表的定义必须以实测为准，不得凭通用约定猜。
- **T103**（阻塞 Phase 5）：确认 provider 凭据的写入通道（`pi auth login` 之类原生命令的 argv / 交互形态，或 `auth.json` 的准确 schema），以及 `models.json` 自定义 provider 的最小必填字段。**未拿到前不得写任何凭据写入代码**；顺带确认 Q3 是否推翻历史决策。
- **T104**（非阻塞）：统计当前 `<button>` 总数与缺提示清单，写回 `plan.md`，作为 G2 的覆盖率基线。

## User Scenarios & Testing *(mandatory)*

> 7 个 User Story 与 7 条需求一一对应。US5 / US6 同属「provider 配置链路」，共用一套 API、表单与验收口径，但各自可独立验收。

### User Story 1 - 会话标题自动生成与手动重命名 (Priority: P1)

会话列表不该一直显示「Untitled」或首句预览；pi 给出标题后界面要立刻跟上，用户也要能自己改。

**Independent Test**: mock 推送一条 `session_info_changed`（name = "Fix the login bug"）→ 断言状态栏与会话列表同一帧内都显示该标题；再在会话列表行内改名并回车 → 断言 `set_session_name` 收到新名、列表与状态栏同步、刷新后不回退。

**Acceptance Scenarios**:

1. **Given** pi 自动产出标题并推 `session_info_changed`，**Then** `sessionName` 更新、`sessions` 数组里对应 `file` 的 `name` 同步更新（或触发恰好一次 `refreshSessions()`），状态栏与会话列表文本一致。
2. **Given** 用户停留在会话页时事件到达，**Then** 列表标题当场变化，无需先切走再切回。
3. **Given** 用户在会话列表点「重命名」，**Then** 出现行内输入框（当前名为初值）、Enter 提交 / Esc 取消 / 失焦提交；空串或纯空白不提交，长度超限给出可见提示。
4. **Given** 提交手动标题，**Then** 复用既有 `renameSession(name)`（不新增 RPC）、成功后刷新列表；失败时错误以系统消息可见，且旧标题保持不变（不乐观覆盖）。
5. **Given** 用户在状态栏点当前会话标题，**Then** 也可进入编辑，且与列表行内编辑是同一个状态源，不会出现两处不一致。
6. **Given** 手动改过名，**Then** 后续 pi 自动命名事件不得覆盖用户手动标题（除非用户再次手动修改）；切换会话/重开窗口后仍显示手动名。
7. **Given** 会话无标题，**Then** 沿用 `SessionsView.tsx:159` 的 `preview → id → "Untitled"` 回退，不显示空白。

### User Story 2 - 按钮悬浮文字提示 (Priority: P2)

图标按钮（尤其窄布局下文字被 CSS 隐藏后）要能说明自己是干什么的，且提示在 JCEF 里真的看得见。

**Independent Test**: 把工具窗宽度压到 `data-density=2`，逐个 hover / focus 所有图标按钮 → 断言每个都出现应用内浮层，文案与 `en`/`zh` 字典一致，浮层完整落在视口内。

**Acceptance Scenarios**:

1. **Given** 任一按钮声明了提示文案，**When** 鼠标悬浮或键盘 focus，**Then** 显示应用内浮层（不是浏览器原生 `title`），延迟与消失有节奏，且不吞掉按钮点击。
2. **Given** 窄布局 `data-density=1/2` 隐藏了 `.btn-lbl` / `.chip-label`，**Then** 这些按钮仍可读到提示（提示内容含当前值，如当前模型/思考级别）。
3. **Given** 按钮靠工具窗右/下边缘，**Then** 浮层自动翻转或夹在视口内，不溢出、不被 `overflow:hidden` 裁掉。
4. **Given** 中英文界面切换，**Then** 提示文案走字典，不出现键名或硬编码英文；manage 面板既有硬编码文案一并纳入字典。
5. **Given** 提示显示中按 Esc 或移开焦点，**Then** 浮层关闭；按钮 disabled 时不显示误导性提示（或明确说明为何不可用）。
6. **Given** 弹层（模型选择器 / 确认框 / 图片模态框）打开，**Then** tooltip 不叠在弹层之上、不抢焦点。

### User Story 3 - AGENTS.md 多层级与全局管理 (Priority: P2)

用户能一眼看出哪些 AGENTS.md 会被 pi 读到，并直接打开编辑或新建。

**Independent Test**: 用「项目根 1 个 + 子目录 2 个 + 全局 1 个」的 fixture 打开新页签 → 断言 4 行、层级标签、优先级说明、逐行「打开」定位到正确绝对路径。

**Acceptance Scenarios**:

1. **Given** 三层都有文件，**Then** 列表按 T102 实测的生效优先级排序，每行显示层级（项目根 / 子目录相对路径 / 全局）、绝对路径、大小或行数、是否存在。
2. **Given** 某层文件不存在，**Then** 显示为「未创建」并提供「创建」按钮；创建后写入 UTF-8 模板、刷新 VFS 并在 IDE 编辑器打开，重复点击不产生第二份。
3. **Given** 点任一已存在项，**Then** 通过 IDE 编辑器打开该文件（复用 `OpenFileDescriptor` 路径），中文路径 / 文件名不乱码。
4. **Given** 项目含 `node_modules` / `.git` / 大量目录，**Then** 扫描范围限定在 T102 定义的层级，不递归全仓库、单次扫描不阻塞 UI（异步且有上限）。
5. **Given** 项目未信任（002 `PiTrust`），**Then** 项目级文件的读写受同一信任判定约束，界面说明原因，不静默失败。
6. **Given** 全局文件位于 `agentDir()` 之外或路径不存在，**Then** 给出可见说明，不伪造空文件、不报错崩溃。
7. **Given** 切换语言，**Then** 层级名、状态与按钮文案全走字典。

### User Story 4 - 首次安装全程独占引导 (Priority: P1)

初次使用检测到需要安装 pi 时，工具窗只显示引导安装界面；没有其它界面，也不能切换或关闭；唯一允许的中止动作是点「停止安装」。

**Independent Test**: `?setup=missing` 打开页面 → 断言 `tabs` / `composer` / `message-list` / `sessions-view` / `manage-view` / `status-bar` 全部 `toHaveCount(0)`，引导界面可见且无「稍后」；点停止后仍保持独占；成功后主界面出现。

**Acceptance Scenarios**:

1. **Given** `manage.envDetect` 返回 `needsSetup=true`，**Then** `App` 只渲染引导界面，**不渲染 tab 栏本身**（不只是禁用），聊天/会话/设置/状态栏/确认框一律不挂载。
2. **Given** 独占态，**Then** 不存在任何切页入口、关闭按钮、「稍后」按钮；Esc 不关闭；`setTab` 之类的快捷键/调用不生效。
3. **Given** 独占态，**Then** 保留安装源选择、自定义 registry、手动指定 pi 路径、进度计时、日志、错误/提示，以及 `data-testid="setup-cancel"` 的「停止安装」按钮（复用既有 `envCancelInstall`）。
4. **Given** 用户点「停止安装」，**Then** npm 进程被中止、显示「已停止」类提示、安装按钮恢复可用，**且仍停留在引导界面**（未装好 pi，不解锁主界面），可改源重试或填已有 pi 路径。
5. **Given** 安装成功或 `envSetPath` 成功且 `restartPi()` 后 pi 状态变为 running，**Then** 独占解除，正常界面出现，不需要刷新窗口。
6. **Given** `envDetect` 调用失败 / 超时 / 返回异常，**Then** 不得把主界面永久锁死：有可见错误与重试入口，且按「不误判为需要安装」的安全方向兜底。
7. **Given** 已有 pi 但进程尚未启动（`needsSetup=false`、`piStatus="notStarted"`），**Then** 不进入独占，显示既有加载/启动态。
8. **Given** 用户从 IDE 侧关闭工具窗或切到编辑器，**Then** 不在本版拦截范围（Non-goal），但重新打开工具窗时独占态按最新检测结果重建。

### User Story 5 - 安装后引导配置 provider（可跳过） (Priority: P1)

装完 pi 的第一步不该是空白聊天框，而应是「配好一个能用的 provider」；已经用环境变量或 `auth.json` 配好的用户要能跳过。

**Independent Test**: `?setup=missing` 装完 → 断言进入配置引导；点「跳过」→ 主界面出现；填入凭据提交 → `authOverview()` 能看到该 provider、`Check` 可用。

**Acceptance Scenarios**:

1. **Given** 安装成功，**Then** 引导进入「配置 provider」步骤，列出可选 provider 与所需字段（以 T103 实测为准），有明确的「跳过」入口。
2. **Given** 点「跳过」，**Then** 立即进入主界面，不二次弹窗、不写任何配置；下次启动不再重复引导本次安装后的配置步骤。
3. **Given** 用户已有凭据（环境变量 / `auth.json`），**Then** 引导以 `authOverview()` 的结果提示「检测到已配置 X」，允许直接跳过或继续新增。
4. **Given** 提交凭据，**Then** 调用 T103 定下的写入通道，成功后 `authOverview()` 与 `authCheck` 可用；失败原因（无效 key / 网络 / 命令不存在）以可见文本呈现，不静默吞掉。
5. **Given** 凭据输入与结果回显，**Then** 原始密钥**不出现在 DOM、日志、bridge 响应或 e2e 快照**（沿用 `PiManage.kt:463` 的敏感 key 名单与 001 T019 约定）。
6. **Given** 中英文切换，**Then** 引导所有文案走字典。

### User Story 6 - Manage 的 auth 页签升级为 provider 管理 (Priority: P1)

现有的只读 auth 页签要能增删改凭据与自定义 provider，并与 US5 的引导共用同一套 API / 表单 / 文案。

**Independent Test**: 在 auth 页签新增一个凭据 → 断言 `authOverview` 出现该 provider、磁盘 `auth.json` 有对应键、DOM 无明文密钥；再编辑、删除 → 断言列表与磁盘同步。

**Acceptance Scenarios**:

1. **Given** 打开 Manage → auth，**Then** 保留既有 Refresh / Check / 展开配置 / 打开 `models.json` 四项能力且零回归，同时新增「新增 / 编辑 / 删除」入口。
2. **Given** 新增或编辑凭据，**Then** 与 US5 引导走同一个表单组件与同一个 `manage.*` 方法，不出现两套校验逻辑。
3. **Given** 删除操作，**Then** 走应用内确认框（007 的 `ConfirmDialog`），不是原生 `confirm`；取消后无写入。
4. **Given** 查看任一 provider 配置，**Then** 敏感值仍按 `sanitize` 显示为「configured / not configured」，明文不过桥、不进 DOM。
5. **Given** `models.json` 缺失 / 损坏 / 为空，**Then** 沿用 `AuthPanel.tsx:101-107` 的 `modelsState` 提示，新增操作给出可行动的下一步（创建骨架或打开文件），不静默空白。
6. **Given** 自定义 provider 的表单范围，**Then** 以 Q3 的结论为准：默认只做最小必填字段 + 「在编辑器打开 models.json」，不全量复刻 pi schema。
7. **Given** 中英文切换，**Then** 面板全部文案（含目前硬编码的 `Refresh` / `Check` / `Save` / `Reload` 等）走字典。

### User Story 7 - 点击图片弹出模态框预览 (Priority: P2)

消息里的图片点一下就能看清，并在多图、缩放、保存、复制上给完整操作。

**Independent Test**: 推送一条含 3 张 image 块的消息 → 点第 1 张打开模态框，断言 `aria-modal`、指示为 `1/3`；←/→ 切换、滚轮缩放、拖拽、Esc 与点遮罩关闭、另存与复制各自可用且失败可见。

**Acceptance Scenarios**:

1. **Given** 消息里有图片，**When** 点击 `.msg-image`，**Then** 弹出居中模态框（`role="dialog"` + `aria-modal="true"`），按容器等比缩放完整显示，不做拉伸裁切。
2. **Given** 模态框打开，**When** 按 Esc 或点击遮罩，**Then** 关闭；点击图片本身不关闭；背景消息列表不随滚轮滚动（参照 `ConfirmDialog` 的 `onWheel` 处理）。
3. **Given** 会话内有多张图片，**Then** ←/→ 与界面按钮可切换，显示 `当前/总数`；切到边界不越界、不循环跳到无关消息。
4. **Given** 图片很大，**Then** 滚轮 / 按钮缩放有上下限（量化到具体倍率区间），拖拽可平移查看细节，且提供复位。
5. **Given** 点「另存为」，**Then** 通过 Kotlin 侧桥接写入用户选定路径并返回可见结果；取消保存不产生文件。
6. **Given** 点「复制图片」，**Then** 通过 Kotlin 侧剪贴板能力写入图片数据；JCEF 不支持时降级为可见提示，**不得假装成功**（沿用 `clipboard.ts` 的「失败要显示为失败」约定）。
7. **Given** 图片数据为 `data:` URL 前缀或裸 base64、mimeType 缺失，**Then** 按 `types.ts:226-236` 既有兼容规则正确显示，不出现坏图。
8. **Given** 纯文本消息，**Then** 渲染零回归；未打开模态框时不预渲染大图节点。

### Edge Cases

- 会话标题：标题含换行 / 超长 / emoji / CJK；同一会话连发多条 `session_info_changed`；会话切换期间事件晚到（不得写到别的会话上）；会话被删除后事件到达；`refreshSessions()` 并发去重。
- tooltip：按钮在滚动容器内、tooltip 在容器边界、按钮被 disabled / 卸载、快速连续 hover、触摸/笔输入、`prefers-reduced-motion`。
- AGENTS.md：文件为空 / 非法 UTF-8 / 只读 / 符号链接 / 项目根与全局同名 / 子目录深层嵌套 / 未信任项目 / 用户在 IDE 里外部改动文件后列表过期。
- 安装引导：`envDetect` 反复失败、检测返回但 pi 进程随后启动、安装过程中重启 IDE、`envSetPath` 指向无效路径、停止安装后又立刻重试、已有旧版 pi 但 `needsSetup` 判定边界。
- provider：`auth.json` 不存在 / 损坏 / 权限不足、凭据含特殊字符、`authCheck` 超时、用户跳过引导后又从 Manage 进入、多 provider 同名大小写。
- 图片：单条消息混排 text + image、base64 超大图、非图片 mimeType、损坏数据、多图来自不同消息、模态框打开时会话被切换/清空。

## Requirements *(mandatory)*

### Functional Requirements

**US1 会话标题**

- **FR-101**: `session_info_changed` 事件 MUST 同时更新 `sessionName` 与会话列表对应项（或触发恰好一次 `refreshSessions()`），状态栏与列表 MUST 一致；不得只在切页时才刷新。
- **FR-102**: 自动标题来源 MUST 以 T101 取证为准：pi 自动生成时插件只接管呈现；pi 无自动命名时降级为「首条用户消息截断」，**MUST NOT** 为此发起额外模型请求。
- **FR-103**: 手动重命名 MUST 复用既有 `renameSession(name)` / `set_session_name`，不新增 RPC；会话列表行内编辑与状态栏标题入口 MUST 共用同一状态源。
- **FR-104**: 行内编辑 MUST 支持 Enter 提交 / Esc 取消 / 失焦提交，空串与超长 MUST 有可见校验，失败 MUST 保留旧标题并给出可见错误。
- **FR-105**: 用户手动标题 MUST 优先于后续自动命名事件；无标题时 MUST 沿用 `preview → id → "Untitled"` 回退。

**US2 tooltip**

- **FR-106**: MUST 提供统一的应用内 tooltip 组件（定位 + 显示/隐藏 + 延迟），MUST NOT 依赖浏览器原生 `title` 作为唯一提示手段。
- **FR-107**: 所有无文字图标按钮 MUST 有提示；`data-density=1/2` 折叠掉文字的按钮 MUST 仍能读到提示（含当前值）。
- **FR-108**: 浮层 MUST 自动翻转/夹取以完整落在视口内，MUST NOT 拦截按钮点击，MUST 在 Esc / blur / 卸载时关闭。
- **FR-109**: tooltip 文案与 manage 面板既有硬编码英文 MUST 全部进 `en.ts` / `zh.ts`（008 约束）；键盘 focus 与 hover 等价可读，带 `aria-describedby` 或等价语义。
- **FR-110**: tooltip MUST NOT 覆盖在确认框 / 弹层 / 图片模态框之上，不得抢焦点。

**US3 AGENTS.md**

- **FR-111**: 新增 Manage 页签 MUST 列出 T102 实测的全部生效层级（项目根 / 子目录 / 全局），每行含层级、路径、存在状态，并按实测优先级排序且说明优先级。
- **FR-112**: 每一项 MUST 可在 IDE 编辑器打开（复用 `OpenFileDescriptor` 路径）；不存在时 MUST 可一键创建 UTF-8 模板并刷新 VFS，重复创建 MUST 幂等。
- **FR-113**: 扫描 MUST 限定在 T102 定义的层级与数量上限，MUST 排除 `node_modules` / `.git` 等无关目录，MUST 异步执行且不阻塞 UI；项目级读写 MUST 受 002 信任模型约束并在界面解释原因。
- **FR-114**: AGENTS.md 内容 MUST 原样交给 IDE 编辑器编辑，插件 MUST NOT 解析或覆写用户内容；文件状态异常 MUST 可见而非静默空白。
- **FR-115**: 新增可见文案 MUST 进 `en.ts` / `zh.ts`；中文路径与内容 MUST 按 UTF-8 处理（011 FR-017 的教训）。

**US4 安装引导独占**

- **FR-116**: `manage.envDetect` 判定 `needsSetup=true` 时，`App` MUST 只渲染引导界面；tabs、chat、sessions、manage、status bar、composer、confirm 等 MUST NOT 挂载（不是隐藏 CSS，是不渲染）。
- **FR-117**: 独占态 MUST 移除「稍后」与一切切页/关闭入口；Esc 与 `setTab` MUST NOT 解除独占。
- **FR-118**: 独占态 MUST 保留安装源、自定义 registry、手动指定路径、进度计时、日志、错误提示与「停止安装」按钮；停止按钮 MUST 复用 `manage.envCancelInstall`。
- **FR-119**: 点「停止安装」后 MUST 中止 npm、给出「已停止」提示、恢复安装按钮，**并保持在独占引导界面**；成功安装或 `envSetPath` + `restartPi()` 使 pi running 后 MUST 自动解除独占。
- **FR-120**: `needsSetup` MUST 提升为 App 与引导组件共享的状态（单一 `envDetect` 调用点），避免双重检测与竞态；检测失败/超时 MUST 有可见错误与重试，且 MUST 按「不误判为需要安装」的安全方向兜底，不得锁死主界面。
- **FR-121**: `needsSetup=false` 且 `piStatus≠"running"` 时 MUST NOT 进入独占；既有 `setup.spec.ts` 的 7 条用例 MUST 在语义更新后全绿，其它默认 `needsSetup=false` 的 e2e 零回归。
- **FR-122**: 拦截 IDE 侧关闭/切走工具窗 MUST NOT 在本版实现（JCEF 内不可达），写进 Non-goals；重新打开工具窗时独占态按最新检测结果重建。

**US5 / US6 provider 配置链路**

- **FR-123**: 安装成功后 MUST 进入「配置 provider」引导步骤，并提供明确「跳过」入口；跳过 MUST NOT 写配置、MUST NOT 二次弹出。
- **FR-124**: 引导与 auth 页签 MUST 共用同一套 `manage.*` 方法、表单组件、校验规则与 i18n 文案；MUST NOT 出现两套实现。
- **FR-125**: 凭据写入通道 MUST 以 T103 取证结果为准；在取证完成前 MUST NOT 写死 `auth.json` schema 或凭空拼 `pi auth` 子命令。
- **FR-126**: auth 页签 MUST 在保留 Refresh / Check / 展开 / 打开 `models.json` 四项既有能力的前提下，提供新增 / 编辑 / 删除；删除 MUST 走 007 的应用内确认框。
- **FR-127**: 原始凭据 MUST NOT 出现在 DOM、日志、bridge 响应或测试快照；查看配置 MUST 沿用 `PiManage.kt:463` 的 `sanitize`「configured / not configured」语义。
- **FR-128**: `models.json` 缺失 / 损坏 / 空 MUST 沿用 `modelsState` 提示并给出可行动下一步；自定义 provider 的表单范围以 Q3 结论为准，默认不做全量 schema 编辑器。
- **FR-129**: 配置成功 / 失败（无效 key、命令不存在、网络、权限）MUST 有可见结果，`authOverview()` / `authCheck` 状态 MUST 随之刷新；面板现有硬编码英文 MUST 全部 i18n 化。

**US7 图片预览**

- **FR-130**: 点击 `.msg-image` MUST 打开 `role="dialog"` + `aria-modal` 的居中模态框，等比缩放完整显示；Esc / 点遮罩关闭，点图片不关闭，背景滚动 MUST 被阻止。
- **FR-131**: 多图 MUST 支持 ←/→ 与界面按钮切换并显示 `当前/总数`；集合范围以 Q4 结论为准（默认当前会话内所有 image 块按时间顺序）。
- **FR-132**: 缩放 MUST 有量化上下限并支持拖拽平移与复位；MUST NOT 让滚轮同时滚动消息列表。
- **FR-133**: 另存为与复制图片 MUST 通过新增 Kotlin 侧桥接实现（JCEF 无 async clipboard API）；取消保存不产生文件，失败 MUST 可见，MUST NOT 假装成功。
- **FR-134**: 图片数据 MUST 复用 `types.ts:226-236` 的两种来源兼容规则；未打开模态框时 MUST NOT 预渲染大图节点；纯文本消息零回归。
- **FR-135**: 新增桥接方法 MUST 同步 `bridge/types.ts`、`manage.ts`/调用方、`BridgeService.kt` 分发、`bridge/mock.ts` 四处（011 既有约定）。

**通用**

- **FR-136**: 所有几何/行为断言 MUST 量化（元素数量、文本内容、倍率、可见区矩形），不得只断言存在。
- **FR-137**: 既有 `typecheck` / `vitest` / `playwright` / `gradlew test` 全量 MUST 保持绿；受独占门控影响的既有用例必须在执行记录里注明「基线变化，非回归」。
- **FR-138**: 新增可见文案 MUST 同时进 `en.ts` / `zh.ts`；`MANUAL_TEST.md` MUST 增补本批次 7 条真机目视清单。

### Key Entities

- **SetupGate**：`{ needsSetup, detectState: "loading"|"ready"|"error", error? }`，App 层唯一的门控状态源，由一次 `manage.envDetect` 填充；`setupRequired = needsSetup && piStatus !== "running"`。
- **ProviderFormState**：`{ provider, fields, mode: "guided"|"manage", submit, validate }`，US5 与 US6 共用；只持有待写入值，永不接收服务端返回的明文凭据。
- **AgentsFileEntry**：`{ scope: "projectRoot"|"subdir"|"global", path, relativePath?, exists, priority }`，由 T102 实测的层级规则生成；插件不解析文件内容。
- **ImagePreviewState**：`{ items: Array<{ data, mimeType, messageId }>, index, scale, offset }`，从当前会话的 image 块按时间顺序收集，按需渲染。
- **TooltipSpec**：`{ contentKey, placement, trigger: "hover"|"focus" }`，按钮与文案字典之间的唯一映射点。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `session_info_changed` 到达后状态栏与会话列表文本一致（e2e 断言两处 `toHaveText` 相同），刷新次数 ≤ 1；手动重命名 Enter/Esc/空值/失败 4 类断言全绿，且 DOM 中不出现第二份编辑框。
- **SC-002**: 缺提示按钮清零（以 T104 基线清单逐项核对）；`data-density=2` 下所有图标按钮 hover/focus 均出现浮层，浮层矩形完全落在视口内；en/zh 切换后无键名、无硬编码英文。
- **SC-003**: 3 层 fixture 下列表行数 = 4、优先级顺序与 T102 一致、每项「打开」定位到正确绝对路径；新建模板幂等（连点 2 次仍 1 个文件）；`node_modules`/`.git` 不被扫描；中文路径往返无乱码。
- **SC-004**: `needsSetup=true` 时 6 类主界面元素 `toHaveCount(0)`、「稍后」`toHaveCount(0)`、`setup-cancel` 可见；点停止后仍保持 `toHaveCount(0)`；成功后 `tabs` 出现；`envDetect` 失败时不锁死界面。
- **SC-005**: 安装后引导出现且可跳过；提交凭据后 `authOverview()` 包含该 provider；凭据明文在 DOM / 日志 / 网络响应中零出现；失败场景有可见错误文本。
- **SC-006**: auth 面板新增/编辑/删除后 `authOverview` 与磁盘一致；删除走应用内确认框；既有四项只读能力零回归；面板文案 100% 走字典。
- **SC-007**: 3 图 fixture 下打开模态框、`1/3` 指示、←/→ 切换、缩放上下限、拖拽复位、Esc/遮罩关闭、另存返回路径、复制成功/失败提示全部有断言；纯文本消息渲染与改动前一致。
- **SC-008**: 全量测试绿，数字回填执行记录（基线 0.5.3：`typecheck 0 错误` / `vitest 165` / `playwright 176` / `gradlew test ✅`）；`MANUAL_TEST.md` 新增 0.5.4 需求回归段，7 条均可真机目视执行。

## Non-goals

- **拦截 IDE 侧关闭/切走工具窗**：JCEF 内的 document 监听收不到工具窗外的交互；本版不实现，也不承诺「绝对无法关闭」。
- **停止安装后解锁主界面**：本版停止后仍留在引导页（未装好 pi），用户可改源重试或填已有 pi 路径；这是出口，不是死路。
- **AGENTS.md 的启用/停用、删除、重命名与内容语义解析**：只做列表、查看、新建与在 IDE 编辑器中编辑；不做插件内富文本编辑器。
- **推翻 001 的历史决策**：默认不做 `models.json` 全字段表单式编辑器；若要推翻，须先关闭 Q3 并更新 `specs/README.md` 的「未纳入本批」段。
- **插件自行生成会话标题**：不额外调用模型；pi 无自动命名时只用首条消息截断。
- **跨会话/跨项目图片库、OCR、图片编辑**：只预览当前会话里已存在的 image 块。
- **引入第三方 tooltip / lightbox 依赖**：本版用应用内组件实现（除非执行时另行确认）。

## 开放问题（写进 spec 以便执行时逐条关闭）

| # | 待确认 | 谁提供 | 影响 |
|---|---|---|---|
| Q1 ✅ **已关闭**（2026-11-07 真机取证，T101） | **pi 无自动命名**：3 个 RPC 会话 + 源码闭环证明 `session_info_changed` 仅由 `setSessionName` 触发；官方回写通道 `set_session_name` RPC 存在（空名被拒，事件 + jsonl 同步） | FR-102 降级实现：首条消息截断生成标题后 `set_session_name` 回写（skill 形态用 userMessage 优先），不做任何模型调用 |
| Q2 ✅ **已关闭**（2026-11-07 真机取证，T102） | 全局 + cwd 全部祖先**同时加载、拼接不覆盖**；每目录候选序 `AGENTS.override.md > AGENTS.md > AGENTS.MD > CLAUDE.md > CLAUDE.MD` 取首个；CLAUDE.md 仅同目录无 AGENTS 系时兜底 | FR-111 层级定义照此实现：全局 #0 → 根 #1 → 子目录按深度；`manage.agentsList` 算法与 pi 对齐 |
| Q3 ✅ **已关闭**（2026-11-07 取证 + 按默认折中，T103） | pi 1.4.0 **无任何官方写入通道**；auth.json schema 与 `proper-lockfile` 目录锁协议已从源码确证；models.json 由 pi 只读、`apiKey` 是字段之一 | **不推翻**历史决策：凭据写入 = 单键 merge（内置→auth.json 复刻锁协议；自定义→models.json 原子写 + 回读校验），富字段编辑仍走「在编辑器打开」 |
| Q4 ✅ **已关闭**（按默认实现） | 多图集合 = 当前会话全部 image 块，按时间序 | `collectImages(items)` 按会话收集，UI 显示 `当前/总数` |
| Q5 ✅ **已关闭**（按默认实现） | 停止安装后保持独占、恢复安装按钮；仅安装成功或手动路径成功才解除 | e2e #7 断言 `tabs` 仍 `toHaveCount(0)` |
| Q6 ✅ **已关闭**（按默认实现） | 另存走 IDE 平台保存对话框（`FileSaverFactory`，用户自选目录）；复制写系统剪贴板（AWT `imageFlavor`）；取消不落盘、失败可见 | `ide.saveImage` / `ide.copyImage` 桥接实现并四处同步 |
| Q7 ✅ **已关闭**（按默认实现） | 本批覆盖：图标按钮与密度折叠 chip（T104 基线 0 提示组件 + tools-right）；动态生成按钮与 disabled 原因提示留待后续（`data-tip` 机制已可扩展） | TooltipHost 是全局委托层，后续接入只需加属性 |
| Q8 ✅ **已关闭**（按默认实现） | 跳过持久化：`config.setPrefs { providerSetupSkipped: true }`，重开不再提示 | 引导步只在「本次安装成功后」主动出现一次；跳过写 prefs |

# Implementation Plan: 0.5.4 需求批次

**Branch**: `release/0.5.4` | **Spec**: [spec.md](./spec.md) | **Tasks**: [tasks.md](./tasks.md)

**Status**: Draft（T101 / T102 / T103 取证完成前不得进入 Phase 1 / 3 / 5；Phase 2 tooltip、Phase 4 安装门控与 Phase 6 图片 UI 骨架不受阻塞）

**范围**：7 条新需求，集中在四处：`App.tsx` 的渲染门控、`SessionsView`/`StatusBar` 的标题链路、Manage 侧新增的 provider 与 AGENTS.md 能力、`MessageList` 的图片查看器。**只写文档，本批次不改任何源码**（用户 2026-11-07 明确要求）。

> 编号约定：本 feature 的 FR / Task 从 101 起，避免与同批次的 011（`FR-001…` / `T001…`）混淆。

## 设计决策

### D1 会话标题：接管事件，不重新发明标题生成

现状链路已完整到「只差 UI 与一次同步」：

```
pi 写 jsonl 的 session_info.name
 → PiSessionIndex.kt:93-94 解析
 → BridgeService.sessionsList():388 返回 SessionInfo.name       [列表]
pi 推 session_info_changed
 → store.ts:730 set({ sessionName })                            [状态栏]
 → ❌ 没有 refreshSessions / 没有更新 sessions 数组             [列表滞后]
```

改法：`store.ts:730` 收到事件后**同时**乐观更新 `sessions` 里 `file === sessionId` 对应的 `name`（或在 `tab === "sessions"` 时触发一次 `refreshSessions()`），两者选一，不做双份请求；手动重命名完全复用 `renameSession(name)`（`store.ts:1319`，已带 `set_session_name` + `refreshSessions`），不新增 RPC。

UI 入口：会话列表行内编辑（复用 `SessionsView.tsx:150-198` 的 row 结构，新增一个 `data-testid="session-rename"` 按钮 + 编辑态 input）+ 状态栏标题可点（`StatusBar.tsx:39`）。两处共用 store 里的 `editingSessionTitle` 状态，避免两个输入框互相打架。

**手动优先规则**：store 记一个 `manualTitle?: { file, name }`（或读 `SessionInfo` 上的标记），`session_info_changed` 到达时若该会话已有手动标题则不覆盖。不引入持久化新字段前，至少保证「本次会话内不覆盖 + 刷新后由 jsonl 的 `session_info` 最后一次写入决定」。

**T101 分支**：若真机证明 pi 不自动生成标题 → 降级为「首条用户消息截断」（取 `items` 里第一条 user 文本，去换行/连续空白，限长，CJK 按字符计），在 `message_end` 后判定一次并调用既有 `renameSession`；**不新增模型调用**（用户口径）。结论写回本文件 D1。

**✅ T101 取证结论（2026-11-07，pi 1.4.0 真机 RPC + 源码闭环）**：**pi 无自动命名，插件降级「首条消息截断」+ 回写**。证据：
- 3 个 RPC 会话、4 条用户消息、3 个完整 agent 周期（均到 `agent_end`/`agent_settled`），**零 `session_info_changed` 事件**；`get_state.data` 无 name/title 字段；jsonl 全量类型无 `session_info` 条目。
- 源码闭环：`session_info_changed` 唯一发射点是 `setSessionName(name)`；`appendSessionInfo` 仅 3 个调用点：`-n` 启动（直接写 jsonl、**不发事件**）、TUI `/name`、RPC `set_session_name`。不存在「从首条消息生成标题」的代码路径。
- **官方回写通道存在**：`set_session_name` RPC（`{"name": "..."}` → success + `session_info_changed` 事件 + jsonl `session_info` 条目），空名被拒（`Session name cannot be empty`）。
- 实现口径：首条用户消息截断生成标题后**调 `set_session_name` 回写**（pi 落盘 + 广播，列表/状态栏同步全走既有链路）；名字不变时不调用（幂等）。若首条命中 skill 展开形态，用 `parseSkillBlock().userMessage` 优先、`name` 属性兜底（见 011 plan D4）。
- 附带坑：`-n` 启动不发事件，插件需自记；0 消息会话文件进程退出时被清理（PiSessionIndex 需容忍文件缺失）；jsonl 的 name 取**最后一条** `session_info` 条目。

### D2 安装独占：门控状态必须上提，且只做一次检测

现在 `needsSetup` 是 `SetupCard.tsx:23` 的局部 `env` state，App 无从得知。若直接把 `envDetect` 再调一次，会出现两次 RPC、两个状态源、以及「卡片已隐藏但 App 还锁着」的竞态。

改法：在 store 增加 `setupGate: { needsSetup, state: "loading"|"ready"|"error", error? }`，由 `init()`（或 App 的一个专用 effect）**唯一一次**调用 `manage.envDetect` 填充；`SetupCard` 改为消费该状态，不再自己 `detect()`。App 在 `setupRequired = needsSetup && piStatus !== "running"` 时**提前 return 只渲染引导界面**：

```
App
 ├─ !ready                    → loading
 ├─ setupGate.state==="error" → 可见错误 + 重试（不锁死主界面，安全兜底）
 ├─ setupRequired             → <SetupGateView/>  （仅此一个子树，tabs 等完全不挂载）
 └─ 正常                      → 既有 tabs + 内容 + StatusBar + ConfirmDialog
```

「不显示其他界面」用**不渲染**实现（FR-116），不是 `display:none`——后者仍会让 e2e 命中元素、仍会跑 `MessageList` 的订阅与滚动逻辑。「不允许切换关闭」= 移除 `SetupCard.tsx:142` 的「稍后」、tab 栏根本不挂载、`setTab` 在独占态为 no-op、Esc 无关闭路径。

**停止安装后保持独占**（FR-119）：`SetupCard.tsx:104-115` 的 `cancel` 已有完整逻辑，只需保证 `dismissed`/`needsSetup` 不被改成 false；停止后安装按钮恢复可用，用户可改源重试或走 `setup-path-input` 填已有 pi 路径——这是出口，不是死路。

**解除独占**只在两条路径：安装成功（`SetupCard.tsx:95-96` 已 `restartPi()` 并把 `needsSetup` 置 false）或 `envSetPath` 成功。两者都要以 `piStatus === "running"` 为准，避免「装完但进程没起来」直接放开主界面后又弹错误。

**Kotlin 侧现状**：`PiEnvironment.kt:220` `needsSetup = install == null`；`:73-106` 的 `installing/installCancelled` 与 `BridgeService.kt:127,131` 分发已完备，**本批次不改 Kotlin 安装逻辑**。

**e2e 影响面**：`web/e2e/setup.spec.ts` 7 条全部带 `?setup=missing|nonode`，独占态下 `setup-card` 内的断言仍成立（卡片只是换了父容器），但 #4「两条路径仍可用」、#5「成功安装卡片消失」、#7「停止后回到可用状态」的语义要同步改写；其余默认 `needsSetup=false` 的 e2e 零影响。`layout.spec.ts` 里对 `tabs` 的几何断言在 `?setup=missing` 场景若存在需一并核对。

### D3 provider 配置链路：一个表单、一个 API、两处入口

用户把「引导配置 provider」与「auth/provider 管理」定为一条链路。实现上收敛为：

```
ProviderForm（共用组件：字段 + 校验 + 提交 + 错误）
 ├─ US5 引导视图（安装成功后，带「跳过」）
 └─ US6 Manage → auth 页签（新增 / 编辑 / 删除）
        ↓ 共用
   manage.* 新方法（T103 定契约） → BridgeService 分发 → PiManage
```

**凭据绝不回传**：`PiManage.kt:463` 已有敏感 key 名单，`modelsReadProvider():410-450` 的 `sanitize` 已把值替换为布尔。新增写入方法 MUST 只返回「成功/失败 + provider 名」，返回体与日志里不得出现明文；表单提交后立刻清空本地 state。

**历史决策冲突（必须执行时先确认 Q3）**：`specs/README.md`「未纳入本批」写着「插件内表单式编辑 `models.json` 会与 pi schema 演进强耦合，001 采用打开文件而非自建编辑器」。默认折中：
- 凭据（API key / token）→ 走 T103 取证的 pi 原生 `auth` 命令或 `auth.json` 单键写入，字段少、schema 稳定；
- 自定义 provider（baseUrl / models / headers 等 schema 富字段）→ 继续用 `manage.modelsOpenFile` 在 IDE 编辑器里改，插件只做最小引导与状态展示。

若用户确认推翻，需要更新 README 的那段说明，并把「全字段表单 + schema 版本兼容」单列风险，不在本版顺手做。

**✅ T103 取证结论（2026-11-07，pi 1.4.0 源码穷举 + 真机对照）**：
- **无官方凭据写入子命令/RPC**（`pi auth` 仅 `print-api-key`/`print-bearer-token`/`check`，全只读；27+ 个 RPC 命令逐个核对无凭据方法）。
- **auth.json schema**（源码 TypeBox 校验 + 真实文件对照）：顶层 `{ [providerId]: credential }`；`credential := {type:"api_key", key:string} | {type:"oauth", access, refresh, expires:number}`，其余条目使**整个文件被 pi 拒绝**。
- **写入协议**（FileAuthStorageBackend）：`proper-lockfile` **目录锁**（`<auth.json>.lock` 目录，重试 10×20ms；异步 30s 死线）→ 读旧内容 merge `{...current, [provider]: next}` → `JSON.stringify(,null,2)` UTF-8 mode 0600 写入（非原子 rename）。**pi 运行中 OAuth 刷新会持锁重写**，插件直写必须复刻锁协议。
- **models.json**：pi 只读；`ProviderConfig` 全字段可选（功能最小集见现有 xiami 条目：`id/name/baseUrl/api/apiKey/models`），`models[]` 仅 `id` 必填；解析失败 = 整个文件作废。凭据优先级 `auth.json > models.json apiKey`。
- **落地契约**：`manage.authSet`（内置 provider → auth.json 目录锁 + merge + 回读自校验）/ `manage.providerSetKey`（自定义 provider → models.json 原子写 + 回读校验），均只返回 `{ok, provider}` 或 `{ok:false, error}`。就绪探测用 `pi auth check --json --provider <id>`（不带 `--credentials` 不泄值）。
- **Q3 处置**：历史决策「不做表单式编辑 models.json」**不推翻**——凭据写入是单键 merge，不是 schema 富字段表单；自定义 provider 的 baseUrl/models 仍走「在 IDE 编辑器打开」。

**跳过是否持久化**（Q8）：默认记进既有 `config.getPrefs/setPrefs`，避免每次新安装都重复引导；若用户要求「仅本次跳过」，则不写 prefs。

### D4 AGENTS.md：列表 + 打开 + 新建，内容一律交给 IDE 编辑器

用户选了「多层级列表 + 全局」。

**✅ T102 取证结论（2026-11-07，真机 system prompt 实测 + 源码闭环）**——pi 的加载算法（`loadProjectContextFiles`）：
- **全局 + 全部祖先目录同时加载、拼接而非就近覆盖**；顺序 = 全局 `agentDir()`（即 `$PI_CODING_AGENT_DIR` || `~/.pi/agent`，与 `PiCliRunner.agentDir()` 一致）最前，然后从 cwd **逐级向上到根**收集（最终最上层祖先在前、cwd 最后），路径去重；git worktree 阴影：链接 worktree 的主仓根同名文件被跳过。
- **每目录内部取第一个存在者**，候选顺序 `AGENTS.override.md > AGENTS.md > AGENTS.MD > CLAUDE.md > CLAUDE.MD`；CLAUDE.md 只在同目录无 AGENTS 系文件时兜底。
- 有任一文件时 system prompt 出现 `sections.project_context`，每个文件包 `<project_instructions path="…">`。

插件 `manage.agentsList` 的层级枚举照此复刻（全局 1 行 + cwd 祖先链逐目录 1 行，标注每行实际命中的文件名与 scope），**不做就近覆盖语义**。

实现骨架：

```
manage.agentsList   → Kotlin 按 T102 层级枚举候选路径（项目根 / 子目录 / agentDir()）
                      → 返回 [{scope, path, relativePath?, exists, priority}]
manage.agentsOpen   → 复用 BridgeService.modelsOpenFile:660-673 的
                      LocalFileSystem + OpenFileDescriptor(...).navigate(true)
manage.agentsCreate → 复用 PiManage.skillCreate:208-224 的写模板模式
                      （UTF-8、mkdirs、存在则幂等）+ VFS refresh（009 的刷新约定）
```

四条硬约束：
1. **扫描有界**：只枚举 T102 定义的层级，排除 `node_modules` / `.git` / 构建产物，子目录层级深度与总条目数设上限；异步执行，不让 UI 卡在大仓库上。
2. **不解析内容**：插件只管「文件在不在、能否打开」，编辑在 IDE 编辑器里完成，避免与 pi 的 AGENTS.md 语法演进耦合。
3. **信任边界**：项目级读写沿用 002 的 `PiTrust` 判定，未信任时给可见解释；全局文件不受项目信任影响但要提示其作用范围。
4. **编码**：路径与模板一律 UTF-8，避免重蹈 011 D5 的 Windows 代码页覆辙。

### D5 tooltip：应用内浮层，不引第三方库

`ConfirmDialog.tsx` 已经证明了应用内浮层在 JCEF 里可行（原生 `window.confirm` 不可样式化、不可翻译）。tooltip 同样自己做：`Tooltip` 组件用 `getBoundingClientRect()` 定位、按视口翻转/夹取、`role="tooltip"` + `aria-describedby`、hover/focus 双触发、延迟显示、Esc/卸载关闭，**不拦截 pointer events**。

覆盖清单以 T104 基线为准，优先补 0 提示的组件：`ManageView`(9/0)、`PackagesPanel`(4/0)、`ApprovalCard`(2/0)、`ConfirmDialog`(2/0)、`SettingsPanel`(2/0)、`MessageList`(1/0)、`AuthPanel`(4/1)。窄布局折叠按钮（`styles.css:2795-2805`）的提示要带当前值（当前模型 / 思考级别 / 当前语言）。

顺带把 manage 面板的硬编码英文（`AuthPanel.tsx:109-152`、`SettingsPanel.tsx:36-56` 等）纳入 `en.ts` / `zh.ts`——008 约束，且 `en` 是 `as const` 类型源，缺键会直接 typecheck 失败。

### D6 图片预览：前端交互 + Kotlin 侧文件/剪贴板桥接

前端：`ImagePreview` 模态框照抄 `ConfirmDialog.tsx` 的 `role="dialog"` / `aria-modal` / 遮罩点击 / `onWheel preventDefault` / 焦点陷阱样板；`ImagePreviewState` 从当前会话的 items 里按时间顺序收集 image 块（Q4 默认当前会话），按需渲染，不预生成大图节点。缩放用 `scale + offset`（wheel / 按钮 / pointer drag），上下限写进常量并在 e2e 里断言。

**复制与另存必须走 Kotlin**：`web/src/lib/clipboard.ts:1-10` 的注释已确认 JCEF 不带 async clipboard API，只有文本 `execCommand("copy")` 兜底。因此新增两条桥接（FR-135 四处同步）：

```
ide.saveImage  { data, mimeType, suggestedName } → IDE 文件保存对话框 / Kotlin 写文件 → { ok, path? }
ide.copyImage  { data, mimeType }                → IDE CopyPasteManager（或临时文件 + 剪贴板）→ { ok }
```

失败 MUST 返回 `{ ok:false, error }` 并在 UI 可见，**不得像旧代码那样假装成功**（`clipboard.ts` 的设计约定）。两条都要考虑大 base64 过桥的开销与取消保存时不落盘。

### D7 桥接契约四处同步

新方法与既有方法一样，改一处漏一处就会在 e2e 里变成 `unknown method`：

| 层 | 文件 |
|---|---|
| 类型 | `web/src/bridge/types.ts` 的 `BridgeMethod` 联合类型 |
| 前端调用 | `web/src/manage.ts`（manage.*）或 `web/src/bridge/index.ts`（ide.*） |
| 分发 | `src/main/kotlin/dev/pi/agent/bridge/BridgeService.kt:111-151` |
| mock | `web/src/bridge/mock.ts`（含 e2e fixture 开关） |

本批次预计新增：`manage.agentsList / agentsOpen / agentsCreate`、`manage.authSet / authRemove`（名称以 T103 为准）、`ide.saveImage / ide.copyImage`。

### D8 编号与文档隔离

012 与 011 同属 0.5.4，但**互不引用对方的 task 编号**；两份 tasks.md 都要在 README 的 0.5.4 段里各自成表。执行代理派工时必须显式写「执行 012 的 T1xx」，不能只写「T101」以外的模糊编号。

## 现状 → 目标对照

| 主题 | 现状 | 目标 |
|---|---|---|
| 会话标题 | `renameSession` 有 API 无 UI；事件只更新状态栏 | 事件同步列表 + 行内/状态栏双入口编辑，手动优先 |
| 提示 | 65 处原生 `title`，0 组件；窄布局藏文字 | 应用内 Tooltip 全覆盖 + i18n + 键盘可达 |
| AGENTS.md | 0 处实现 | Manage 新页签：三层列表 / 打开 / 幂等新建 / 优先级说明 |
| 安装引导 | chat 页里一张可「稍后」关掉的卡片，tab 随时可切 | `needsSetup` 全程独占，App 层不渲染其它子树，仅留停止安装 |
| 配置引导 | 安装成功后直接结束 | 可跳过的 provider 配置步骤，与 auth 页签共用表单与 API |
| auth 页签 | 只读（Refresh/Check/展开/打开文件），硬编码英文 | 增/改/删 + i18n + sanitize 不变 |
| 图片 | inline `<img>` 无交互 | 模态框：放大/多图/缩放拖拽/另存/复制 |

## 触及文件（预计，实现阶段可微调）

| 文件 | 改动 |
|---|---|
| `web/src/App.tsx` | 新增 `setupRequired` 门控分支，独占时只渲染引导子树 |
| `web/src/store/store.ts` | `setupGate` 状态与唯一 `envDetect` 调用；`session_info_changed` 同步列表；`editingSessionTitle`；`manualTitle` 标记；`setTab` 在独占态 no-op |
| `web/src/components/SetupCard.tsx` | 移除「稍后」与内部 detect；消费 store；成功后解除独占；保留停止安装 |
| `web/src/components/SessionsView.tsx` / `StatusBar.tsx` | 行内重命名、标题可点编辑 |
| `web/src/components/Tooltip.tsx`（新） | 统一浮层组件 |
| `web/src/components/ManageView.tsx` | 新增 AGENTS.md 页签注册；auth 页签保持不变入口 |
| `web/src/components/manage/AuthPanel.tsx` / `ProviderForm.tsx`（新） | CRUD + 共用表单 + i18n |
| `web/src/components/manage/AgentsPanel.tsx`（新） | 三层列表 / 打开 / 新建 |
| `web/src/components/MessageList.tsx` / `ImagePreview.tsx`（新） | 图片点击 → 模态框；另存/复制按钮 |
| `web/src/bridge/types.ts`、`web/src/manage.ts`、`web/src/bridge/mock.ts` | 新增桥接方法与 mock 分支（含 e2e fixture） |
| `web/src/i18n/locales/{en,zh}.ts` | 全部新增文案 + manage 面板既有硬编码文案 |
| `web/src/styles.css` | tooltip、setup gate、agents 列表、图片模态框样式 |
| `src/main/kotlin/dev/pi/agent/bridge/BridgeService.kt` | 新方法分发；复用 `openFileInEditor` / `modelsOpenFile` 的打开逻辑 |
| `src/main/kotlin/dev/pi/agent/manage/PiManage.kt` | agents 枚举/创建、auth 写入（契约以 T102/T103 为准）、复用 `sanitize` |
| `src/main/kotlin/dev/pi/agent/manage/PiEnvironment.kt` | **不改**（`detect/install/cancelInstall` 已完备） |
| `web/e2e/*`、`src/test/kotlin/**`、`MANUAL_TEST.md`、`specs/README.md` | 新用例、基线调整、真机清单、批次总览 |

## 顺序与依赖

```
Phase 0 取证：T101 ──阻塞──► Phase 1 会话标题
             T102 ──阻塞──► Phase 3 AGENTS.md
             T103 ──阻塞──► Phase 5 provider 链路
             T104 按钮基线 ── 非阻塞
Phase 2 tooltip（纯前端、无外部依赖）────────── 可先行
Phase 4 安装引导独占（改 App 门控，影响面最大）── 建议早做，便于 e2e 基线先稳
Phase 6 图片：UI 骨架可先行；另存/复制依赖 Kotlin 桥接 ── 可与 Phase 3/5 的桥接改动合并落地
Phase 7 收尾：i18n 全量核对 / 全基线 / MANUAL_TEST / 真机目视
```

**顺序上真正不可颠倒的只有两条**：
1. T101/T102/T103 → 各自的 Phase（契约没定就写实现＝返工）；
2. `App` 门控（Phase 4）→ 所有 e2e 基线核对（独占会一次性改变多个 spec 里「默认页面元素」的隐含前提）。

Phase 2 / 6 的纯前端部分与 Kotlin 桥接解耦，可在任意空档穿插。

## 测试策略

- **契约先测**：新增的每个 `manage.*` / `ide.*` 方法先在 mock 里落 fixture（沿用 `?setup=missing` / `?install=hang` 这类 query 开关），再写 e2e；不要靠真机 pi 跑自动化。
- **构造字节/数据**：AGENTS.md 的中文路径、图片的非 UTF-8 mimeType、凭据特殊字符，全部用固定 fixture，不依赖开发机 locale（宪法 III）。Windows 代码页场景延续 011 FR-017 的处理，不在本批次重新引入默认 charset 解码。
- **独占态断言**：用 `toHaveCount(0)` 断言「不渲染」而非 `not.toBeVisible()`；逐项覆盖 tabs / composer / sessions / manage / status bar / confirm 六类。
- **几何/行为量化**：tooltip 浮层矩形与视口边界、图片缩放倍率上下限、模态框焦点落点，全部量化（宪法 II + 010 约定）。
- **零回归**：`setup.spec.ts` 7 条改写后全绿；`sessions.spec.ts` 的 clone/export/delete 流程、既有 manage 六个页签、`i18n.spec.ts` 全部保持；`typecheck 0 错误` / `vitest 165` / `playwright 176` / `gradlew test ✅` 为 0.5.3 基线，数量变化需注明「基线变化，非回归」。
- **真机目视**：AGENTS.md 打开 IDE 编辑器、复制图片到系统剪贴板、另存为对话框、Windows 中文路径、JCEF 下 tooltip 是否浮在正确层级——这些自动化覆盖不到，写进 `MANUAL_TEST.md` 并留截图。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| `envDetect` 失败把主界面永久锁死 | 门控三态 loading/ready/error，error 走可见错误 + 重试，且按「不误判为需要安装」兜底（FR-120）；e2e 覆盖 mock 抛错路径 |
| 独占改动波及大量既有 e2e 隐含前提 | Phase 4 早做，一次性核对基线；默认 mock 保持 `needsSetup=false` |
| pi 的 AGENTS.md 加载规则与猜测不符 | T102 阻塞 Phase 3；列表定义与优先级全部从实测结果生成，代码里不写死通用约定 |
| 凭据写入方式猜错 / 明文泄漏 | T103 阻塞 Phase 5；写入前不写 schema；sanitize 与「明文不过桥」写进 e2e 断言 |
| 推翻 001「不做表单式编辑 models.json」的历史决策 | Q3 先拍板；默认折中方案不改历史决策，若推翻须同步更新 README 那段 |
| JCEF 剪贴板/文件保存能力不足 | 复制与另存走 Kotlin 桥接并允许明确失败；不假装成功，必要时按 Q6 缩减能力并在 spec 标注 |
| 大仓库 AGENTS.md 扫描卡顿 | 层级有界 + 排除目录 + 异步 + 条目上限；不在 UI 线程递归全仓库 |
| 两批文档 task 编号混淆 | FR/Task 一律 101 起；README 0.5.4 段分别成表；派工提示词显式写「012 的 T1xx」 |

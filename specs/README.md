# 待实现功能总览（Spec Kit）

> 生成时间：2026-11-02（001–005）；**0.5.2 批次 006–010 见文末**
> 0.5.2 批次生成时间：2026-11-04
> 约束基准：[`.specify/memory/constitution.md`](../.specify/memory/constitution.md)
> 本目录下每个 `NNN-*` 都遵循 spec → plan → tasks 三段式，可独立交付。

## 缺口来源与判定依据

本次盘点**不依赖文档自述**，而是逐条核对代码与真实运行环境。四类证据：

| 来源 | 用途 |
|---|---|
| `docs/PRODUCT_DESIGN.md` 的 P0–P3 规格表 | 找出「设计里有、代码里没有」的项 |
| `docs/TASK_PLAN.md` 的 ☐ 与「用户决定跳过」 | 找出流程上未闭环的项 |
| `docs/UI_ISSUES.md` 的「附：关联隐患」 | 找出修复时被部分处理的遗留 |
| 实测 `pi --help` / `pi mcp --help` / `~/.pi/agent/*.json` | 校正方案，避免把猜测写进规格 |

实测纠正了两个原本会写错的方案（详见 001 plan）：
`pi update` 原生支持 `--self` / `--extensions` / `--models`，不需要自拼 `npm i -g`；
`pi mcp` **没有** enable/disable，停用只能在配置层实现。

## 五个 Feature

| # | 名称 | 优先级 | 缺口本质 | 关键证据 |
|---|---|---|---|---|
| 001 | [Manage 面板功能补全](./001-manage-completeness/spec.md) | P1 | 能加不能停、能装不能升、能看不能改 | `PiManage.kt` 无 `mcpSetEnabled` / `packageUpdate` / `envUpdate`；`authOverview` 只返回 provider 名字 |
| 002 | [项目级资源的信任模型](./002-project-trust/spec.md) | P1 | 配置做对了却不生效，且界面不解释 | `trust.json` 中 `pi-agent-idea` 未被信任；`skillsList()` 用 `File(".pi/skills")` 相对路径 |
| 003 | [静默失败可见化](./003-error-visibility/spec.md) | P1 | 空列表分不清「为空」还是「失败」 | `store.ts` 有 12 处 `.catch(() => undefined)` / 空 catch |
| 004 | [IDE 侧动作的自动化覆盖](./004-action-coverage/spec.md) | P2 | 动作注册/可用性无任何自动化 | UI_ISSUES 第 8 条自述「无自动化覆盖」；TASK_PLAN Phase 7/8 真机验收连续跳过 |
| 005 | [插件镜像消息队列](./005-message-queue/spec.md) | P1 | 流式排队不可见、不可操作；假计数永不更新 | 初版「pi 无队列读写」的断言经实测证伪（2026-11-03 修订）：`queue_update` 携带完整 steering/followUp 数组、`clear_queue` 可全量取出。**新提需求，非审计缺口** |

### 严重度排序逻辑

- **001 排第一**：唯一会造成**用户配置丢失**的缺口（想停用 MCP 只能删除重填）。
- **002 排第二**：唯一会造成**用户按文档做对却无效**的缺口（静默失效比功能缺失更伤信任）。
- **003 排第三**：影响面广但不丢数据、有 workaround（重开窗口）。
- **004 排第四**：面向维护者，但它是**唯一能防止历史事故复发**的手段。

## 依赖关系

```
002 (PiTrust + scope 枚举)
 ├──→ 001.T011  项目级 MCP 停用的信任判定
 └──→ 001 的 scope 字段与 002 共用

001 ── 独立可交付
003 ── 独立可交付（仅前端）
004 ── 独立可交付（仅宿主测试）
005 ── 独立可交付（Kotlin QueueService + web 队列条 + mock 重写）
```

**建议执行顺序**：`002 → 001 → 003 → 004`

理由：002 定义的 `scope` 与 `PiTrust` 是 001 的输入；003 与 004 与前三者无耦合，
可在任意空档穿插（004 的 T014–T017 纯函数部分甚至可以先做，成本最低）。

## 交付规模

| Feature | Tasks | 状态 | 主要触及 |
|---|---|---|---|
| 001 | 26 | **已实现（26/26，真机验证含）** | `PiManage.kt`、新增 `PiMcpConfig.kt`、4 个 manage 面板 |
| 002 | 24 | **已实现（23/24）** | 新增 `PiTrust.kt`、`skillsList` 签名变更、ManageView 横幅 |
| 003 | 24 | **已实现（23/24）** | 新增 `store/sources.ts`、`store.ts` 局部重构、新增诊断面板 |
| 004 | 23 | 待开工 | `build.gradle.kts`、3 个新测试类、新增 `SMOKE_TEST.md` |
| 005 | 31 | **已实现（31/31，真机复验含）** | 新增 `queue/PiMessageQueue.kt`、`QueueBar.tsx`、`queue.*` 桥接与 mock 重写 |
| **合计** | **128** | — | — |

002 的验收结果见 [其 tasks.md 的「实现记录」](./002-project-trust/tasks.md#实现记录2026-11-02)：
`./gradlew test` 与 `npx playwright test`（55 passed）全绿，仅 T024 真机目视未做。

## 未纳入本批（需单独决策，不适合写成 feature）

| 事项 | 为什么不在本批 |
|---|---|
| **Marketplace 上架审核** | 需要用户的 JetBrains Account 令牌与人工提交，不是代码工作。配置已就绪（`publishPlugin`、token 环境变量、channels） |
| **真机人工回归（Phase 7/8 欠账）** | 属于流程执行而非功能实现。004 的 `SMOKE_TEST.md` 会把它固化成可执行清单 |
| **pi TUI 的全功能复刻（`/tree` 等）** | 产品 Non-goals 明确不做 |
| **插件内表单式编辑 `models.json`** | 会与 pi 的 schema 演进强耦合，001 采用「打开文件」而非自建编辑器 |

## 下一步

```
/speckit.plan 或 /speckit.tasks 已产出，可直接 /speckit.implement 001
```

每份 `tasks.md` 的 task 都自带「— 验证：…」，满足宪法第 II 条（无断言覆盖不得标记完成）。

---

# 0.5.2 批次（2026-11-04）

> 版本分支：`release/0.5.2`（已从 main 拉出，`version` 已 +1 patch）
> 约束基准不变：[`.specify/memory/constitution.md`](../.specify/memory/constitution.md)
> 执行提示词：`specs/0.5.2-PROMPT.md`（**不入库**，`.gitignore` 按 `specs/*-PROMPT.md` 忽略；
> 属派发给外部执行代理的临时编排稿，只留本地）
> 执行记录模板：[`specs/0.5.2-run-report.md`](./0.5.2-run-report.md)

## 五个 Feature 与优先级

排序依据：**改动量小、风险低、依赖少者优先**（不是业务价值排序）。008 国际化排在最后，
因为它要扫过其余四个 feature 新增的全部文案，先做等于写两遍。

| 序 | Feature | 难度 | 主要内容 | 关键证据/风险 |
|---|---|---|---|---|
| 1 | [010 界面细节打磨](./010-ui-polish/spec.md) | 低（纯样式 + 一个 util） | 用户消息气泡紧凑、空态上下居中、输入框自适应高度 | ✅ **已完成**（15/17 task，真机 2 条待目视）；三条都由 `web/e2e/ui-polish.spec.ts` 几何断言锁死 |
| 2 | [007 消息级 Fork + 确认框](./007-message-fork/spec.md) | 中（一个协议验证 + 一个通用组件） | pi 消息工具条 Fork、底部 Fork 隐藏、统一应用内确认框 | ✅ **已完成**（20/21 task，真机 T020 待目视）；V1/V2 已对 pi 1.5.0 实测（`007-message-fork/fork-semantics.json`）：fork 截止到目标 entry 之前 → 中间回复取**下一条提问** fork、末条回复走 `clone`；方案 B 不需要 |
| 3 | [009 IDE 集成](./009-ide-integration/spec.md) | 中（Kotlin 侧 4 件事） | 右键分组图标、子菜单不再整片灰、添加目录到 pi、文件变更刷新 VFS | 「整片灰」根因需真机复核；VFS 刷新要防抖 + 让 `files.list` 缓存失效 |
| 4 | [006 会话导航与检索](./006-session-navigation/spec.md) | 中高（3 个 US + 一条新桥接） | 用户消息目录、会话内搜索、全会话搜索 | 新增 `sessions.search`；`Ctrl+F` 在 JCEF 里可能被 IDE 抢走 |
| 5 | [008 多语言](./008-i18n/spec.md) | 高（约 300 条文案 + 双端 + 引框架） | 跟随 IDE 语言、选择器随语言数自适应、Web + IDE 侧全覆盖 | 必须最后做；**引 `i18next`**（为后续加语言，理由见该 plan 的 D0）；复数分类用 `Intl.PluralRules` 校验；加语言不动组件由测试锁定 |

**依赖**：006 的「搜索结果定位」复用 010 的输入框高度与 007 的会话切换；007 的确认框被 006 的下一次改动沿用；
008 依赖前四个的最终文案。**顺序不可颠倒的部分只有一条：008 必须最后。**

## 相对 0.5.1 的范围变化

| 用户原条目 | 处理 | 原因 |
|---|---|---|
| 打开历史会话命令详情不能展开 | **移出** | 0.5.1 已修复（`2d644c4`），本版不复测 |
| 发送按钮右侧下拉 | **不做** | 用户尚未决定交互形态，见 010 的 Non-goals |
| 底部 Fork | **隐藏不删除** | 保留常量开关，后续可一行恢复（007 FR-006） |
| 全会话搜索范围 | 收敛为**当前项目** | 与 Sessions 列表同源；跨项目检索需要索引层，另立规格 |

## 每份 tasks.md 的完成判据

同 001–005：每个 task 自带「— 验证：…」，没有断言覆盖的改动不得标记完成；
真机项必须留截图或日志，写进 [`0.5.2-run-report.md`](./0.5.2-run-report.md)。

---

# 0.5.3 批次（2026-11-05）

> 版本分支：`release/0.5.3`（从 `main` 的 `v0.5.2` 拉出，`version` 已 +1 patch）
> 0.5.2 已发布：tag `v0.5.2`（提交 `edf7b05`）、商店 version id `1213020`。
> 首发（id 1213011）因兼容性问题被 Marketplace 清掉，已重发并补上 0.5.1 的四个热修。
> 执行记录模板：[`specs/0.5.3-run-report.md`](./0.5.3-run-report.md)
> 执行提示词：`specs/0.5.3-PROMPT.md`（**不入库**，`.gitignore` 按 `specs/*-PROMPT.md` 忽略）

本版只做 0.5.2 未开工的三个 feature，共 **66 个 task**。010 与 007 已在 0.5.2 完成并发布，不再进入本版。

| 序 | Feature | Tasks | 主要内容 | 关键证据/风险 |
|---|---|---|---|---|
| 1 | [009 IDE 集成](./009-ide-integration/spec.md) | 18 | 右键分组图标、子菜单不再整片灰、添加目录到 pi、文件变更刷新 VFS | T001「整片灰」根因须先真机复核再改代码；VFS 刷新要防抖 + 让 `files.list` 缓存失效 |
| 2 | [006 会话导航与检索](./006-session-navigation/spec.md) | 23 | 用户消息目录、会话内搜索、全会话搜索 | 新增 `sessions.search` 桥接（四处契约同步）；`Ctrl+F` 在 JCEF 里可能被 IDE 抢走，需备选键位 |
| 3 | [008 多语言](./008-i18n/spec.md) | 25 | 跟随 IDE 语言、语言选择器、Web + IDE 侧约 300 条文案 | 必须最后做；引 `i18next` + `react-i18next`（仅此两个）；T002 懒加载切不出 chunk 即停下报告 |

**顺序不可颠倒**：`009 → 006 → 008`。008 依赖前两个 feature 的最终文案。

## 0.5.2 结转的三条真机目视项

上一版无 IDE 实例，以下三条只有自动化判据、缺人工目视，随本版真机回归一并补：

| 来源 | 项 | 判据 |
|---|---|---|
| 010 T006 / T016 | 输入框自适应在真机 JCEF 下的手感与输入法行为 | `MANUAL_TEST.md`「界面密度」第 3、7、8 条 |
| 007 T020 | 消息级 Fork 与确认框的真机表现 | `MANUAL_TEST.md`「Fork 与确认框」全段 |

---

# 0.5.4 批次（2026-11-07）

> 版本分支：`release/0.5.4`（从 `main` 拉出，版本号已 +1 patch；已含右键菜单 `%key` 修复 `3bdfb71`）
> 约束基准同前：`.specify/memory/constitution.md`（machine-local、当前工作机缺失，沿用本文件记载的第 II / III 条与 010 的量化断言约定）
> 执行记录：[`specs/0.5.4-run-report.md`](./0.5.4-run-report.md)（已定稿：四件套全绿、两轮 e2e、取证结论与基线变化明细）

**缺陷修复同样按 feature 三段式交付**：与 010-ui-polish（三条 UI 缺陷合一）一致，feature 指「一批可独立交付、可独立验证的变更」，不区分新增与修复。目录命名 `defects` 而非业务名，spec 内用「现象 → 根因 → 期望行为 → 回归场景」结构，不硬套业务价值叙事。

| Feature | Tasks | 内容 | 来源 / 风险 |
|---|---|---|---|
| [011 0.5.4 缺陷批次](./011-0.5.4-defects/spec.md) | 28（✅ 已实现，2026-11-07） | 模型选择器（打开定位 / 供应商分组 / 点外部关闭）、skill 引用只显示标记、更新 pi 回显中文乱码 | T001–T023 已全部实现并测试；Q1–Q4 全部关闭；T002（Windows 截图）与 T025 真机目视留待 Windows 真机 |

## 五条缺陷的映射

| 用户原条目 | 回归主题 | 代码定位 | 用户已定的口径 |
|---|---|---|---|
| 弹出自动滚动到选中项？考虑性能影响 | US1 | `ModelPicker.tsx:23-29,44-47` | 打开时定位并同步高亮；已可见不滚；只在打开时读一次布局；**不引虚拟列表**，保留 200 条上限 |
| 按供应商分组 | US2 | `ModelPicker.tsx:106-127`、`types.ts:98-104` | 组标题 + 计数，当前组置顶，组内保持 pi 原序，跨组键盘索引不错位 |
| 选模型弹窗点外部不关闭 | US3 | `ModelPicker.tsx:14,64,95-96`；参考 `OptionsPopover.tsx:62-78` | 点外部 / Esc 都关；rootRef 必须包住 chip，避免「先关后开」 |
| 引用 skill 把内容打印到会话 | US4 | `Composer.tsx:369-372`、`MessageList.tsx:13-15` | 只显示 `/skill:name` 标记 + 用户问题；全文不进气泡，也不进 Copy/Quote |
| 更新 pi 结果回显乱码 | US5 | `PiCliRunner.kt:140-149`、`PiManage.kt:373,517`、`ManageView.tsx:58-64` | **Windows 特有，根因已确证**：DOS/OEM 本地代码页输出（中文 Windows 为 CP936/GBK）vs JVM 默认 UTF-8。用户补充「检测 pi 时也有类似乱码」对应历史提交 `b2d32b2`（`where` 输出按本地代码页解码），它引入的 `OsProcess.decodeOutput` 已修好 `PiLocator.runCapture`，**`PiCliRunner.drainThread` 是唯一漏网的读入点**；`PiEnvironment.toolVersion` 同走该链路，一并回归。修法：按字节读 + 严格 UTF-8 → 回退 `native.encoding`，附带清 ANSI 与安全截断 |

## 顺序与依赖

```
Phase 0 真机取证：T001 抓 skill 报文 ──阻塞──► Phase 2 skill（US4）
                  T002 Windows 验收证据 / T003 模型规模 ── 不阻塞实现
Phase 1 模型选择器（US1–US3，纯前端、无依赖、可先做）
Phase 3 CLI 输出解码（D5 根因已确证，可先做；仍建议放最后做全局回归）
   drainThread 是全局读入层，一次回归全部 manage.* 命令与 setup 检测链路
Phase 4 收尾：全量测试 / MANUAL_TEST / CHANGELOG / 真机目视
```

## 待用户关闭的开放问题

`spec.md` 末尾列了 Q1–Q4。**Q1 已关闭（2026-11-07 用户补充）**：乱码是 Windows 下 DOS/OEM 代码页输出与 JVM 默认 UTF-8 不匹配，与 `b2d32b2` 修过的 setup 检测是同一根因，实现方案不再靠样例猜测；T002 降级为 Windows 真机验收证据。剩余待用户补：Q2 pi 展开 skill 的原始报文（**唯一仍阻塞 Phase 2 开工**）、Q3 真实模型数量与 provider 大小写、Q4 点工具窗**外部**是否也要关闭弹窗（JCEF 内 document 收不到工具窗外点击，默认不做）。

## 完成判据

同 001–010：每个 task 自带「— 验证：…」；几何/行为断言必须量化，不得只断言存在；
真机项留截图或日志；全量基线为 0.5.3 的 `typecheck 0 错误` / `vitest 165` / `playwright 176` / `gradlew test ✅`。

---

## 0.5.4 需求批次（012，2026-11-07 追加）

> 与 011 **并列的第二个 feature**：011 是 5 条缺陷回归，012 是 7 条新增功能，两批可分别交付、分别派工。
> 目录 [`012-0.5.4-features/`](./012-0.5.4-features/spec.md)，同样三段式（spec / plan / tasks），共 **45 个 task**。
> **编号从 101 起**（`FR-101…` / `T101…`），避免与同批次 011 的 `FR-001…` / `T001…` 混淆；派工提示词须显式写「012 的 T1xx」。
> **本批次只产出文档，不改任何源码**（用户 2026-11-07 明确要求），实现阶段另行派工。

| Feature | Tasks | 内容 | 状态 |
|---|---|---|---|
| [012 0.5.4 需求批次](./012-0.5.4-features/spec.md) | 45（✅ 已实现，2026-11-07） | 会话标题、按钮提示、AGENTS.md、安装独占引导、provider 配置引导、auth 管理、图片预览 | T101–T140 已全部实现并测试；Q1–Q8 全部关闭（Q1/Q2/Q3 由真机取证关闭，其余按默认口径） |

### 七条需求的映射

| 用户原条目 | US | 代码定位（已核对） | 用户已定的口径 |
|---|---|---|---|
| 会话标题自动重命名与手动重命名 | US1 | `store.ts:1319-1332` `renameSession` 已实现；`:730-732` 事件只更新 `sessionName`；`SessionsView.tsx:150-198` 无 UI 入口；`PiSessionIndex.kt:93-94` 读 jsonl `session_info.name` | **pi 自动生成，插件只接管**：补事件→列表同步 + 列表行内/状态栏双入口手动改名；**不额外调模型生成标题**；pi 无自动命名则降级「首条消息截断」 |
| 按钮悬浮文字提示 | US2 | 约 65 处原生 `title/aria-label`，**0 个 tooltip 组件**；`styles.css:2795-2805` 窄布局藏文字；`ManageView`(9/0)、`PackagesPanel`(4/0)、`SettingsPanel`(2/0) 等缺提示 | **自定义 Tooltip 组件**：视口翻转/夹取、hover+focus、i18n、不吞点击；顺带把 manage 面板硬编码英文收进字典 |
| Pi 的 AGENTS.md 管理 | US3 | **全仓库 0 处提及**；可复用 `PiManage.kt:208-224`（写模板）、`BridgeService.kt:660-673`（IDE 编辑器打开）、`PiCliRunner.agentDir()` | **多层级列表 + 全局**：项目根 / 子目录 / 全局三层，逐项查看/编辑/新建 + 优先级说明；扫描有界、内容交给 IDE 编辑器；**层级定义以 T102 实测为准** |
| 引导用户安装，不显示其他界面、不允许切换关闭、但可停止安装 | US4 | `App.tsx:74-138` 无条件渲染 tab 栏；`SetupCard.tsx:136,142` 可「稍后」关掉且**自己调 `envDetect`**；`PiEnvironment.kt:220` `needsSetup=install==null` | **初次检测到缺 pi 就全程独占**：App 层只渲染引导子树，tabs/chat/sessions/manage/statusbar/composer **全部不挂载**；移除「稍后」与切页入口；保留「停止安装」（停止后仍在引导页，可重试或填已有 pi 路径）；JCEF 拦不住 IDE 侧关工具窗 → Non-goal |
| 引导用户配置 provider | US5 | `SetupCard.tsx:71-102` 装完直接结束；`PiManage.kt:257-286` `authOverview`；凭据**写入通道目前不存在** | 与 US6 **一条链路**：装完进入配置步骤，**可跳过**；两处共用同一表单 / `manage.*` API / 文案；凭据明文不过桥 |
| 配置里增加 auth（provider 管理） | US6 | **已有 auth 页签**（`ManageView.tsx:20,356` → `AuthPanel.tsx`）但只读且硬编码英文；`PiManage.kt:410-463` 已有 `sanitize` | 从只读升级为**新增/编辑/删除**，删除走 007 确认框；保留 Refresh/Check/展开/打开文件零回归；⚠️ `specs/README.md`「未纳入本批」曾有「不做表单式编辑 models.json」的历史决策，默认折中不推翻，**是否推翻见 Q3** |
| 图片预览点击弹出模态框预览 | US7 | `MessageList.tsx:17-20` inline `<img>` 无交互；`types.ts:11-12,226-236` 两种 image 数据形态；`ConfirmDialog.tsx` 可作模态框样板 | **四项全做**：单图放大 + Esc/遮罩关闭、多图 ←/→ 切换、缩放与拖拽、另存为/复制图片。⚠️ `clipboard.ts:1-10` 确认 JCEF 无 async clipboard API，**复制/另存必须新增 Kotlin 桥接**，失败不得假装成功 |

### 关键既有事实（写进 plan 的三处）

1. **自动命名的真实漏点**：`session_info_changed` 只改 `sessionName`，`refreshSessions()` 只在 `setTab("sessions")`（`store.ts:798`）等少数时机调用 → 会话列表标题滞后到下次切页。US1 是补同步，不是重写标题生成。
2. **`needsSetup` 只是 SetupCard 的局部 state**，App 拿不到 → 独占必须把检测上提为 store 里唯一的 `setupGate`，并处理「检测失败不锁死主界面」的安全兜底。
3. **新增桥接必须四处同步**：`bridge/types.ts` → `manage.ts`/调用方 → `BridgeService.kt:125-151` → `bridge/mock.ts`；本批预计新增 `manage.agents*` / `manage.auth*` / `ide.saveImage` / `ide.copyImage`。

### 顺序与依赖

```
Phase 0 取证：T101 ──阻塞──► Phase 1 会话标题
             T102 ──阻塞──► Phase 3 AGENTS.md
             T103 ──阻塞──► Phase 5 provider 链路
             T104 按钮基线 ── 非阻塞
Phase 2 tooltip（纯前端）── 可先行
Phase 4 安装独占（改 App 门控，影响 e2e 隐含前提）── 建议早做
Phase 6 图片：UI 骨架可先行，另存/复制依赖 Kotlin 桥接，可与 Phase 3/5 合并落地
Phase 7 收尾：i18n / 全基线 / MANUAL_TEST / 真机目视
```

不可颠倒的只有两条：三项取证各自卡对应 Phase；`App` 门控早于 e2e 基线核对。

### 待用户关闭的开放问题

`012/spec.md` 末尾列了 Q1–Q8。**Q1–Q3 为阻塞项**（pi 是否真有自动标题、AGENTS.md 的实测加载层级与优先级、provider 凭据写入通道 + 是否推翻「不做表单式编辑 models.json」的历史决策）。Q4–Q8 已有默认口径：多图范围=当前会话、停止安装后保持独占、复制/另存的 IDE 权限边界、tooltip 覆盖动态按钮、跳过引导是否持久化；执行时按默认实现并逐条标注结论即可。

### 完成判据（在 0.5.4 通用判据之上）

- 每个 task 自带「— 验证：…」；新增可见文案双份字典；新增桥接四处同步。
- 独占态一律用 `toHaveCount(0)` 断言「不渲染」，不用 `not.toBeVisible()`。
- `setup.spec.ts` 7 条按新语义改写后全绿，其余默认 `needsSetup=false` 的 e2e 零回归；基线变化逐条注明「非回归」。
- 凭据明文在 DOM / 日志 / bridge 响应 / 测试快照中零出现；图片复制与另存失败必须可见。

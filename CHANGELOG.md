# Changelog

## Unreleased (0.4.0)

**工具调用审批**（随插件内置 pi 扩展，经 extension_ui 通路在 IDE 内批准/拒绝）
与基础体验补全（自动压缩/自动重试开关、上下文用量进度条、CI 加厚）。

### 新增
- **工具调用审批**：pi 本体无权限系统，插件现在内置 `pi-approve` 扩展
  （`pi --extension` 加载，不影响终端 pi）：read-only 工具（按工具自带
  `readOnlyHint`/`destructiveHint` annotations 判定）直接放行，改动/命令类
  工具在聊天流中弹出审批卡片（工具名 + 参数摘要），**Allow / Deny**；
  拒绝以错误结果返回给模型；5 分钟无响应自动拒绝；无 UI 场景 fail-closed。
  ⚙ Options 菜单一键切 **Ask / Yolo**（策略文件每次 tool_call 重读，无需
  重启 pi）
- **⚙ Options 弹层**（底部工具栏）：自动压缩（`set_auto_compaction`）、
  自动重试（`set_auto_retry`，跨重启持久化）、工具审批模式，三开关集中管理
- 状态栏 **ctx 进度条**（绿 → 70% 琥珀 → 90% 红），不再只有干巴巴的百分比
- CI：`verifyPlugin`（Marketplace 拒收标准检查）进 Linux 腿；新增 `web` job
  （Vitest + Playwright chromium）

### 修复
- **编辑器右键菜单自首个版本起从未注册（重大修复）**：`<group>`/`<action>` 声明
  一直写在 `<extensions>` 内——插件描述符解析器会静默忽略该非法位置的动作，
  必须放在顶层 `<actions>` 节。v0.1.0–v0.4.0 的 Explain/Fix/Send Selection、
  Send File、Generate Commit Message 在真机上均不可见（真机验收被跳过所以
  一直没暴露）；已用内置电脑操作在 WebStorm 2026.2 上自动验证注册成功

### 实现
- `process/PiApprovalSupport`：扩展每次启动从插件资源解压到
  `<IDE config>/pi-agent/`（升级即生效），策略 JSON 读写
- 桥接新方法：`approval.getPolicy` / `approval.setPolicy`、
  `config.getPrefs` / `config.setPrefs`
- 前端：`extension_ui_request` 解析（`approvalFromEvent` 纯函数）→ 审批卡片
  → `extension_ui_response`；`agent_settled`/abort 清空过期卡片；
  fire-and-forget 方法（notify/setStatus/…）忽略
- Mock：mock-pi.mjs（`MOCK_PI_APPROVAL=1`）与 MockBridge（`?approval=1`）
  脚本化审批轮次，前端 e2e 全覆盖

### 测试
- Vitest 23（+4 审批解析）、Playwright 24（+3 审批 e2e：批准/拒绝/yolo）

## 0.3.1 — 2026-11-01

VCS 集成：用 Pi 生成 Commit Message（不进聊天会话），加验证收尾修复。
（0.3.0 未单独发布，其内容随本版本一同发出。）

### 新增
- **VCS 集成：用 Pi 生成 Commit Message**（提交工具窗 + 模态提交对话框）：
  提交面板「Generate Commit Message with Pi」（Alt+Shift+C）把**已勾选变更的
  unified diff**（`IdeaTextPatchBuilder` 构建、96KB 截断、二进制文件降级为注释行）
  交给一次性无头 pi（`pi --print --no-session --no-tools --no-mcp -ne -ns -np -nc`，
  prompt 经 stdin 管道传入，300s 超时），要求 Conventional Commits 格式，
  结果清洗代码围栏后写入提交信息框；不进聊天会话、不改 agent 上下文；
  失败（pi 缺失/超时/空输出）走「Pi Agent」通知
- PiCliRunner 支持 stdin 管道（写入线程 + 超时关闭，超时按进程树清理）

### 修复
- CLI 子进程超时清理整个进程树：shell 可能 fork（而非 exec）尾部命令，
  只强杀直接子进程会留下持有 stdout 管道的孤儿孙进程，排水线程在 Linux 上
  等不到 EOF；现在连同 `ProcessHandle.descendants()` 一起清理，管道闭合、
  读线程正常退出
- **思考等级选择器改为自定义弹层**：原生 select 弹层会被工具窗边缘裁剪，
  靠近窗口底部时改为向上弹开
- **verifyPlugin 真正跑起来且通过**：补 `pluginVerification.ides`（此前
  "No IDEs Found" 直接失败）；`PiAgentToolWindowFactory` 改为 Java 实现 ——
  Kotlin 实现带默认方法的 `ToolWindowFactory`（上游以 jvm-default=all 编译）
  会生成 getIcon/getAnchor/manage 转发器，被 verifier 计为 6 处 @Internal API
  用法（verifier 的 ignore 机制只覆盖 problem 不覆盖 usage，无法豁免）；
  转为 Java 后继承接口默认值，verifier 结果从 "6 internal API" 降到 0

### 测试
- Commit Message 生成 8 例单测：unified diff 拼装（修改/新增/删除/行数推导/
  截断/二进制）、prompt、回复清洗
- 测试执行器超时路径关闭进程流、静默进程用例在测试体内销毁进程，
  修掉 ThreadLeakTracker 顺序导致的线程泄漏误报

## 0.3.0 — 2026-11-01

跨平台：源码 / 构建 / 运行全面兼容 macOS、Windows 与 Linux（含 WSL 边界说明）；
环境约束对标 cc gui 重定；设置页与会话生命周期补全。

### 破坏性变更（环境约束）
- **支持区间改为 2023.3–2026.3**（`sinceBuild=233` / `untilBuild=263.*`，
  对标 cc gui），不再只支持 2026.2
- **编译目标固定为远程 IntelliJ IDEA Community 2024.3.1**（最低支持线）——
  每次构建都在最低线上验证全区间二进制兼容；`ideaPath` 属性仅用于把
  runIde/e2e 指向本地真实 IDE，构建不再依赖本地安装的 IDEA
- 工具链对齐：bytecode 17（原 21）、Gradle 8.14.4（原 9.8.2）、
  IPG 2.10.5（原 2.19.0）；接入 `pluginVerifier`（COMPATIBILITY_PROBLEMS +
  INTERNAL_API_USAGES，对齐 Marketplace 拒收标准）
- JCEF 依赖改为 optional depends（2026.2+ 走模块，2023.3–2026.1 走平台类路径），
  插件在无 JCEF 模块的旧版上也能加载

### 修复
- **Windows 上无法定位/启动 pi**：PiLocator 支持 `where pi` 与 Windows 候选路径
  （`%APPDATA%\npm\pi.cmd`、scoop、chocolatey）、`node.exe` 解析；`.cmd` shim
  经 `cmd /c` 启动；子进程 PATH 用平台分隔符拼接（原先固定 `:`，Windows 必坏）
- 构建脚本两处 macOS 专属问题：`ensureWebUiDeps` 的 inputs 相对路径解析到
  项目根目录（应为 `web/`）；npm 硬编码 `/bin/zsh -lic`（Linux 无 zsh 即挂）→
  按存在性挑 shell（`$SHELL` → zsh → bash → sh）
- 测试在 Windows 硬失败/整组跳过：PiCliRunnerTest 换用跨平台子进程命令，
  PiRpcClientTest 的 node 探测支持 Windows，kotlin test 显式钉 JUnit5 变体
  （Gradle 8.14 下默认解析到 JUnit4 会崩 worker）—— 全部用例在 Windows 真实执行
- Windows 下会话列表静默为空：cwd 匹配前做分隔符/大小写归一化
- Markdown 文件链接识别 Windows 路径（`C:\...`、`C:/...`、`~/...`），
  `~\` 开头路径在 IDE 侧正确展开

### 新增
- **设置页**（Settings → Tools → Pi Agent）：自定义 pi 路径（发现失败时的
  图形化逃生门，保存后自动重启运行中的 pi）+ 项目启动自动打开工具窗开关
- **会话生命周期补全**：会话列表显示消息数；行内操作 克隆 / 导出 HTML /
  删除（根目录校验防误删）；聊天工具栏 **Fork**（从最后一条 user 消息分叉）；
  会话导出为免脚本内联样式的独立 HTML 文件
- `Explain File with Pi` 动作接入右键菜单（已实现但从未注册）
- CI：GitHub Actions 三系统矩阵（ubuntu/windows/macos）跑 `build` + `test`
- Windows IDE-e2e 脚本 `scripts/e2e-ide.ps1`（mock / `-Real` 均可）；
  e2e-ide*.sh 的 JAVA_HOME 探测支持 Linux；node-env.sh 不再钉死 Node 版本
- mock（web MockBridge 与 test/mock-pi.mjs）补 `fork`/`clone`/
  `export_html`/`switch_session`，会话链路可被 e2e 全覆盖

## 0.2.1 — 2026-10-31

编辑器/文件整合深化：文件右键发送、原生 Diff 视图、路径点击回显。

### 新增
- **项目文件树 / 编辑器标签页右键 → Pi Agent → Send File to Pi Agent**：
  整个文件（带路径上下文）发送给 pi（二进制 / 超过 256KB 自动置灰）
- **pi 修改的文件 → 原生 JetBrains Diff 窗口**：pi 开始改文件时自动捕获
  "改前"基线，工具卡片的 **Diff** 按钮用平台 DiffManager 弹出 Before/After
  对比窗口；无基线时回退 git HEAD 版本，仍无则直接打开文件
  （新 bridge 方法 `ide.showFileDiff`）
- 工具卡片的**文件路径可点击**（edit/write/bash 等带 path 参数的工具），
  点击直接在编辑器打开

### 兼容性
- 全程只依赖 platform + JCEF 模块（无 IDEA 专属 API），编辑器动作、
  文件动作、Diff 窗口在全部 JetBrains IDE（WebStorm/PyCharm/GoLand/…，262.*）
  通用

### 测试
- Playwright e2e 19 例（新增 edit 卡片文件链接 + Diff 按钮用例）
- 全量：Kotlin 31、Vitest 19、Playwright 19 全绿

## 0.2.0 — 2026-10-31

IDE 深度集成与体验打磨：编辑器动作、通知、状态栏、多窗口隔离、渲染完整性。

### 新增
- **编辑器动作**：右键 **Pi Agent** 菜单（选中代码时可用）
  — *Explain with Pi* / *Fix with Pi* / *Send Selection to Pi*，自动携带
  `file:line` 与选区上下文注入输入框（可编辑后发送），并激活工具窗
- **后台完成通知**：任务结束时若工具窗不可见，弹气泡通知，点击直达工具窗
- **状态栏 widget**：π 徽标显示 pi 状态（运行中=版本、崩溃=⚠），点击打开工具窗
- **file:line 跳转**：消息里的 `path/file.ext:12` 引用可点击，直接打开编辑器对应行
- **diff 视图**：edit / write 工具调用显示红绿增删行（write 为全新增），
  超 500 行折叠
- **图片回显**：发送的图片在自己的消息气泡与会话回放中显示（缩略图）
- **@ 文件引用补全**：输入 `@` 弹出项目文件浮层（关键词过滤、↑↓/Enter 选择）
- **拖拽图片**：拖入图片文件与粘贴等效
- **代码块 Copy 按钮**：一键复制代码，✓ 反馈
- markdown 链接一律用**系统浏览器**打开（JCEF 拦截导航，不再劫持工具窗）
- React **ErrorBoundary**：前端渲染异常显示错误 + Reload，不再白屏
- **多窗口完全隔离**：每个项目窗口独立 token、独立事件流、独立 pi 进程，
  不再串话；新 bridge 方法 `files.list` / `ide.openFile`，新事件 `ide`

### 修复
- 断连期间长轮询缓冲溢出丢事件无感知：poll 响应带 `oldest` 序号，
  前端检测缺口立即补救（`isStreaming` 不再因此卡死）
- `ensureWired` 并发竞态可重复注册事件监听（加锁）
- 流式进行中切换会话先 abort 再切换
- 斜杠菜单打开时 Escape 只关菜单不清空已输入文本；图片读取失败不再产生
  unhandled rejection
- 管理命令尊重 pi 的 `PI_CODING_AGENT_DIR` 自定义安装目录（此前仅 sessions
  目录尊重环境变量）；登录 shell PATH 探测加 60s 缓存（每条管理命令不再
  重复 spawn 一次 zsh）
- 桥日志不再记录信封内容（可能含用户代码），只记长度

### 测试
- Kotlin 31 例（含 RPC 超时、CLI 大输出、桥鉴权等）
- Vitest 19 例（新增图片块双形状解析、乐观图片去重保留）
- Playwright e2e 18 例（新增 @ 补全、Copy、diff 视图、file:line 链接等 6 例）
- verifyPlugin 通过（含新增 notificationGroup / statusBarWidgetFactory /
  编辑器 action 注册）

## 0.1.2 — 2026-10-31

稳定性热修：资源泄漏、挂死、管道死锁与本地桥安全加固。

### 修复
- **JCEF browser 资源泄漏**：面板未挂入 Disposer 树导致 `dispose()` 永不执行，
  反复开关工具窗会累积 Chromium 实例（现随 content 释放）
- **RPC 请求无超时可能永久挂死**：`pi` 不回包时请求协程与前端双双挂住；
  现在默认 120s 超时（`rpc.request` 可用 `timeoutMs` 覆盖），超时后清理
  pending 表项，迟到响应不会完成已被放弃的请求
- **PiCliRunner 管道死锁**：原先先 `waitFor` 再读输出，子进程输出超过
  ~64KB 管道缓冲时永远无法退出 → 必然超时误报失败（`packageInstall`
  尤其容易触发）；现在并发排水 stdout/stderr，超时路径保留部分输出
- **管理命令不再占用 Default 协程池**：阻塞型 CLI 调用改走 `Dispatchers.IO`

### 安全
- **本地 HTTP 桥加鉴权**：`/bridge` 与 `/bridge/poll` 现在要求随机 token
  （启动时生成，经加载 URL 交给前端）+ 同源 Origin 校验（拦截网页对
  loopback 的 CSRF）；`/bridge/health` 保持开放（无副作用）
- POST /bridge 请求体上限 16MB（防异常请求打爆内存）
- 桥日志不再记录信封内容（可能含用户对话文本），只记长度

### 测试
- Kotlin 31 例（+14）：RPC 超时两条、CLI 大输出/超时/非零退出四条、
  桥鉴权五条、token 生成一条等
- Vitest 收集排除 Playwright spec（此前 `npm test` 误收 e2e 文件报红）
- 全量：Kotlin 31、Vitest 17、Playwright e2e 12 全绿

## 0.1.1 — 2026-10-31

真实 pi 可用性修复与交互打磨。

### 修复
- **GUI 启动的 IDE 中 pi 无法启动（核心修复）**：pi 是 node 脚本，IDE 子进程 PATH
  缺 node 导致 `env: node: No such file or directory` 秒退。现在自动从 pi 的
  安装布局解析 node 解释器并直接以 `[node, pi]` 启动，同时把 node 目录注入
  子进程 PATH（pi 的 MCP 服务器也需要）
- 模型选择器对带 `/` 的模型 ID（如 `openrouter/free`）解析错误
- 真实 pi 的用户消息重复渲染（`message_start` 空 content 去重）
- 上下文占用百分比显示浮点数
- 进程启动不再禁用扩展（`--no-extensions` 移除，MCP/扩展恢复可用）

### 新增
- 模型选择持久化：切换模型后下次启动自动恢复（`--provider/--model`）
- provider 错误可视化：401/404/5xx 直接显示为错误条目，不再静默卡住
- pi 进程崩溃横幅带 **↻ Restart** 一键重启
- **Send 分体按钮**：Steer / Follow-up 队列模式移到按钮下拉上，
  不可用时置灰而非隐藏；运行中 Enter 仍按所选模式排队
- 模型/思考等级选择移至底部工具栏；模型选择器带检索框（空格 = AND 多关键词）

### 测试
- 前端 e2e 12 例、Vitest 18 例、Kotlin 17 例全绿
- 新增真实 pi 全链路 e2e（openrouter/free，`scripts/e2e-ide-real.sh`）

## 0.1.0 — 2026-10-30

首个可用版本（M1–M3 里程碑 + 真机验证）。

### Chat
- `pi --mode rpc` 子进程会话（每项目一个，随项目关闭终止，崩溃展示 stderr 与恢复路径）
- 流式 markdown 回复（marked + DOMPurify + highlight.js，明暗主题跟随 IDE）
- thinking 折叠块、工具调用卡片（参数摘要/可展开输出/耗时/错误标记）
- 运行中 steer / follow-up 排队（含 queue_update 同步与排队提示）
- 自动重试倒计时、compaction 事件条目、手动 Compact
- 斜杠命令补全（扩展命令 / prompt 模板 / skills）
- 图片发送（粘贴或文件选择）
- 会话统计：上下文占用百分比、成本、消息数

### Sessions
- 按项目列出历史会话（解析 session header 的 cwd，兼容 pi 版本演进）
- 一键切换并回放完整历史；重命名当前会话；新建会话

### Manage
- MCP 服务器：列表、新增（stdio/HTTP）、删除、OAuth 登录/登出
- 扩展包：pi list / install / remove
- Skills：扫描三级目录、创建模板
- 认证：provider 汇总 + 逐个 `pi auth check`
- Settings：`~/.pi/agent/settings.json` 内嵌编辑（JSON 校验 + .bak 备份）
- 环境自检：pi 定位（登录 shell PATH）、版本显示、未安装引导

### 工程
- 三层自动化：Kotlin 单测/集成（14）、Vitest 归约器（10）、Playwright 前端 e2e（11）
- 真实 IDEA JCEF e2e：`scripts/e2e-ide.sh`（CDP :9222 + mock pi）
- `verifyPlugin` 通过；目标平台 IntelliJ IDEA 2026.2（262.*）

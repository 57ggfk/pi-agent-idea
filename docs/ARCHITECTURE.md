# Pi Agent for JetBrains —— 架构设计文档

> 版本：v1.1（2026-10-31，随 v0.2 更新：HTTP 桥 + per-project token、IDE 集成点）
> 关联：[PRODUCT_DESIGN.md](PRODUCT_DESIGN.md)、[TASK_PLAN.md](TASK_PLAN.md)

## 1. 总体架构

```
┌─────────────────────────── IntelliJ IDE ───────────────────────────┐
│                                                                    │
│  ┌─────────────── ToolWindow (PiAgentToolWindow) ────────────────┐ │
│  │  ┌──────────── JBCefBrowser (JCEF/Chromium) ────────────────┐ │ │
│  │  │  前端 SPA（React + TypeScript，插件资源内打包）              │ │ │
│  │  │  ChatView / SessionsView / ManageView                     │ │ │
│  │  │      ▲ POST /bridge + GET /bridge/poll（长轮询）           │ │ │
│  │  │      │ X-Pi-Token: <per-project token>                    │ │ │
│  │  └──────────┼──────────────────────────────────────────────┘ │ │
│  │             ▼                                                 │ │
│  │  ┌──────── LocalUiServer（loopback 随机端口，per-project token │ │ │
│  │  │           注册表路由到对应项目）───────────────────────────┐ │ │
│  │  │ BridgeService（per-project）：信封协议 → 分发              │ │ │
│  └──┴──────────────────────────┬──────────────────────────────────┘ │
│                                ▼                                     │
│  ┌────────────────── PiProcessManager (per-project) ───────────────┐ │
│  │  PiRpcClient: 进程管理 + 请求/事件路由                            │ │
│  │    │ stdin/stdout JSONL                                          │ │
│  └────┼─────────────────────────────────────────────────────────────┘ │
└───────┼───────────────────────────────────────────────────────────────┘
        ▼
  `pi --mode rpc` 子进程（pi 的全部能力：模型/工具/MCP/扩展/Skills）
```

分层原则：**前端只管呈现，Java 只管进程与协议，中间用单一 JSON 信封协议桥接**。前端不感知 Java API，Java 不解析业务 UI 状态。

## 2. 仓库与模块布局

```
pi-agent-idea/
├── docs/                     # 产品/架构/任务计划/测试文档
├── src/main/kotlin/dev/pi/agent/…   # 插件（Gradle 根工程）
│   ├── rpc/                  # 协议层：RPC 客户端、JSONL 分帧
│   ├── process/              # PiLocator / PiProcessManager：子进程生命周期
│   ├── bridge/               # BridgeService：前端 ⇄ Java 信封协议
│   ├── toolwindow/           # ToolWindow + JBCefBrowser 装配
│   └── ui/                   # LocalUiServer：前端资源 loopback HTTP 服务
├── src/main/resources/META-INF/plugin.xml
├── src/test/kotlin/…         # 单元测试（协议/集成）
├── web/                      # 前端工程（Vite + React + TS）
│   ├── src/…
│   └── e2e/                  # Playwright 前端 e2e（MockBridge）
├── test/
│   └── mock-pi/              # mock pi RPC 服务器（node），供 IDE e2e 与单测使用
├── scripts/                  # 开发/构建辅助脚本
├── build.gradle.kts / settings.gradle.kts / gradle wrapper (9.8.2)
└── README.md / CHANGELOG.md / LICENSE
```

前端 `web/` 独立成 npm 工程：`npm run build` 产出 `web/dist`，由 Gradle 任务复制进插件资源 `webui/`。这保证了**前端可以脱离 IDE 独立 serve**，是 e2e 测试与热开发的基础。

## 3. 协议层（Kotlin：`rpc/`）

### 3.1 RPC 客户端（`PiRpcClient`）

- 基于 `Process`（`pi --mode rpc [--session-dir …]`）的 stdin/stdout JSONL 通信。
- **分帧**：严格按 LF `\n` 分帧（容忍前导 CR）；**禁止**按 Unicode `U+2028/U+2029` 分隔（pi 文档明确警示，Java `BufferedReader.readLine()` 恰好有此问题 → 自实现 `LfLineReader` 只认 LF）。
- 读线程：独立 daemon 线程持续读取（防 stdout 背压阻塞子进程）；写线程锁串行化 stdin 写入。
- 请求关联：命令携带自增 `id`，按 `id` 关联 response（CompletableFuture，超时可配置）。
- 事件分发：非 response 记录按 `type` 分发到订阅者（`PiEventListener`），无阻塞。
- 生命周期：`start()` / `shutdown()`（关 stdin 触发优雅退出，5s 后强杀）/ 异常退出回调；断线后由上层决定重启。

### 3.2 消息模型（kotlinx.serialization）

- 协议本身宽容：请求用**类型化数据类**（编译期安全）；事件用 `JsonElement` 透传 + 少量常用字段解包（`type`、`toolCallId`、`contentIndex` 等）。原因：pi 事件面大且演进快（`assistantMessageEvent` 有 13 种子类型），全量建类型成本高、收益低；前端 TS 反而要做全量类型。
- 关键类型化对象：`RpcResponse`、`GetStateData`、`SessionStats`、`ModelInfo`、`AvailableCommand`。
- JSON 配置：`ignoreUnknownKeys = true`、`isLenient` 不开启（协议要求严格 JSON）。

### 3.3 消息重建（Java 侧只透传，重建在 TS）

`message_update` 的 delta 序列在前端按 `contentIndex` 聚合；`text_end/thinking_end/toolcall_end/message_end` 到达时用权威内容整体替换（pi 文档规定）。

## 4. 进程层（`process/`）

`PiProcessManager`（per-project `@Service`）：

- pi 定位（跨平台，`PiLocator`）：`PI_AGENT_EXECUTABLE` 环境变量 → Unix 登录
  shell PATH 探测（`$SHELL`/zsh/bash `-lic`，覆盖 nvm 等场景）或 Windows
  `where pi` → 常见候选路径（Unix：`~/.local/bin`、Homebrew 等；Windows：
  `%APPDATA%\npm\pi.cmd`、scoop、chocolatey）。`.cmd` shim 经 `cmd /c` 启动，
  node 脚本自动注入解释器（含 Windows `node.exe`）。解析结果含版本号
  （`pi --version`）。
- 启动参数：`pi --mode rpc`，可选 `--session-dir`、`--session <path>`、`--model`、`--provider`、`--no-session` 等；`cwd` = 项目根。
- **工具审批扩展**（v0.4.0）：随插件内置 `pi-approve.js`（资源 `pi-approve/`），每次启动解压到 `<IDE config>/pi-agent/` 并以 `--extension <path>` 加载——只影响插件拉起的 pi，不污染用户扩展目录；环境变量 `PI_APPROVE_POLICY` 指向策略 JSON `{version: 2, mode: yolo|ask, allow: []}`，扩展在每次 `tool_call` 时重读（`PiApprovalSupport`），切 ask/yolo 无需重启 pi。**默认 `yolo`（自动批准）**：工具窗口不该为每次编辑/命令弹确认；`ask` 由 ⚙ Options → Auto-approve tool calls 关掉开关启用。`version` 缺失的旧策略文件（v0.4.0 及以前默认 `ask`）在安装扩展时一次性迁移到新默认，迁移后用户的选择被尊重。扩展按工具自带 annotations（`readOnlyHint`/`destructiveHint`）决定放行或弹 `ctx.ui.confirm`，RPC 模式下确认框转成 `extension_ui_request` 事件走给前端。
- 环境变量：合并 IDE 环境与用户 PATH 修正（否则 GUI 启动的 IDE 常找不到 nvm 工具）。
- 健康管理：进程意外退出 → 广播 `processExited` 事件（含 exitCode/stderr 尾部）→ 前端显示可重试卡片；"重启会话" 动作重建进程并 `get_messages` 回放。
- 复用策略：ToolWindow 关闭不杀进程（后台继续跑任务，符合"agent 任务"预期）；项目关闭时终止。
- **项目信任**（v0.5.0，`process/PiTrust`）：pi 只在**受信任项目**里加载仓库内的 `.pi/`
  （skills / MCP / settings / 扩展），信任态存在 `~/.pi/agent/trust.json` —— 与终端里的
  pi 共用同一个文件。判定用 canonical path 归一化，**仅 Windows 小写化**（Linux/macOS
  大小写敏感，跟着小写会把 `/home/Foo` 与 `/home/foo` 并成一个项目）。写入顺序为
  「`.bak` 备份 → 只改目标键（同名但大小写/分隔符不同的键一并清掉）→ 重新解析校验 →
  临时文件 + `ATOMIC_MOVE`」；**解析失败一律拒绝写入**——写坏会让用户在*所有*项目上都
  用不了 pi，比「信任操作失败」严重得多。授权只对**下一次**启动追加 `--approve`
  （`PiStartArgs.build()` 纯函数 + 单次消费），运行中的进程绝不自动重启。

## 5. 桥接层（`bridge/` + `ui/LocalUiServer`）

单一信封协议，双向 JSON 字符串，经 **loopback HTTP** 传输（v0.1.0 起落地，弃用
JCEF JS 注入——时序不可靠）：

```
JS → Java : POST /bridge   { "t": "<method>", "id": "<reqId>", "p": {…params} }
Java → JS : GET /bridge/poll?cursor=N   （长轮询，25s 上限）
            { "t": "resp", "id": "<reqId>", "ok": true, "data": … }
            { "t": "event", "name": "<事件名>", "data": … }
```

- **鉴权**：LocalUiServer 启动即为每个打开的项目签发随机 token（32B base64url），
  经加载 URL 查询串交给 SPA；后续请求必须携带 `X-Pi-Token` 头。同时校验 Origin
  同源（拦截网页对 loopback 的 CSRF）。`/bridge/health` 无副作用，保持开放。
- **多项目隔离**：token → project 注册表；每个项目的 `BridgeService` 持有独立的
  `BridgeTransport` 事件缓冲（per-project，非全局单例），多窗口不会串话。
- **事件序列**：`BridgeTransport` 按 seq 排序缓冲（上限 2000 条）；poll 响应带
  `oldest`（缓冲区最旧 seq），前端据此检测断连期间丢事件并补救。
- 方法集：`rpc.request`（透传 RPC 命令，可带 `timeoutMs`）、`sessions.list`、
  `files.list`（@ 补全用，30s 缓存）、`ide.openFile`（编辑器跳转）、
  `config.*`、`manage.*`（auth/mcp/packages/skills/settings/updates/provider）、
  `trust.*`（get/grant/revoke，后两者要求 `confirmed:true`）、
  `queue.*`（get/enqueue/move/remove/restore/promote/pause/resume/clear，见 §7.1）、`env`。
  `manage.skillsList` 必须带 `project.basePath`——扫描基准是项目根，不是 IDE 进程的
  工作目录（多项目窗口下会串台），见 §7。
- 事件：`pi`（原始 pi 事件）、`pi-state`（进程状态）、`ide`（编辑器动作注入的
  prompt，如 Explain/Fix with Pi）、`queue`（队列全量快照，`queue_state`）。
- 编辑器动作（`editor/`）通过 `BridgeService.pushIdePrompt` 注入 prompt 并激活
  工具窗；后台运行结束时若工具窗不可见，发 BALLOON 通知（`notificationGroup`）。

## 6. 前端架构（`web/`）

- 技术栈：**React 18 + TypeScript + Vite**；markdown：`marked` + `dompurify`；高亮：`highlight.js`；状态：`zustand`（轻量、无样板）。
- 入口自省：`window.__piSend` 存在 → `JcefBridge`；否则 → `MockBridge`（内存假 pi，可脚本化场景），**同一套代码跑 IDE 与浏览器**。
- 状态模型（`usePiStore`）：
  - `connection`：进程状态、pi 版本、错误
  - `session`：state（模型/思考等级/isStreaming）、消息列表（`ChatItem[]`：UserItem | AssistantItem(text/thinking/toolcall 块) | ToolCardItem）、队列、stats
  - `ui`：当前页签、命令面板、模型选择器
- 事件归约器（`applyEvent`）：把 pi 事件流（`message_start/update/end`、`tool_execution_*`、`agent_*`、`queue_update`、`auto_retry_*`、`compaction_*`）归约为 `ChatItem[]` 的增量更新 —— **这是前端唯一的复杂逻辑，纯函数，单测覆盖**。
- **审批通路**（v0.4.0）：`extension_ui_request`（confirm/select/input/editor）在 store 层入队（`approvals`），`ApprovalCard` 渲染在 Composer 上方，用户点 Allow/Deny 回 `extension_ui_response`（confirm → `confirmed`，其余 → `cancelled`）；fire-and-forget 方法（notify/setStatus/…）解析为 null 忽略。`agent_settled`/abort 清空过期卡片。解析逻辑为纯函数 `approvalFromEvent`（单测覆盖）。
- 样式：手写 CSS（跟随 IDE 主题：Java 注入 `data-theme=light|dark` + CSS 变量，色值取自 IDE ThemeJson）。

## 7. 管理层（`manage/`）

对 pi CLI 子命令的安全包装（一律不带 shell，参数数组直传；用户输入不经过 shell 拼接）：

| 操作 | 实现 |
|---|---|
| 认证状态 | `pi auth check --provider X --json` |
| MCP 列表/增删/OAuth | `pi mcp list --json` / `pi mcp add …` / `pi mcp login`（超时保护） |
| 包安装/卸载/列表 | `pi install <src>` / `pi remove` / `pi list` |
| Skills 列表 | 文件系统扫描（`SKILL.md` frontmatter 解析）+ `scope` 标注：用户级扫 `~/.pi/agent/skills`，项目级扫 `<basePath>/.pi/skills` 与 `<basePath>/.agents/skills`（以 bridge 传入的项目根为基准，按 canonical `SKILL.md` 去重）；项目未受信任时条目仍列出但标「项目级 · 未生效」 |
| 设置/模型 | 直接读写 `~/.pi/agent/settings.json`、`models.json`（JSON 保留注释不做，pi 不支持注释） |
| 更新 | `pi update <src>` / `pi update --self`（300s 超时，stdout+stderr+退出码原样透传，不自行判断「有无更新」） |
| Provider 详情 | 反向白名单读 `models.json`：敏感键（apiKey/headers.Authorization 等）值替换为 `configured` 布尔，未知键全透传 |

写文件前先备份 `.bak`；所有管理操作完成后提示用户 `/reload` 或自动重启 RPC 进程使配置生效。

### 7.1 消息队列（`queue/`，spec 005）

**pi 是队列真源**：`queue_update` 事件携带完整 `steering`/`followUp` 文本数组，
`clear_queue` 可全量取出；两者都没有 id 与图片。`PiMessageQueue`（project 级、单线程
执行器）维护带 id/图片的镜像，与 pi 按**文本逐条相等**对齐——不一致即重建为无图条目并置
`drift`（镜像不可信时不猜）。规范序恒为 steer 段在前（本轮注入）+ followUp 段在后。

- 本地操作（move/remove/restore/promote）= 唯一原语 `clear_queue → 重建 → 重入队`，
  在执行器上原子完成；跨段移动视为边界（改不了 pi 的两个数组）。
- 暂停（abort / pi 重启 / 手动）= `clear_queue` 取出并留在镜像，**不做 reconcile**
  （abort 后 pi 侧行为文档与实测矛盾，镜像即幸存者）；暂停态下的操作只动镜像，
  恢复时按整理后顺序重入队。空闲恢复时首条走 `prompt` 直发——真机实测空闲的
  `follow_up` 永不自启（FR-013）。
- 运行态（空闲/流式）从 `agent_start`/`agent_settled` 事件跟踪：真机实测 get_state 在
  流式中**不含** `isStreaming`，不能问。
- 执行调度完全归 pi（`follow_up` 语义），插件**不在** `agent_settled` 后代发——双重调度
  正是重复执行的来源。失败的 steer 在镜像中保留 `failed` 条目与原始错误，对齐时只比对
  queued 条目。
- 前端 `queue.*` 走桥接方法，状态经 `queue` 事件全量快照推送；webview 重载后
  `queue.get` 从 Kotlin 镜像恢复。

## 8. 线程模型

| 层 | 线程 |
|---|---|
| RPC 读循环 | 专用 daemon 线程 `pi-rpc-reader-<n>` |
| RPC 请求 | 调用方上下文（协程，超时默认 120s） |
| 桥接 handler | LocalUiServer HTTP 线程 → 协程 `Dispatchers.IO`（管理命令可阻塞数分钟） |
| Swing/JCEF API 访问 | EDT（`invokeLater`） |
| 长轮询 | LocalUiServer cachedThreadPool daemon 线程（每请求最长 25s） |

实现采用 Kotlin coroutines（`intellij-platform` 附带 kotlin-stdlib；coroutines 库随平台提供）。

## 9. 错误处理与可观测性

- 三层错误：进程级（崩溃/找不到 pi/版本过旧）→ 协议级（response error、malformed）→ 业务级（provider 报错进入消息流）。分别映射为：引导卡片 / 错误响应 / 内联错误气泡。
- 日志：插件 logger（`idea.log`），RPC 全量原始记录可在 debug 级别开启（`dev.pi.agent:debug`），用于排查。
- 崩溃恢复：保留 stderr 尾部 2KB 展示给用户。

## 10. 测试架构

| 层 | 手段 | 位置 |
|---|---|---|
| 协议单测 | LfLineReader / 响应关联 / 事件解包（JUnit5） | `plugin/src/test` |
| 事件归约单测 | `applyEvent` 纯函数（Vitest） | `web/src` |
| 前端 e2e | Vite serve + MockBridge + **Playwright**：发消息→流式渲染→工具卡→中止→命令补全 | `web/e2e` |
| mock pi | Node 脚本实现 RPC 子集（可编排事件脚本），既喂 IDE e2e 也喂 MockBridge | `test/mock-pi` |
| IDE e2e | `runIde` 注入 `-Dide.browser.jcef.debug.port=9222` + `-Dpi.mock=true`（强制使用 mock pi）+ 环境变量 PATH 指向 mock 脚本；**Playwright `connectOverCDP`** 连接 JCEF，同套用例跑真实 JCEF | `scripts/e2e-ide.mjs` |
| 结构验证 | IntelliJ `verifyPlugin` | Gradle |
| 真机安装 | `buildPlugin` zip 解压到 `~/Library/Application Support/JetBrains/IntelliJIdea2026.2/plugins/` + `MANUAL_TEST.md` | 发布阶段 |

e2e 的关键设计：**同一套 Playwright 用例、两种 driver**（`file:web/e2e/drivers`：standalone / cdp），前端不感知差异。

## 11. 关键技术决策记录（ADR 摘要）

| # | 决策 | 备选 | 理由 |
|---|---|---|---|
| ADR-1 | 子进程 RPC（`pi --mode rpc`）而非 SDK（Node 进程内） | SDK、ACP | JVM 无法用 Node SDK；RPC 是 pi 官方给"IDE/自定义客户端"的推荐边界；ACP 需额外适配器且功能面窄 |
| ADR-2 | JCEF Web UI 而非 Swing | Swing | 对标 cc gui 的富文本/流式体验，Swing 实现 markdown 流式渲染成本过高 |
| ADR-3 | Kotlin + kotlinx.serialization | Java | 平台惯例、协程友好；协议宽容解析 |
| ADR-4 | 前端 React+Vite，独立 npm 工程 | WebPack/纯 HTML | 独立构建是 e2e 与开发效率的基础 |
| ADR-5 | 编译目标 = 最低支持线 IntelliJ IDEA Community 2024.3.1（远程），支持区间 233–263.\*（对标 cc gui）；`ideaPath` 属性仅用于把 runIde/e2e 指向本地真实 IDE | 依赖本地安装的特定版本 / 追最新版本 | 无 IDEA 的机器（CI/Linux）也能构建；每次构建都在最低线上验证全区间二进制兼容 |
| ADR-6 | bytecode 17 / Gradle 8.14.4 / IPG 2.10.5 | — | 与 cc gui 工具链对齐；JBR 17 覆盖 233–263 全区间 |

## 12. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 自定义 scheme 在 JCEF 兼容性问题 | 已备轻量本地 HTTP 服务方案（§5.1），切换对前端透明 |
| GUI 启动的 IDE 缺 nvm PATH | 登录 shell PATH 探测（Unix）/ `where` + 候选路径（Windows）+ `PI_AGENT_EXECUTABLE` 逃生门 |
| pi RPC 协议随版本演进 | 协议宽容解析 + 前端归约器单测 + `sinceBuild` 收紧 |
| JCEF 远程调试端口不可用（IDE 策略） | e2e 降级路径：前端 e2e + runIde 截图 + 人工清单 |
| 本地 HTTP 服务被其他进程访问 | 仅绑定 127.0.0.1 + 随机端口 + per-project 随机 token + Origin 同源校验（v0.1.2 落地） |

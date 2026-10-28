# Pi Agent for JetBrains —— 架构设计文档

> 版本：v1.0（2026-10-27）
> 关联：[PRODUCT_DESIGN.md](PRODUCT_DESIGN.md)、[TASK_PLAN.md](TASK_PLAN.md)

## 1. 总体架构

```
┌─────────────────────────── IntelliJ IDE ───────────────────────────┐
│                                                                    │
│  ┌─────────────── ToolWindow (PiAgentToolWindow) ────────────────┐ │
│  │  ┌──────────── JBCefBrowser (JCEF/Chromium) ────────────────┐ │ │
│  │  │  前端 SPA（React + TypeScript，插件资源内打包）              │ │ │
│  │  │  ChatView / SessionsView / ManageView                     │ │ │
│  │  │        ▲  window.__piEvent(json)     │                    │ │ │
│  │  │        │                             │ window.__piSend(s) │ │ │
│  │  └──────────┼─────────────────────────────┼───────────────────┘ │ │
│  │             │  Java→JS 事件推送            │ JS→Java 请求        │ │
│  │  ┌──────────┴─────────────────────────────▼───────────────────┐ │ │
│  │  │ BridgeService: JBCefJSQuery + executeJavaScript（JSON 信封）│ │ │
│  │  └──────────────────────────┬─────────────────────────────────┘ │ │
│  └─────────────────────────────┼────────────────────────────────────┘ │
│                                ▼                                     │
│  ┌────────────────── PiAgentService (per-project) ─────────────────┐ │
│  │  RpcSession: 进程管理 + 请求/事件路由 + UI 状态机                  │ │
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

- pi 定位：插件设置中的显式路径 → 登录 shell PATH 探测（`zsh -lc which pi`，覆盖 nvm 等场景）→ 常见候选路径。解析结果含版本号（`pi --version`）。
- 启动参数：`pi --mode rpc`，可选 `--session-dir`、`--session <path>`、`--model`、`--provider`、`--no-session` 等；`cwd` = 项目根。
- 环境变量：合并 IDE 环境与用户 PATH 修正（否则 GUI 启动的 IDE 常找不到 nvm 工具）。
- 健康管理：进程意外退出 → 广播 `processExited` 事件（含 exitCode/stderr 尾部）→ 前端显示可重试卡片；"重启会话" 动作重建进程并 `get_messages` 回放。
- 复用策略：ToolWindow 关闭不杀进程（后台继续跑任务，符合"agent 任务"预期）；项目关闭时终止。

## 5. 桥接层（`bridge/`）

单一信封协议，双向 JSON 字符串：

```
JS → Java : { "t": "<method>", "id": "<reqId>", "p": {…params} }
Java → JS : { "t": "resp", "id": "<reqId>", "ok": true, "data": … }
            { "t": "event", "name": "<事件名>", "data": … }
```

- JS→Java：`window.__piSend(jsonString)` 由 `JBCefJSQuery.create(handler)` 注册；handler 在 pooled 线程回调，方法实现**必须自行切到合适线程**（EDT 仅用于 Swing 访问）。
- Java→JS：`JBCefBrowser.cefBrowser.executeJavaScript("window.__piEvent(<json>)", …)`；JSON 以字符串字面量安全转义。
- 方法集（v1）：`rpc.command`（透传任意 RPC 命令）、`getState`、`listSessions`、`manage.*`（auth/mcp/packages/skills）、`ide.*`（打开文件、读主题）、`env`（项目路径、IDE 主题、版本）。
- 防抖：大流量事件（`message_update`）在 Java 侧按 16ms 窗口合并推送，避免 JCEF executeJavaScript 风暴。

### 5.1 前端资源加载

自定义 scheme：`CefApp.registerSchemeHandlerFactory("http", "pi-agent", handler)`，handler 从插件 classloader 读取 `webui/` 资源（MIME 按扩展名）。前端通过 `http://pi-agent/index.html` 访问。
备选方案（若 CEF 注册在目标平台行为异常）：打包期起一个仅绑定 `127.0.0.1` 随机端口的轻量 HTTP 服务。**MVP 阶段先落地备选方案以保证交付，自定义 scheme 在 M2 验证切换**（两者对前端透明，仅 base URL 不同）。

## 6. 前端架构（`web/`）

- 技术栈：**React 18 + TypeScript + Vite**；markdown：`marked` + `dompurify`；高亮：`highlight.js`；状态：`zustand`（轻量、无样板）。
- 入口自省：`window.__piSend` 存在 → `JcefBridge`；否则 → `MockBridge`（内存假 pi，可脚本化场景），**同一套代码跑 IDE 与浏览器**。
- 状态模型（`usePiStore`）：
  - `connection`：进程状态、pi 版本、错误
  - `session`：state（模型/思考等级/isStreaming）、消息列表（`ChatItem[]`：UserItem | AssistantItem(text/thinking/toolcall 块) | ToolCardItem）、队列、stats
  - `ui`：当前页签、命令面板、模型选择器
- 事件归约器（`applyEvent`）：把 pi 事件流（`message_start/update/end`、`tool_execution_*`、`agent_*`、`queue_update`、`auto_retry_*`、`compaction_*`）归约为 `ChatItem[]` 的增量更新 —— **这是前端唯一的复杂逻辑，纯函数，单测覆盖**。
- 样式：手写 CSS（跟随 IDE 主题：Java 注入 `data-theme=light|dark` + CSS 变量，色值取自 IDE ThemeJson）。

## 7. 管理层（`manage/`）

对 pi CLI 子命令的安全包装（一律不带 shell，参数数组直传；用户输入不经过 shell 拼接）：

| 操作 | 实现 |
|---|---|
| 认证状态 | `pi auth check --provider X --json` |
| MCP 列表/增删/OAuth | `pi mcp list --json` / `pi mcp add …` / `pi mcp login`（超时保护） |
| 包安装/卸载/列表 | `pi install <src>` / `pi remove` / `pi list` |
| Skills 列表 | 文件系统扫描（`SKILL.md` frontmatter 解析，支持 `~/.pi/agent/skills`、`.pi/skills`、`.agents/skills`） |
| 设置/模型 | 直接读写 `~/.pi/agent/settings.json`、`models.json`（JSON 保留注释不做，pi 不支持注释） |

写文件前先备份 `.bak`；所有管理操作完成后提示用户 `/reload` 或自动重启 RPC 进程使配置生效。

## 8. 线程模型

| 层 | 线程 |
|---|---|
| RPC 读循环 | 专用 daemon 线程 `pi-rpc-reader-<n>` |
| RPC 请求 | 调用方上下文（UI 动作 → `Dispatchers.EDT` 立即转后台协程） |
| 桥接 handler | JCEF pooled 线程 → 协程 `Dispatchers.Default` |
| Swing/JCEF API 访问 | EDT（`invokeLater`） |
| 前端事件推送 | 合并窗口后于后台协程调用 `executeJavaScript`（JBCef 线程安全） |

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
| ADR-5 | 目标平台 `2026.2`（用户本机 2026.2.3） | 下载离线 IDE | 本机即真实目标；`runIde`/安装测试直接命中用户环境 |
| ADR-6 | bytecode 21 / Gradle 8.14 / IPG 2.x | — | 平台 2026.2 要求 |

## 12. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 自定义 scheme 在 JCEF 兼容性问题 | 已备轻量本地 HTTP 服务方案（§5.1），切换对前端透明 |
| GUI 启动的 IDE 缺 nvm PATH | 登录 shell PATH 探测 + 设置项手动指定 |
| pi RPC 协议随版本演进 | 协议宽容解析 + 前端归约器单测 + `sinceBuild` 收紧 |
| JCEF 远程调试端口不可用（IDE 策略） | e2e 降级路径：前端 e2e + runIde 截图 + 人工清单 |
| 本地 HTTP 服务被其他进程访问 | 仅绑定 127.0.0.1 + 随机端口 + 首次访问 token 校验 |

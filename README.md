# Pi Agent for JetBrains

**Pi coding agent, embedded in your IDE.** A JetBrains plugin that turns the
[pi coding agent](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`)
into a first-class GUI inside IntelliJ IDEA — chat, tool-call review, session
management, and full GUI management of pi's ecosystem (models, MCP servers,
packages, skills, settings).

```
┌────────────────────────────────────────────┐
│ [模型▾] [思考▾]            [Compact] [+New] │
├────────────────────────────────────────────┤
│  You: Fix the failing tests                │
│  Pi:  ▸ 💭 Thinking                        │
│       Here is my plan…                     │
│       ❯ bash · npm test · 0.8s ✓           │
│       The command printed … Done ✅        │
├────────────────────────────────────────────┤
│ [输入框…] [Steer/Follow-up▾] [Send/Stop]    │
│ ● pi 1.4.0   ctx 32%  $0.45  12 msgs       │
└────────────────────────────────────────────┘
```

## 功能

**Chat** — 流式 markdown（含代码高亮、代码块复制）、thinking 折叠块、
工具调用卡片（edit/write 显示 diff 视图）、**工具调用审批**（默认自动批准，
⚙ Options 关掉即回到逐次确认；read-only 工具始终直接放行）、steer/follow-up 排队、
中止、斜杠命令补全、@ 文件引用补全、图片发送（粘贴/选择/**拖拽**）、file:line
点击跳回编辑器、手动 compact、**⚙ 自动压缩/自动重试开关**、会话统计（上下文占用
进度条/成本）、IDE 明暗主题跟随。

**IDE 集成** — 编辑器右键 **Explain / Fix / Send Selection with Pi**（自动带
file:line 与选区上下文）、后台任务完成系统通知（点击直达工具窗）、状态栏
pi 运行状态 widget、markdown 外链用系统浏览器打开、多窗口完全隔离
（每窗口独立会话与事件流）。

**Sessions** — 按项目列出历史会话（名称/预览/时间/消息数），一键续聊（回放完整
历史）、重命名、新建、**克隆、导出 HTML（免脚本单文件）**、**删除**；聊天工具栏
**Fork** 从最后一条 user 消息分叉新会话。

**Manage** — pi 生态全部图形化管理：MCP 服务器（增删/OAuth 登录）、
扩展包（npm/git/本地安装卸载）、Skills（浏览/创建模板，标注用户级 / 项目级）、
认证状态（逐 provider 检查）、`settings.json` 内嵌编辑，以及 pi 安装自检引导
（尊重 `PI_CODING_AGENT_DIR` 自定义安装位置）。

**项目信任** — pi 只在受信任的项目里加载仓库内的 `.pi/`（skills / MCP / settings /
扩展）。面板会说明"这个项目的项目级配置现在是否生效"：未信任时横幅列出会被忽略的
资源并提供一键信任（二次确认、逐项列出将生效内容），已信任时可撤销；写
`~/.pi/agent/trust.json` 走备份 + 原子替换，解析失败拒绝写入，不会波及别的项目。

## 安全

本地桥接服务只绑定 `127.0.0.1` 随机端口；每个项目签发独立随机 token
（经加载 URL 交给内嵌 UI），并做 Origin 同源校验 —— 恶意网页无法通过
CSRF 驱动你的 agent。

## 安装

从 [Releases](../../releases) 下载 `pi-agent-idea-<version>.zip`，然后
`Settings → Plugins → ⚙ → Install Plugin from Disk…`，重启 IDE。

要求：IntelliJ IDEA 2023.3+（233–263.\*，全系 JetBrains IDE，支持范围对标
cc gui）、本机安装 pi
（`npm install -g @earendil-works/pi-coding-agent`；**Windows 上请装在
Windows 侧**，见下方 WSL 边界）。插件按 `PI_AGENT_EXECUTABLE` 环境变量 →
**设置里的自定义路径**（Settings → Tools → Pi Agent）→ 登录 shell PATH
（macOS/Linux）或 `where pi`（Windows）→ 常见安装位置
（Windows 覆盖 `%APPDATA%\npm\pi.cmd`、scoop、chocolatey）的顺序自动定位 pi；
发现失败时在设置里手动指定路径即可。

首次打开工具窗会先做一次环境检测（Node.js / npm / pi）：缺什么直接写在卡片上，
可以一键安装 pi，也可以填一个已有的 pi 路径，不用自己记 `npm install -g` 的命令。

安装源默认**不指定**，即沿用本机 npm 的配置（`npm config get registry`，卡片上会
显示当前值）—— 公司私服、内网代理、`.npmrc` 里改过的源都不用动。需要时也可以选官方
`registry.npmjs.org`、国内镜像 `registry.npmmirror.com`，或直接粘贴自己的源地址
（只写域名会按 https 处理；本地 registry 保留 `http://`）。

安装过程不限时（冷装依赖多，镜像慢时十几分钟很正常），按钮上会走秒数；**随时可以点
「Stop」终止**，npm 及其子进程会被一起结束。

## 排障

工具窗打不开、或打开是空白时，先看 `Help → Show Log in Explorer` 里的 `idea.log`：

- `Pi Agent UI: loading http://127.0.0.1:<port>` —— 面板实际加载的地址（token 不写日志）。
- `UI resource not found: webui/…` —— 打包缺资源，前端脚本 404，页面必然白屏。
- `Pi Agent UI failed to load: … — ERR_…` —— 内嵌浏览器打不开本地服务（代理、安全软件、端口被拦）。
- `JCEF console: …` —— 页面里的 JS 报错，前端启动自检的结论也走这一行。

白屏时面板本身会给出原因与地址，可「用系统浏览器打开」验证：浏览器能显示说明前端没问题，
问题在内嵌浏览器；浏览器也打不开说明本地 UI 服务没起来。

进阶手段：

- 内网/离线环境：插件不访问外网，UI 全部由本机 `127.0.0.1` 提供；若装了 HTTP 代理，
  把 `127.0.0.1,localhost` 加进 `Settings → HTTP Proxy → Proxy exceptions`。
- 内嵌浏览器被安全软件拦（多见于 Windows 企业环境）：`Help → Find Action → Registry`，
  取消勾选 `ide.browser.jcef.sandbox.enable` 后重启 IDE。
- pi 找不到（`Cannot run program` / `pi process is not running`）：优先在
  `Settings → Tools → Pi Agent` 指定 pi 的绝对路径，绕过自动发现。

## 开发

工具链：**JDK 17**（Gradle toolchain 自动解析）、**Node 20+**。
IDE 依赖：编译目标是远程 **IntelliJ IDEA Community 2024.3.1**（支持的最低
平台线，约 1 GB 首次下载）——每次构建都在验证整个支持区间（233–263.\*）的
二进制兼容性，与 cc gui 的做法一致。`ideaPath` 属性仅用于把 runIde/e2e 指向
本地真实 IDE，构建不需要。

macOS / Linux：

```bash
./gradlew test buildPlugin          # Kotlin 测试 + 发行包
cd web && npm install
npm run test                        # 事件归约器单测（Vitest）
npx playwright test                 # 前端 e2e（MockBridge）
cd .. && bash scripts/e2e-ide.sh    # 真实 IDEA JCEF e2e（CDP :9222 + mock pi）
```

Windows（PowerShell）：

```powershell
.\gradlew.bat test buildPlugin
cd web; npm install
npm run test
npx playwright test
cd ..; powershell -ExecutionPolicy Bypass -File scripts\e2e-ide.ps1          # mock pi e2e
powershell -ExecutionPolicy Bypass -File scripts\e2e-ide.ps1 -Real          # 真实 pi e2e
```

### WSL 支持边界

- ✅ WSL 内运行 Gradle 构建（自动探测 `/mnt/c` 下的 Windows IDEA）
- ✅ Windows IDEA + Windows 原生 pi（npm 全局装在 Windows 侧）
- ❌ WSL 内 `runIde` / IDE-e2e —— Linux JVM 驱动不了 Windows IDE，请从 Windows 侧跑
- ❌ Windows IDEA + WSL 里的 pi —— Windows JVM 无法启动 Linux ELF，请在 Windows 侧安装 pi

- 产品/架构/任务文档见 [docs/](docs/)
- 架构要点：`pi --mode rpc` 子进程（严格 LF JSONL）+ loopback HTTP 桥接
  （`POST /bridge`、长轮询 `GET /bridge/poll`）+ JCEF 工具窗内 React SPA
  （同一套代码跑 MockBridge 与真实桥接，见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)）

## License

Apache-2.0

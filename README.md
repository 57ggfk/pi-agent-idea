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
工具调用卡片（edit/write 显示 diff 视图）、steer/follow-up 排队、中止、
斜杠命令补全、@ 文件引用补全、图片发送（粘贴/选择/**拖拽**）、file:line
点击跳回编辑器、手动 compact、会话统计（上下文占用/成本）、IDE 明暗主题跟随。

**IDE 集成** — 编辑器右键 **Explain / Fix / Send Selection with Pi**（自动带
file:line 与选区上下文）、后台任务完成系统通知（点击直达工具窗）、状态栏
pi 运行状态 widget、markdown 外链用系统浏览器打开、多窗口完全隔离
（每窗口独立会话与事件流）。

**Sessions** — 按项目列出历史会话，一键续聊（回放完整历史）、重命名、新建。

**Manage** — pi 生态全部图形化管理：MCP 服务器（增删/OAuth 登录）、
扩展包（npm/git/本地安装卸载）、Skills（浏览/创建模板）、认证状态
（逐 provider 检查）、`settings.json` 内嵌编辑，以及 pi 安装自检引导
（尊重 `PI_CODING_AGENT_DIR` 自定义安装位置）。

## 安全

本地桥接服务只绑定 `127.0.0.1` 随机端口；每个项目签发独立随机 token
（经加载 URL 交给内嵌 UI），并做 Origin 同源校验 —— 恶意网页无法通过
CSRF 驱动你的 agent。

## 安装

从 [Releases](../../releases) 下载 `pi-agent-idea-<version>.zip`，然后
`Settings → Plugins → ⚙ → Install Plugin from Disk…`，重启 IDE。

要求：IntelliJ IDEA 2026.2+（262.*）、本机安装 pi
（`npm install -g @earendil-works/pi-coding-agent`）。插件会通过登录 shell
PATH 自动定位 pi，无需额外配置。

## 开发

```bash
# 工具链：JDK 21（toolchain 自动解析）、Node 20+
./gradlew test buildPlugin          # Kotlin 测试 + 发行包
cd web && npm install
npm run test                        # 事件归约器单测（Vitest）
npx playwright test                 # 前端 e2e（MockBridge）
cd .. && bash scripts/e2e-ide.sh    # 真实 IDEA JCEF e2e（CDP :9222 + mock pi）
```

- 产品/架构/任务文档见 [docs/](docs/)
- 架构要点：`pi --mode rpc` 子进程（严格 LF JSONL）+ loopback HTTP 桥接
  （`POST /bridge`、长轮询 `GET /bridge/poll`）+ JCEF 工具窗内 React SPA
  （同一套代码跑 MockBridge 与真实桥接，见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)）

## License

Apache-2.0

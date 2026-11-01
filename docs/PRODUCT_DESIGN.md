# Pi Agent for JetBrains —— 产品设计文档

> 版本：v1.0（2026-10-27）
> 状态：正式立项，作为本仓库实现的唯一产品需求来源

## 1. 产品概述

**Pi Agent for JetBrains** 是一个 IntelliJ 平台插件，把 [pi](https://github.com/earendil-works/pi)（`@earendil-works/pi-coding-agent`，一款开源编码 Agent CLI）以图形化方式嵌入 JetBrains IDE（IntelliJ IDEA / PyCharm / WebStorm / GoLand 等）。

对标产品是 Claude Code 的桌面 GUI / IDE 集成体验：在 IDE 内直接与编码 Agent 对话、委派任务、审查它对代码的每一步操作，并且**完整接管 pi 的生态管理**（模型、MCP、扩展包、Skills、会话）。

**一句话定位**：在 JetBrains IDE 里，用图形界面驱动的 pi coding agent。

## 2. 目标用户与核心场景

| 用户 | 场景 |
|---|---|
| 已在终端使用 pi 的开发者 | 不想切终端，希望在 IDE 内看渲染后的 markdown、折叠的工具调用、可点击跳转的文件引用 |
| 未使用过 pi 的开发者 | 在 IDE 内零门槛完成 pi 的配置：选模型、配 API Key、装扩展、加 MCP 服务器 |
| 重度 Agent 任务用户 | 并行/排队多轮任务、steering 打断、fork/clone 会话、审查成本与上下文占用 |

核心用户旅程（首次使用）：
1. 打开右侧 Tool Window「Pi Agent」→ 看到环境自检卡片（pi 是否安装、版本、认证状态）。
2. 选择模型 → 输入需求 → 看到流式回答、思考块、工具调用卡片。
3. Agent 改了代码 → 在 diff 预览里确认。

核心用户旅程（日常管理）：
1. 「管理」页签：查看/新增/删除 MCP 服务器，安装/卸载扩展包，浏览/创建 Skills。
2. 「会话」页签：按项目列出历史会话，续聊/重命名/删除/导出 HTML。

## 3. 功能规格

### 3.1 P0 —— 对话（核心，MVP）

| # | 功能 | 说明 | 依赖的 pi 能力 |
|---|---|---|---|
| P0-1 | RPC 会话生命周期 | 每个项目一个 `pi --mode rpc` 子进程；随项目打开/关闭；崩溃自动重启 | `--mode rpc` |
| P0-2 | 流式对话 | 发送 prompt，流式渲染回复文本（markdown） | `prompt` + `message_update/text_delta` |
| P0-3 | 思考块展示 | 折叠展示 thinking 内容，可展开 | `thinking_delta/thinking_end` |
| P0-4 | 工具调用卡片 | 每次工具调用显示名称、参数摘要、输出（可折叠）、耗时、错误标记 | `tool_execution_start/update/end` |
| P0-5 | 中止 | 运行中可一键中止；显示中止状态 | `abort` + `agent_settled(aborted)` |
| P0-6 | 消息排队 | 运行中继续输入：可选 steer（打断方向）或 followUp（完成后执行）；展示排队队列 | `prompt.streamingBehavior`、`steer`、`follow_up`、`queue_update` |
| P0-7 | 重试状态 | 自动重试时展示倒计时与错误 | `auto_retry_start/end` |
| P0-8 | 会话统计 | 底部状态栏：上下文占用百分比、累计成本、消息数 | `get_session_stats` |
| P0-9 | 新会话 | 一键开新会话 | `new_session` |
| P0-10 | 崩溃/退出检测 | 进程异常退出给出可重试的错误卡片 | 进程退出码、stderr |

### 3.2 P1 —— 模型与会话管理

| # | 功能 | 说明 | 依赖 |
|---|---|---|---|
| P1-1 | 模型选择器 | 顶栏下拉列出可用模型（名称、提供商、上下文窗口），当前模型高亮 | `get_available_models`、`set_model` |
| P1-2 | 思考等级选择器 | off/minimal/low/medium/high/…，仅显示当前模型支持的档位 | `get_available_thinking_levels`、`set_thinking_level` |
| P1-3 | 会话列表 | 按当前项目列出历史会话（时间、名称、消息数），点击切换 | `switch_session`、解析 `~/.pi/agent/sessions/<cwd-编码>/*.jsonl` 头部 |
| P1-4 | 会话操作 | 重命名（`set_session_name`）、fork（从历史 user 消息分叉）、clone、导出 HTML | `fork`、`clone`、`export_html`、`get_fork_messages` |
| P1-5 | 紧凑压缩 | 手动 compact，展示压缩前后 token 对比 | `compact`、`compaction_start/end` |
| P1-6 | 上下文回放 | 打开会话时回放完整历史消息（含工具调用） | `get_messages` |
| P1-7 | 斜杠命令 | 输入 `/` 弹出命令补全（扩展命令、prompt 模板、skills） | `get_commands` |
| P1-8 | 图片输入 | 粘贴/选择图片随消息发送 | `prompt.images` |

### 3.3 P2 —— pi 生态管理（GUI 化管理 pi）

| # | 功能 | 说明 | 依赖 |
|---|---|---|---|
| P2-1 | 认证状态面板 | 各 provider 凭据就绪状态一览 | `pi auth check --json` |
| P2-2 | MCP 服务器管理 | 列表（状态/工具数/错误）、新增 stdio/HTTP 服务器、启停、删除、OAuth 登录/登出 | `pi mcp list --json`、`pi mcp add/remove/login/logout`、`mcp.json` |
| P2-3 | 扩展包管理 | 已装包列表、从 npm/git/本地路径安装、卸载、更新 | `pi install/remove/list`、`pi update` |
| P2-4 | Skills 管理 | 用户/项目两级 skills 列表（名称、描述、路径）、新建 Skill 模板、在编辑器中打开 | 扫描 `~/.pi/agent/skills`、`.pi/skills`、`.agents/skills` |
| P2-5 | pi 设置 | 内嵌编辑 `~/.pi/agent/settings.json`（带 schema 提示），常用项图形化开关 | settings.json |
| P2-6 | 自定义模型/Provider | 查看 `models.json` 中的自定义 provider，跳转编辑 | `models.json` |
| P2-7 | pi 二进制管理 | 自定义 pi 路径；检测未安装时引导安装（`npm i -g @earendil-works/pi-coding-agent`）；版本显示与更新 | `pi --version`、`pi update` |

### 3.4 P3 —— IDE 深度集成

| # | 功能 | 说明 |
|---|---|---|
| P3-1 | 编辑器上下文菜单 | 「Send to Pi」「Explain with Pi」「Fix with Pi」动作，把选区/文件作为 prompt 上下文 |
| P3-2 | 文件引用跳转 | 聊天里的 `file:line` 引用可点击，在 IDE 中打开并跳转 |
| P3-3 | 完成通知 | 长任务完成/失败时系统通知（ToolWindow 非可见时） |
| P3-4 | 状态栏 Widget | 显示运行状态与上下文占用 |
| P3-5 | 主题跟随 | 前端 UI 跟随 IDE 明暗主题 |
| P3-6 | 项目信任 | 项目级 `.pi/` 资源仅在信任后生效（遵循 pi 信任模型） |

### 3.5 明确不做（Non-goals）

- 不做 pi 之外的 agent 适配（单一支持 pi）。
- 不做 pi TUI 的全功能复刻（如 `/tree` 完整树导航——提供 fork/clone 等价能力即可）。
- 不在插件内存储任何 API Key：凭据一律由 pi 自身管理（`auth.json` / `models.json`）。
- 不做移动端/远程。

## 4. 关键用户体验设计

### 4.1 布局

```
┌──────────────────────────────────────────────────────┐
│ [会话▾] [模型▾] [思考▾]                    [新会话] [⚙] │  ← 顶栏
├──────────────────────────────────────────────────────┤
│  … 历史消息 …                                         │
│  ┌─ 用户 ─────────────────────────────┐              │
│  │ 帮我修复测试                        │              │
│  └────────────────────────────────────┘              │
│  ┌─ 助手 ─────────────────────────────┐              │
│  │ <流式 markdown…>                    │              │
│  │ ▸ 💭 Thinking (1.2k tokens)         │  ← 折叠思考块  │
│  │ ⚙ bash · ls -la · 0.3s ✓           │  ← 工具卡片    │
│  │ ▸ edit · src/Foo.kt +3 -1           │              │
│  └────────────────────────────────────┘              │
├──────────────────────────────────────────────────────┤
│ 队列: 1 条 followUp · [中止]                          │
│ ┌────────────────────────────────────────────┐ [发送] │
│ │ 输入消息，/ 唤起命令…                        │        │
│ └────────────────────────────────────────────┘        │
│ 上下文 32% · $0.45 · 12 msgs            pi 1.4.0 ●运行中│ ← 状态栏
└──────────────────────────────────────────────────────┘
```

页签结构（ToolWindow 顶部或左侧条）：
- **Chat**（默认）：上述对话视图。
- **Sessions**：会话列表与管理。
- **Manage**：MCP / 扩展包 / Skills / 认证 / 设置（二级导航）。

### 4.2 技术呈现原则

- 流式 markdown：使用渲染库；代码块带语言标签与复制按钮。
- 工具卡片：`read`/`edit`/`write` 显示文件路径 + 行数增删摘要；`bash` 显示命令与输出（默认折叠长输出）；工具结果错误用红色标记。
- 成本与 token：`get_session_stats` 定时刷新（每次 `agent_settled` 后）。
- 错误呈现：进程级错误（崩溃/找不到 pi）使用带修复建议的卡片；协议级错误直接内联展示。

### 4.3 环境自检（Onboarding）

首次打开且检测不到 pi 时显示引导页：检测步骤（PATH 查找 → 自定义路径 → `npm` 全局）→ 未安装则给出安装命令与说明 → 安装后一键重新检测。

## 5. 竞品参照（成熟工具的功能基线）

参照 Claude Code GUI、Cursor Agent 面板、Cline、Zed ACP 面板等成熟产品，一张表校验覆盖度：

| 成熟工具必备能力 | 本产品对应 |
|---|---|
| 流式对话 + markdown 渲染 | P0-2 |
| 工具调用透明化（可审查） | P0-4、P3-2 |
| 中断/重定向控制 | P0-5、P0-6 |
| 模型切换 | P1-1、P1-2 |
| 会话持久化与管理 | P1-3、P1-4 |
| 上下文管理（压缩） | P1-5 |
| 成本/用量可见 | P0-8 |
| MCP 配置管理 | P2-2 |
| 扩展/技能管理 | P2-3、P2-4 |
| IDE 上下文（选中代码、跳转） | P3-1、P3-2 |
| 环境自检与安装引导 | §4.3 |
| 主题跟随 | P3-5 |

## 6. 质量与验收标准

1. **功能验收**：每个 P0/P1 功能在真实 IDEA 上人工可用（本仓库附带 `MANUAL_TEST.md` 脚本）；P2 逐项验收。
2. **自动化验收**：
   - 单元测试：RPC 协议解析（含 JSONL 分帧、Unicode 行分隔符陷阱）、响应/事件模型、会话文件解析。
   - 前端 e2e（Playwright + 独立 serve 前端 + MockBridge）：对话流、工具卡片、中止、命令补全。
   - IDE e2e（Gradle runIde + JCEF 远程调试端口 + CDP）：真实 JCEF 内走通「发送→流式回复→中止」全链路。
3. **兼容性**：支持区间 2023.3–2026.3（`sinceBuild=233` / `untilBuild=263.*`，
   对标 cc gui）；编译目标固定为最低支持线 IntelliJ IDEA Community 2024.3.1，
   使每次构建都验证全区间二进制兼容。
4. **发布物**：`buildPlugin` 产出 zip；仓库含 CHANGELOG、README、标签发布。

## 7. 里程碑

| 里程碑 | 内容 | 出口标准 |
|---|---|---|
| M1 (MVP) | P0 全部 | runIde 中能用真实 pi 完成一轮流式对话 + 中止 |
| M2 | P1 全部 | 模型/思考/会话/斜杠命令可用 |
| M3 | P2 全部 | 图形化管理 MCP/扩展/Skills 可用 |
| M4 | 测试 + P3 精选 | e2e 通过、安装到真实 IDEA、GitHub 发布 v0.1.0 |

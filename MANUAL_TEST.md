# 手工验收清单（真机 IDEA）

> 插件：Pi Agent v0.2.1 · 目标：IntelliJ IDEA 2026.2+（全系 JetBrains IDE，262.*）
> 前置：本机装有 pi（`pi --version`）；IDEA 可用任意模型配置。

## 安装

- [ ] `Settings → Plugins → ⚙ → Install Plugin from Disk…` 选择 `build/distributions/pi-agent-idea-0.2.1.zip`（或直接解压到 `~/Library/Application Support/JetBrains/IntelliJIdea2026.2/plugins/`）→ 重启 IDE
- [ ] 重启后 `Settings → Plugins` 中出现 **Pi Agent**，无加载报错（`Help → Show Log` 无 SEVERE）

## Chat（对话）

- [ ] 右侧边栏出现 **Pi Agent** 工具窗（图标为蓝色 π 徽标），打开后显示空态（模型名 · provider）
- [ ] 顶栏模型选择器列出可用模型；思考等级选择器显示当前模型支持的档位
- [ ] 发送一条消息 → 流式 markdown 渲染（代码块有高亮，右上角有 **Copy** 按钮）
- [ ] 消息里的 markdown 链接点击 → 用系统浏览器打开（工具窗不导航走）
- [ ] 消息中出现 `file.kt:12` 形式引用 → 点击跳到编辑器对应行
- [ ] 触发一次工具调用 → 出现工具卡片；edit/write 调用显示红绿 **diff 视图**
- [ ] 发送图片 → 自己的消息气泡里图片**回显**；会话回放时图片也显示
- [ ] 输入 `@` → 出现文件补全浮层（输入关键词过滤，↑↓/Enter 选择，Esc 只关菜单）
- [ ] 拖拽一张图片文件到输入框 → 和粘贴一样出现图片 chips
- [ ] 运行中发送第二条消息 → 出现 Steer/Follow-up 模式选择；选择后底部显示排队提示
- [ ] 点击 **Stop** → 中止；输入框恢复 Send
- [ ] 输入 `/` → 命令补全菜单（扩展命令/模板/skill）；Tab 选中后自动补全
- [ ] 底部状态栏：运行状态点、pi 版本、ctx 百分比、成本、消息数
- [ ] 顶栏 **Compact** → 系统条目显示压缩前后 token
- [ ] 顶栏 **+ New** → 清空会话

## IDE 集成（v0.2 新增）

- [ ] 编辑器选中一段代码 → 右键菜单出现 **Pi Agent** 组（Explain / Fix / Send Selection to Pi）
- [ ] **Explain with Pi** → 工具窗激活，输入框预填了带 `file:line` 与选区代码的 prompt（可编辑后发送）
- [ ] **无选区时**右键 → 三个动作置灰
- [ ] **项目文件树右键任意文件 → Pi Agent → Send File to Pi Agent** → 整文件内容进输入框（v0.2.1）
- [ ] 让 pi 改一个文件 → 改动工具卡片上点 **Diff** → 弹出 JetBrains 原生 Before/After 对比窗口（v0.2.1）
- [ ] 工具卡片/消息里的文件路径（绝对、相对、`~/` 均可）点击 → 编辑器打开对应行（v0.2.1）
- [ ] 状态栏出现 **π** widget：pi 运行中显示版本，崩溃显示 ⚠；点击 widget 打开工具窗
- [ ] 发一条让 pi 跑几十秒的任务，期间切到其他工具窗 → 任务完成时收到 **"Pi Agent finished"** 气泡通知，点击 **Show Pi Agent** 激活工具窗
- [ ] 同时打开两个项目窗口 → 两个工具窗各自独立对话，互不串扰（在 A 发消息，B 不出现任何事件）

## Sessions（会话）

- [ ] Sessions 页签列出本项目历史会话（名称/预览/时间）
- [ ] 点击某会话 → 回到 Chat 并回放历史消息
- [ ] 重启 IDE 后打开工具窗 → 上一会话历史自动回放

## Manage（管理）

- [ ] 顶部横幅显示 pi 版本与二进制路径（找不到 pi 时显示安装引导命令）
- [ ] **MCP Servers**：`pi mcp add demo -- echo hi` 后 Refresh 出现条目；Remove 可删除；有 OAuth 的服务器可 Login/Logout
- [ ] **Packages**：`pi install npm:@example/pi-tools` 后出现条目；Remove 可卸载
- [ ] **Skills**：列出 `~/.pi/agent/skills`、`.pi/skills`、`.agents/skills` 下的技能；**+ New skill** 可创建模板
- [ ] **Auth**：列出已配置凭据/custom provider 的 provider；**Check** 显示 ready/not_ready
- [ ] **Settings**：加载 `~/.pi/agent/settings.json`；改坏 JSON 保存 → 报错不落盘；改合法 JSON 保存 → 成功且生成 .bak

## 异常路径

- [ ] 临时将插件设置中的 pi 移出 PATH（或 mock 崩溃 `MOCK_PI_FAIL=1`）→ 状态栏出现红色退出横幅与 stderr 摘要
- [ ] 项目关闭 → pi 进程终止（`ps | grep "mode rpc"`）

## 自动化对应

以上 Chat/Sessions/Manage 的核心路径已由三层自动化覆盖：
`./gradlew test`（14 例）· `cd web && npx playwright test`（11 例）· `bash scripts/e2e-ide.sh`（真实 JCEF 全链路）

# 手工验收清单（真机 IDEA）

> 插件：Pi Agent v0.1.0 · 目标：IntelliJ IDEA 2026.2（IU 262.*）
> 前置：本机装有 pi（`pi --version`）；IDEA 可用任意模型配置。

## 安装

- [ ] `Settings → Plugins → ⚙ → Install Plugin from Disk…` 选择 `build/distributions/pi-agent-idea-0.1.0.zip`（或直接解压到 `~/Library/Application Support/JetBrains/IntelliJIdea2026.2/plugins/`）→ 重启 IDE
- [ ] 重启后 `Settings → Plugins` 中出现 **Pi Agent**，无加载报错（`Help → Show Log` 无 SEVERE）

## Chat（对话）

- [ ] 右侧边栏出现 **Pi Agent** 工具窗，打开后显示空态（模型名 · provider）
- [ ] 顶栏模型选择器列出可用模型；思考等级选择器显示当前模型支持的档位
- [ ] 发送一条消息 → 流式 markdown 渲染（代码块有高亮）
- [ ] 触发一次工具调用 → 出现工具卡片（名称/参数摘要/耗时），点击卡片可展开输出
- [ ] 运行中发送第二条消息 → 出现 Steer/Follow-up 模式选择；选择后底部显示排队提示
- [ ] 点击 **Stop** → 中止；输入框恢复 Send
- [ ] 输入 `/` → 命令补全菜单（扩展命令/模板/skill）；Tab 选中后自动补全
- [ ] 粘贴图片到输入框 → 出现图片 chips；随消息发送
- [ ] 底部状态栏：运行状态点、pi 版本、ctx 百分比、成本、消息数
- [ ] 顶栏 **Compact** → 系统条目显示压缩前后 token
- [ ] 顶栏 **+ New** → 清空会话

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

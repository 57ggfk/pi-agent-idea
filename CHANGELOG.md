# Changelog

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

# Changelog

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

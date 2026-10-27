# Pi Agent for JetBrains —— 任务计划（迭代 + 增量）

> 原则：每个阶段交付**可安装、可验证**的增量；先跑通最小链路，再逐步加厚。
> 状态标记：☐ 待办 / ◐ 进行中 / ☑ 完成

## Phase 0 —— 立项与工程基础
- ☑ 探索 pi 1.4.0 能力面（RPC/mcp/auth/packages/skills/settings/sessions）
- ☑ 产品设计文档
- ☑ 架构设计文档
- ☑ 本任务计划
- ☐ git 初始化 + GitHub 远程仓库（账号 57ggfk）+ 文档入库
- ☐ 工具链：JDK 21、Gradle 8.14.3、wrapper 提交

## Phase 1 —— MVP（最小可用对话）🎯 出口：真实 pi 走通一轮对话
- ☐ Gradle 工程脚手架（IPG 2.x、IU/local 2026.2、kotlinx.serialization）
- ☐ plugin.xml：ToolWindow「Pi Agent」注册
- ☐ JCEF 容器 + 前端资源加载（先本地 HTTP 轻量服务方案）
- ☐ 桥接最小实现（ping/echo + env）
- ☐ 前端骨架：React + Vite，输入框 + 消息列表（纯文本）
- ☐ `PiRpcClient`（JSONL 分帧、请求关联、事件分发）
- ☐ `PiProcessManager`（pi 定位、进程启动/关闭/崩溃回调）
- ☐ 对话链路：prompt → text_delta 流式追加 → agent_settled 结束；abort
- ☐ 单元测试：LfLineReader / 响应关联 / 协议解析
- ☐ `buildPlugin` 成功 + `runIde` 冒烟（对照 MANUAL_TEST Phase1）

## Phase 2 —— 完整聊天体验
- ☐ 事件归约器 `applyEvent`（纯函数）+ 单测（Vitest）
- ☐ markdown 流式渲染（marked + dompurify + highlight.js，代码块复制）
- ☐ thinking 折叠块；usage/cost 展示
- ☐ 工具调用卡片（read/edit/write/bash 专属摘要 + 折叠输出 + 错误态 + 耗时）
- ☐ steer / followUp 排队 UI + queue_update 同步 + clear_queue
- ☐ auto_retry / compaction 事件可视化
- ☐ 模型选择器 + 思考等级选择器（get_available_models / thinking_levels）
- ☐ 斜杠命令补全（get_commands）+ 图片粘贴发送
- ☐ 会话列表（解析 sessions 目录）+ 切换/重命名/新会话
- ☐ 会话统计状态栏（get_session_stats；contextUsage 百分比/成本）
- ☐ IDE 主题跟随（主题注入 + CSS 变量）
- ☐ 前端 e2e：Playwright × MockBridge（对话/工具卡/中止/补全）

## Phase 3 —— pi 生态管理
- ☐ 管理页签框架（Manage 视图导航）
- ☐ 认证面板（pi auth check --json）
- ☐ MCP 管理（list/add(stdio,http)/remove/enable-disable/login/logout）
- ☐ 扩展包管理（pi list / install / remove，安装进度与错误呈现）
- ☐ Skills 管理（扫描 SKILL.md、新建模板、编辑器打开）
- ☐ pi 设置（settings.json 内嵌编辑 + 常用项表单）
- ☐ 环境自检页（未装 pi → 引导安装；版本/PATH 诊断）

## Phase 4 —— IDE 深度集成 + 全面测试
- ☐ 编辑器动作：Send/Explain/Fix with Pi（选区上下文）
- ☐ file:line 引用点击跳转；完成系统通知；状态栏 widget
- ☐ IDE e2e：runIde + JCEF CDP（9222）+ mock pi 全链路用例
- ☐ verifyPlugin + `MANUAL_TEST.md` 执行（真机 IDEA 2026.2.3 安装验证）
- ☐ 文档完善：README（安装/开发/e2e 指南）

## Phase 5 —— 发布
- ☐ CHANGELOG + v0.1.0 tag + GitHub Release（附插件 zip）
- ☐ 全量推送 GitHub（提交人：57ggfk <25079153+57ggfk@users.noreply.github.com>）

## 验收清单（与产品需求映射）
| 需求 | 证据 |
|---|---|
| 对话/agent 任务 | Phase1/2 runIde 与 e2e 通过 |
| 管理 pi/插件/MCP/skill | Phase3 手工验收 + 单测 |
| e2e（JCEF） | web/e2e + scripts/e2e-ide.mjs 报告 |
| 安装到 IDEA | Phase4 真机安装记录 |
| GitHub 托管 | 仓库 57ggfk/pi-agent-idea 提交历史 |

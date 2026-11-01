# Pi Agent for JetBrains —— 任务计划（迭代 + 增量）

> 原则：每个阶段交付**可安装、可验证**的增量；先跑通最小链路，再逐步加厚。
> 状态标记：☐ 待办 / ◐ 进行中 / ☑ 完成

## Phase 0 —— 立项与工程基础
- ☑ 探索 pi 1.4.0 能力面（RPC/mcp/auth/packages/skills/settings/sessions）
- ☑ 产品设计文档
- ☑ 架构设计文档
- ☑ 本任务计划
- ☑ git 初始化 + GitHub 远程仓库（账号 57ggfk）+ 文档入库
- ☑ 工具链：JDK 21、Gradle 9.8.2、wrapper 提交

## Phase 1 —— MVP（最小可用对话）🎯 出口：真实 pi 走通一轮对话
- ☑ Gradle 工程脚手架（IPG 2.19.0、local IU 2026.2、kotlinx.serialization）
- ☑ plugin.xml：ToolWindow「Pi Agent」注册（+ postStartupActivity 自动打开）
- ☑ JCEF 容器 + 前端资源加载（loopback HTTP：LocalUiServer）
- ☑ 桥接实现（HTTP 传输：POST /bridge + GET /bridge/poll 长轮询；JCEF JS 注入不可靠已弃用）
- ☑ 前端骨架：React + Vite，输入框 + 消息列表
- ☑ `PiRpcClient`（JSONL 分帧、请求关联、事件分发）
- ☑ `PiProcessManager`（pi 定位、进程启动/关闭/崩溃回调）
- ☑ 对话链路：prompt → text_delta 流式追加 → agent_settled 结束；abort
- ☑ 单元测试：LfLineReader / RPC 集成（对 mock pi）/ 会话索引
- ☑ `buildPlugin` 成功 + runIde e2e（Playwright over CDP :9222）全绿

## Phase 2 —— 完整聊天体验
- ☑ 事件归约器 `applyEvent`（纯函数）+ 单测（Vitest 10 例）
- ☑ markdown 流式渲染（marked + dompurify + highlight.js）
- ☑ thinking 折叠块；usage/cost 展示
- ☑ 工具调用卡片（工具名 + 参数摘要 + 折叠输出 + 错误态 + 耗时）
- ☑ steer / followUp 排队 UI + queue_update 同步
- ☑ auto_retry / compaction 事件可视化
- ☑ 模型选择器 + 思考等级选择器
- ☑ 斜杠命令补全（get_commands）+ 图片粘贴/附件发送
- ☑ 会话列表（PiSessionIndex 解析 header.cwd）+ 切换 + 重命名
- ☑ 会话统计状态栏（contextUsage/成本/消息数）+ Compact 按钮
- ☑ IDE 主题跟随（env.theme → data-theme）
- ☑ 前端 e2e：Playwright × MockBridge（6 用例全绿）

## Phase 3 —— pi 生态管理
- ☑ 管理页签框架（Manage 视图五分区导航 + 环境横幅）
- ☑ 认证面板（auth.json/models.json 汇总 + pi auth check --provider X --json）
- ☑ MCP 管理（list --json / add(stdio,url) / remove / login / logout）
- ☑ 扩展包管理（pi list / install / remove，含错误呈现）
- ☑ Skills 管理（扫描 SKILL.md frontmatter + 新建模板）
- ☑ pi 设置（settings.json 内嵌编辑，写入前 .bak 备份 + JSON 校验）
- ☑ 环境自检（pi 定位/版本/未装引导；PiCliRunner 经登录 shell PATH）

## Phase 4 —— 测试与真机安装（编辑器深度集成延后到 v0.2）
- ☑ IDE e2e：runIde + JCEF CDP（9222）+ mock pi 全链路用例（scripts/e2e-ide.sh）
- ☑ verifyPlugin：Compatible with IU-262.10968.63（修掉 2 处 deprecated API 级联）
- ☑ 真机安装：插件 zip 已解压至 ~/Library/Application Support/JetBrains/IntelliJIdea2026.2/plugins/
- ☑ `MANUAL_TEST.md` 验收清单（Chat/Sessions/Manage/异常路径）
- ☑ 文档完善：README（安装/开发/e2e 指南）

## Phase 6 —— v0.1.2 稳定性热修（2026-10-31）
- ☑ JCEF browser 泄漏（面板挂入 Disposer 树）
- ☑ RPC 请求超时（默认 120s，可按请求覆盖）
- ☑ PiCliRunner 管道死锁（并发排水 stdout/stderr）+ Dispatchers.IO
- ☑ 本地桥鉴权（per-project 随机 token + Origin 校验 + 16MB body 上限）
- ☑ 桥日志不再记录信封内容

## Phase 7 —— v0.2.0 IDE 深度集成与体验（2026-10-31）
- ☑ 多窗口隔离（per-project token → BridgeService/BridgeTransport 路由）
- ☑ 编辑器动作 Explain/Fix/Send Selection with Pi（选区 + file:line 注入）
- ☑ 后台完成通知（notificationGroup BALLOON，点击激活工具窗）
- ☑ 状态栏 π widget（状态/版本/崩溃 ⚠，点击打开工具窗）
- ☑ file:line 跳转（ide.openFile）+ @ 文件引用补全（files.list）
- ☑ 渲染完整性：图片回显、edit/write diff 视图、代码块 Copy、外链系统浏览器、ErrorBoundary
- ☑ Composer：拖拽图片、Escape/abort/unhandled rejection 小修
- ☑ 长轮询 oldest 缺口检测补救；ensureWired 竞态；PI_CODING_AGENT_DIR；loginShellPath 缓存
- ☐ 真机验收（MANUAL_TEST.md，用户操作）+ GitHub Release

## Phase 8 —— v0.3.1 VCS 集成（2026-11-01）
- ☑ **Generate Commit Message with Pi**：提交面板动作（Vcs.MessageActionGroup +
  Vcs.Commit.PrimaryCommitActions + Alt+Shift/C）→ 已勾选变更 unified diff
  （IdeaTextPatchBuilder，96KB 截断、二进制降级）→ 一次性无头 pi
  （`--print --no-session --no-tools --no-mcp -ne -ns -np -nc`，stdin 传 prompt，
  300s 超时，不进聊天会话）→ 清洗围栏 → 填入提交信息框；失败/取消走通知
- ☑ PiCliRunner 支持 stdin 管道（写入线程 + 超时关闭，复用进程树清理）
- ☑ 单测 8 例：unified diff 拼装（修改/新增/删除/行数推导/截断/二进制）、
  prompt、回复清洗
- ☑ verifyPlugin 修复并真正通过：补 pluginVerification.ides（原来 No IDEs Found
  即失败）；PiAgentToolWindowFactory 改 Java 实现，消除 Kotlin 接口默认方法
  转发器造成的 6 处 @Internal API 误报（verifier ignore 机制不覆盖 usage）
- ☐ 真机验收（MANUAL_TEST.md「Commit Message 生成」节，用户操作）

## Phase 5 —— 发布
- ☑ CHANGELOG + v0.1.0 tag + GitHub Release（附插件 zip）
- ☑ 全量推送 GitHub（提交人：57ggfk <25079153+57ggfk@users.noreply.github.com>）

## 验收清单（与产品需求映射）
| 需求 | 证据 |
|---|---|
| 对话/agent 任务 | Phase1/2 runIde 与 e2e 通过 |
| 管理 pi/插件/MCP/skill | Phase3 手工验收 + 单测 |
| e2e（JCEF） | web/e2e + scripts/e2e-ide.mjs 报告 |
| 安装到 IDEA | Phase4 真机安装记录 |
| GitHub 托管 | 仓库 57ggfk/pi-agent-idea 提交历史 |

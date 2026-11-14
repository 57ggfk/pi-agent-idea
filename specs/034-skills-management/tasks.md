# 034 tasks（T1501+）

> 完成判据：每个 task 自带「— 验证：…」。执行记录 → run-report 034 节。

- [x] **T1501** skillsList 重写：六类来源扫描（含 user-agents/祖先上溯/包归属/外接）、duplicate、enabled 计算
  — 验证：PiManageSkillsTest 假目录覆盖六来源/重名/排除命中（精确+glob）/未信任
- [x] **T1502** 写路径：skillSetEnabled（user/project 分写、未信任拒绝、保留未知键）、skillSetSourceEnabled、skillToggleModelInvocation（frontmatter 行级增删、无 frontmatter 拒绝）
  — 验证：单测覆盖增删往返/未知键保留/无 frontmatter 拒绝/glob 命中移除
- [x] **T1503** 桥接注册 + manage.ts/types/mock（分组 fixture、开关状态机、外接预设）
  — 验证：typecheck；mock.test 补三方法
- [x] **T1504** SkillsPanel 重写：分组头/行内硬软开关/外接区（预设+自定义）/reload 提示条；i18n 双语；样式
  — 验证：typecheck；现有 skills 用例兼容
- [x] **T1505** e2e：分组渲染、禁用→已禁用+reload 条→reload 清除、外接开关、软开关徽章
  — 验证：playwright 全量零回归
- [x] **T1506** 真机：probe-034 扩展（开关切换后 get_commands 变化复验）+ buildPlugin 安装 r35 + MANUAL_TEST
  — 验证：探针输出留 run-report

（T1505/T1506 的真机部分在验收时回填，见 run-report 22 节）
- [x] **T1507** 布局返工（用户反馈）：分组可折叠（localStorage 记忆）、描述单行截断（title 全文）、路径另起一行双响应式（宽=全路径 / ≤640px=~ 与相对短路径，纯 CSS）、按钮右侧竖排
  — 验证：manage.spec +1 条（折叠持久化/响应式切换断言），46/46
- [x] **T1508** 编辑按钮：行内「编辑」→ ide.openFile 打开 SKILL.md（IDEA 编辑器）
  — 验证：manage.spec 断言点击无错误横幅；mock ide.openFile 复用
- [x] **T1509** AGENTS 面板同款路径优化：entryJson +displayPath（global=~/.pi/agent 短格式、root/子目录=项目相对）、响应式双 span 独立路径行
  — 验证：agents.spec +响应式断言（宽全路径/窄短路径），agents+manage 52/52
- [x] **T1510** AGENTS 面板 displayPath 落地修复：T1509 的 AgentsPanel/agents.spec patch 静默失败（replace marker 不匹配且脚本未验证），本轮用 Edit 工具重打；mock fixture/类型补齐；CDP live 复验
  — 验证：agents.spec +响应式断言（宽全路径/窄~短格式）6/6；manage 46/46；CDP 真机 DOM 断言待装 r40 后复测
- [x] **T1513** frontmatter 块标量解析（用户截图反馈：description: | / >- 只显示指示符）
  — 验证：PiSkillsTest +2 条（literal 保 
 / folded 空格折叠 / 缩进续行不产生幽灵键）；CDP 真机实测 orchestration（>-）与 pi-subagents（|）描述完整显示，悬浮含换行原文

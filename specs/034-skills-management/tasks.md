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

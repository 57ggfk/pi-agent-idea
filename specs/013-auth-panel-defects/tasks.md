# 013 tasks

| # | 任务 | 产出 |
|---|---|---|
| T001 | `filterProviderOptions(options, keywords)` 纯函数（空格=AND，匹配 id/name；自定义选项不参与过滤由组件层钉底）+ vitest 单测 | `web/src/lib/knownProviders.ts/.test.ts` |
| T002 | `ProviderPicker` 组件：触发按钮（当前值 + chevron）+ 弹层（搜索框/列表/键盘导航/外点关闭/打开定位当前项）；复用 `.model-*` 样式族；选项含凭据徽标，「自定义 provider」钉底 | `web/src/components/manage/ProviderPicker.tsx` + `styles.css` |
| T003 | ProviderForm 换用 ProviderPicker（add 模式），testid 兼容（`-pick` 触发器、`-custom` 自定义项、`-option` 选项行） | `web/src/components/manage/ProviderForm.tsx` |
| T004 | 账号分段常驻「暂未接入」角标；指引卡加「在 IDE 终端打开」按钮（调 `ide.openTerminal`，按返回的 typed 路径显示不同结果提示） | `ProviderForm.tsx` + i18n |
| T005 | Kotlin `ide.openTerminal`：BridgeService 分发 + `PiIdeTerminal.open(project, command)`（TerminalView 主路径 / 降级：激活工具窗+复制+气泡），command 清洗（长度上限、剥换行）；单测覆盖清洗与降级语义 | `bridge/BridgeService.kt` + `manage/PiIdeTerminal.kt` + 测试 |
| T006 | 三角换 chevron 图标 + 旋转过渡 + 加大点击区 | `AuthPanel.tsx` + `styles.css` |
| T007 | 详情格式化：标量行式（key 列不挤压）、数组/嵌套对象 `<pre>` 格式化块 + max-height 滚动 + 「自动换行」切换 | `AuthPanel.tsx` + `styles.css` |
| T008 | 编辑表单移出 `expanded` 块渲染在行下；「设置 key/收起编辑」语义保持 | `AuthPanel.tsx` |
| T009 | mock：`ide.openTerminal`（`?term=fail` 验证降级路径）；类型与 BridgeMethod 同步 | `web/src/bridge/types.ts` + `mock.ts` + `manage.ts` |
| T010 | i18n：`auth.methodBadgeSoon`、`auth.openTerminal`、`auth.terminalOpened/terminalCopied/terminalFailed`、`auth.wrapLines`、`auth.searchPlaceholder` 等 zh/en | `locales/` |
| T011 | e2e 重写/新增：provider.spec（picker 交互、角标、终端按钮发起调用、US5 回归）、manage.spec（详情格式化+换行切换） | `web/e2e/` |
| T012 | 四件套回归 + 构建 + 覆盖安装真机 + CHANGELOG Unreleased 追加 + 提交推送 | — |

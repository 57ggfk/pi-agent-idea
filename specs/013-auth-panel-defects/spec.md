# 013 认证面板真机验收缺陷（0.5.4 续批）

> 来源：2026-11-08 用户真机验收（截图 ×3，IDEA 2026.2 + 真实 pi 1.4.0）。
> 版本归属：继续挂 0.5.4（CHANGELOG Unreleased），gradle.properties 不动。
> 关联：012 US5/US6（凭据写入）、88d3190（/login 式表单改造）。

## 背景

88d3190 把认证表单改成了 /login 形态（provider 下拉框 + 账号/API key 方式选择），用户在真机上使用后报了 5 个缺陷。其中 2 个是功能性 bug（#5 设置 key 无反应、#4 详情挤压不可读），3 个是可用性打磨（#1 不可搜索、#2 提示缺失、#3 图标辨识度）。

## 缺陷清单与根因（代码已核实）

| # | 现象 | 根因 | 定位 |
|---|---|---|---|
| 1 | 42 个 provider 的下拉框太长，无检索 | native `<select>` 无搜索能力 | `ProviderForm.tsx` |
| 2 | 账号登录未实现，但事前无任何提示 | 「暂未接入」提示只在选中后的指引卡里，方式选择器本身没有标记 | `ProviderForm.tsx` |
| 3 | 展开/折叠小三角辨识度差 | 用文本字符 `"▾"/"▸"` 渲染，深色主题下小而淡 | `AuthPanel.tsx:196` |
| 4 | models.json 详情挤压不可读 | `ConfigValue` 对数组直接压缩 `JSON.stringify`；`.provider-config-row` flex 布局把 key 列挤到逐字换行（"mo de ls"） | `AuthPanel.tsx` + `styles.css:3557` |
| 5 | 点「设置 key」无任何反应（功能 bug） | 编辑表单渲染在 `{expanded === p}` 详情块**内部**：不先点小三角，表单渲染在不可见分支。截图3「收起编辑」但无表单即佐证 | `AuthPanel.tsx:224-240` |

## User Stories

### US1 可搜索的 provider 下拉框

新增/首次运行表单的 provider 选择必须可检索：键盘输入按空格分隔关键词过滤（AND，对 id 与显示名，大小写不敏感），↑↓ 导航、Enter 选中、Esc 关闭、点击外部关闭；打开时高亮并滚动到当前选中项（复用 `ModelPicker`（011 US1–US3）的全部交互约定与样式类）；「自定义 provider」选项固定在列表末尾、不参与过滤；选项上保留「· 账号 / · API key」凭据徽标。42 项在 360px 窄窗下可用。

### US2 账号登录的「暂未接入」提示

- 方式选择器的「账号登录」分段上常驻小角标（如「暂未接入」），未选中即可见；
- 指引卡内新增「在 IDE 终端打开」按钮：点击后 IDEA 终端工具窗打开新会话并**自动输入并执行** `pi`（命令 `ide.openTerminal` 桥接方法，Kotlin 侧 `TerminalView.createLocalShellWidget(project.basePath, …)` + `ShellTerminalWidget.executeCommand`，已 javap 核实 2026.2 真机与 2024.3.1 构建目标双端存在）；任何异常降级为：激活终端工具窗 + 命令复制到剪贴板 + 气泡提示，UI 如实显示走了哪条路径。

### US3 展开/折叠图标可辨识

`"▾"/"▸"` 文本字符换成 Icon 组件的 chevron（`chev-right`），展开时 CSS 旋转过渡；按钮加大笑区，保留 testid/aria-expanded/tooltip。

### US4 models.json 详情格式化

- 标量（string/boolean/number）保持单行行式；数组与嵌套对象改为格式化 JSON（`JSON.stringify(v, null, 2)`）等宽块展示，max-height 滚动（不撑爆面板）；
- 详情区一个「自动换行」切换（`white-space: pre` ↔ `pre-wrap`，默认不换行、横向滚动）；
- key 列不再被挤压逐字换行（值列独立可换行，key 列固定最小宽度）。

### US5 「设置 key」直接出表单（bug 修复）

点击「设置 key」后编辑表单渲染在该行正下方（不再嵌套在详情展开块内），无需先点小三角；「收起编辑」收起；详情展开与编辑表单互不依赖。

## 非目标

- 真 OAuth 浏览器授权（已定下版本，见 88d3190 提交说明与调研存档）。
- models.json 的结构化编辑（仍走 IDE 编辑器打开）。
- 认证列表虚拟滚动（42 行规模不需要）。

## 验收标准

1. US1：e2e——点开选择器输入 "deep" 过滤到 DeepSeek、Enter 选中；输入不存在关键词显示空态；自定义选项固定末尾可选。
2. US2：e2e（mock）——账号分段常驻角标；点「在 IDE 终端打开」发起 `ide.openTerminal`，mock 返回 typed 路径提示；Kotlin 侧 openTerminal 有单测（mock project/terminal 不可注入时降级路径返回 ok=false 语义明确）。真机手动验收记 MANUAL_TEST。
3. US3：三角按钮 chevron 图标 + aria-expanded 正确翻转（e2e 断言）。
4. US4：e2e——展开详情后 models 值以多行格式化 JSON 呈现（行数 > 1）、切换换行后 white-space 类名翻转。
5. US5：e2e——**不展开详情**直接点「设置 key」→ 表单立即可见；「收起编辑」后消失。
6. 四件套全绿（tsc / vitest / playwright / gradlew）；构建装包真机复验。

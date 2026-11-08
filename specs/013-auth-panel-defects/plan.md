# 013 plan

## 技术研究（已实测）

- **Terminal API（US2）**：真机 IDEA 2026.2 `plugins/terminal/lib/terminal.jar` javap 验证：
  `TerminalView.createLocalShellWidget(String, String[, boolean…])` 返回 `ShellTerminalWidget`，
  `executeCommand(String)` 存在且**未标 Deprecated**。构建目标 2024.3.1 同 API 存在（2021 年起稳定）。
  依赖模块 `intellij.terminal`（`bundledModule` 名写错会在构建期报错，可快速迭代）。
  降级路径：任何异常 → 激活 Terminal 工具窗 + `copyText` 复制命令 + 气泡，返回 `{ok:false, typed:false}` 语义。
- **可搜索下拉（US1）**：不引第三方。从 `ModelPicker.tsx`（011 锁定的交互）提取同构交互：
  空格=AND 过滤、↑↓/Enter/Esc、mousedown 外部关闭、打开单次 rAF 定位当前项（`ensureVisible`）。
  过滤逻辑抽纯函数 `filterProviderOptions`（可单测），选项类型复用 `knownProviders.ProviderOption`。
- **#5 根因**：`AuthPanel.tsx` 中 `{formMode === p ? <ProviderForm/>}` 位于 `{expanded === p}` 内。
  修复 = 移出行后独立渲染；e2e 补「不展开详情直接设置 key」回归。
- **#4 根因**：`ConfigValue` 的数组分支走 `JSON.stringify(value)` 压缩一行；`.provider-config-row`
  `justify-content: space-between` + `overflow-wrap: anywhere` 让 key 列被压到逐字换行。
  修复 = 标量走原行式（key 列 `flex: 0 0 auto; min-width`），复合值走 `<pre>` 块 + 详情级换行开关。

## 决策

1. **ProviderPicker 独立组件**（`web/src/components/manage/ProviderPicker.tsx`）：表单里的触发器是
   「类输入框按钮 + chevron」，与 ModelPicker 的 chip 语义不同，但弹层复用 `.model-popover/.model-list/.model-option`
   样式族（宽度 100% 跟随表单字段），不复制样式。
2. **角标实现**：账号分段内 `<span className="segment-badge">`（i18n `auth.methodBadgeSoon`），
   常驻渲染（选中与否都可见）；不改变 aria-checked 语义。
3. **ide.openTerminal 放 BridgeService 而非 PiManage**：它属于 IDE 集成动作（同 `ide.openFile`），
   不是 pi CLI 封装；命名 `ide.openTerminal`，参数 `{command: string}`，command 白名单式使用
   （来自前端常量 `pi`，Kotlin 侧仍做长度/换行清洗，杜绝任意文本注入终端）。
4. **换行开关**：详情块级一个按钮（每个展开的详情独立状态，组件内 useState），默认 `pre`（横向滚动）。
5. **版本号不动**（用户定）：spec 编 013-auth-panel-defects，CHANGELOG 追加到 Unreleased。

## 风险

- `bundledModule("intellij.terminal")` 若模块名不符 → 构建报错即改（自校验）。
- 2026.2 新终端（block terminal）下 `createLocalShellWidget` 行为若变化：executeCommand 已验证存在；
  真机验收若发现命令未送达，降级路径仍可用（不阻塞）。
- ProviderPicker 在 360px 窄窗：弹层宽度跟随字段（100%），选项两行布局（name+badge / id），不横向溢出。

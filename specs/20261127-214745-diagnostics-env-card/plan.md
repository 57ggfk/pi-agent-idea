# 技术方案：诊断页的环境识别卡重做

**Spec**: [spec.md](./spec.md) · **编号**: `20261127-214745` · **Issue**: #14

## 落点

- 分支：`release/0.5.11`（工作树 `D:\code\github\pi-agent-idea-wt\release-0.5.11`，
  远端 `origin/release/0.5.11`，HEAD `7fa419f`）

## 一、现状（读代码得到）

### 1.1 组件

`web/src/components/manage/DiagnosticsPanel.tsx` 的 `.diag-env` 块：

```tsx
<div className="diag-env" data-testid="manage-env">
  {env?.found ? (
    <span className="diag-env-version">
      pi <b data-testid="pi-version">{env.version || "?"}</b> · <span className="mono">{env.path}</span>
    </span>
  ) : ( ... )}
  {env?.agentDir ? <span className="mono diag-env-dir">~/.pi/agent</span> : null}
  {env ? <ToolLine label="node" tool={env.node} ... /> : null}
  {env ? <ToolLine label="npm" tool={env.npm} ... /> : null}
  {env ? ( <span className="diag-env-row" data-testid="env-plugin"> ... </span> ) : null}
  {env?.found ? <button className="btn diag-env-update" data-testid="pi-update" ...>更新 pi</button> : null}
</div>
```

### 1.2 样式

见 spec 的 CSS 摘录。核心问题：`flex-wrap` 把**主体**（版本行）与**条目**
（node/npm/plugin 行）混在一行流里；版本行用 `word-break: break-all`；
按钮混在内容尾部。

### 1.3 版本探测阻塞

`src/main/kotlin/dev/pi/agent/manage/PiManage.kt`：

```kotlin
fun environment(): JsonObject {
    val install = dev.pi.agent.process.PiLocator.locate(forceRefresh = true)   // ← 起 pi --version 子进程
    val (node, npm) = PiEnvironment.detectTools()                            // ← 又起 node -v / npm -v
    ...
}
```

## 二、方案

### 2.1 版本来源换成 `PiDiskVersion`

`PiManage.environment()` 里把 `PiLocator.locate(forceRefresh = true)` 换成
**不重探**的读法：路径用 `PiLocator.locatePath()`（无子进程），版本用
`PiDiskVersion.current()`（package.json 优先，零子进程）。

**注意** `environment()` 仍需要 `forceRefresh` 语义吗？诊断页要的是「此刻磁盘上
是什么」——`PiDiskVersion` 自带 stamp 失效机制，指纹变了才重探，**更准也更省**。

### 2.2 前端用已有的 `pi-disk-version` 事件

前端 store 已经有 `piDiskVersion`（本轮加的）。诊断卡不再单独读 `env.version`，
而是：

- 首屏：`api.environment()` 拿 node/npm/插件/路径（这些是低频事实）
- 版本：**用 store 的 `piDiskVersion`**（事件驱动，外部升级会自动更新）
- 两者不一致时（`env.version` 与 `piDiskVersion` 不同）→ 标注「重启后生效」

**这满足 FR-005（与状态栏同源）**。

### 2.3 布局改成纵向列表

结构：

```tsx
<div className="diag-env" data-testid="manage-env">
  <div className="diag-env-head">
    <span className="diag-env-label">pi</span>
    <b data-testid="pi-version">{diskVersion || "—"}</b>
    {runningDiffers ? <span className="diag-env-hint">重启后生效</span> : null}
    <button className="btn diag-env-update" data-testid="pi-update" ... />
  </div>
  <div className="diag-env-row" data-testid="env-path">
    <span className="diag-env-label">路径</span>
    <span className="diag-env-path mono" title={env.path}>{env.path}</span>
  </div>
  <div className="diag-env-row" data-testid="env-agentdir"> ... </div>
  <div className="diag-env-row" data-testid="env-node"> node 行 </div>
  <div className="diag-env-row" data-testid="env-npm"> npm 行 </div>
  <div className="diag-env-row" data-testid="env-plugin"> 插件行 </div>
</div>
```

CSS：容器改 `display: grid` 或 `flex-direction: column`；每行 `display: grid;
grid-template-columns: <label 宽> 1fr`；路径 `text-overflow: ellipsis` +
`title` 承载全文；**去掉 `word-break: break-all`**（FR-002）。

「更新 pi」按钮放进头部行右侧（不再吊在内容尾巴）。

### 2.4 失败文案

探测不到 → 版本位显示「未检测到」（i18n 键），不是 `?` 也不是空白（FR-006）。

## 三、测试计划

**前端（vitest）**
- `DiagnosticsPanel`：版本取 `piDiskVersion`；两者不同时出现「重启后生效」提示
- 探测失败 → 显示「未检测到」
- 窄面板不横向溢出（e2e，360px）

**Kotlin**
- `PiManage.environment()` 不再起 `pi --version` 子进程 → 用可注入的探针做单测，
  断言「版本来自 `PiDiskVersion`」

## 四、真机验收

1. 打开诊断页 → 环境卡每项一行、路径不拦腰断行
2. 版本号立刻出现（不等子进程）
3. 外部升级 pi → 诊断卡版本自动变（不用刷新页面）
4. 窄面板（360px）不横向溢出
5. 「更新 pi」按钮仍可用

## 五、风险

- **换了版本来源会不会更慢**：`PiDiskVersion` 有 stamp 缓存，指纹不变时是纯内存读；
  指纹变了才读一次 package.json（毫秒级）。不会比现在慢。
- **非 npm 安装退化**：package.json 找不到时仍要起 `pi --version`（约 1s）——
  这时首屏会慢一点，文案要说明。
- **动了别人在看的布局**：诊断卡有 e2e 断言（`e2e/diagnostics-env-info.spec.ts`），
  testid 要保持。

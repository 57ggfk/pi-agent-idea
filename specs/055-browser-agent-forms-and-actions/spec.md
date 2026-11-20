# 055–058 浏览器 agent 融合与操作层——行为面现状（汇总 spec）

> 本文不是一份"新规格"，是 055/056/057/058 四批交付后 **pi_browser 与浏览器面板的当前行为面** 的单点参照。
> 049 的 spec 目录已随 1024e89 回滚删除（功能层由 053/055/056/057 重建），本文件即其继任者。
> 决策过程、RED→GREEN 证据、真机留痕在 `specs/0.5.10-run-report.md` 对应批次段；本文件只记"现在是什么样"。

## 一、pi_browser 动作全集（九个）

| 动作 | 参数 | 语义 |
|---|---|---|
| `open` | url?（缺省=自动探测 loopback dev server）、target?、tab? | 打开页面到指定载体；返回带快照与 tab id |
| `read` | selector?、format?(html/text)、tab? | 整页文本快照或单元素摘录；附 console 尾部 |
| `reload` | tab? | 重放当前页 |
| `scroll` | direction(up/down)、amount(1..10000px)、tab? | 视口滚动，返回 scrollY+快照 |
| `console` | since、limit(1..200)、tab? | console 错误/警告按需回读，更早的行在 JSONL 文件供 grep |
| `click` | selector（必填）、tab? | 合成完整 pointer/mouse 事件序列 + scrollIntoView；回 found/tag/text |
| `type` | selector、text（均必填）、tab? | 原生 prototype value setter + input 事件（React 兼容）/contenteditable 走 execCommand；回 found/typed |
| `evaluate` | js（必填，≤10000 字符）、tab? | 页内跑 JS，JSON 回传（截断）；有 side effect，annotations 同 open |
| `list` | — | 枚举全部活页签：tab/url/title/carrier/selected（`*` 标选中） |

编码层校验所有参数与越界值，错误一律回模型可读 reason（不伪造结果：错 selector 回 `found:false`）。

## 二、载体与寻址（055+056）

- **两种载体**：`tab` = Pi Agent 工具窗页签；`editor` = 编辑器形态预览（LightVirtualFile）。
- **页签 id**：每个浏览器页签发稳定短 id——工具窗 `t1..tN`、编辑器 `e1..eN`（每 manager 实例单调递增不复用）。`open`/`list` 返回 id，各动作回答尾带 `tab` 字段。
- **解析顺序**：显式 `tab` 参数（精确到页签，不存在回 `no browser tab t9`）→ `lastTabId`（agent 上次 open 落点）→ 055 载体回退（target/选中页签）。**tab 与 target 同给时 tab 赢**。
- 编辑器载体同 URL 预览页签复用（F-208 反堆积对齐）；工具窗页签上限 4（MAX_TABS）。

## 三、链接路由目的地（054+058）

- **浏览器页签内链接右键**与 **chat 面板链接右键**：同款四项同款顺序——在系统浏览器打开 → 在 Pi 浏览器打开 → 在 Pi 编辑器打开 → 复制链接地址（两个 Pi 相邻，copy 收尾；视觉顺序由 PiBrowserLinkMenuTest 按调用序锁死）。
- **ASK 选择器**（agent 询问用户链接去向的弹窗）保持三行：LinkRouting.linkOptions() 未扩。
- 编辑器载体页内链接：嵌入式导航在本页签原位（不劫持到工具窗）。

## 四、渲染兜底与主题（058）

- **画布强制白底**：`setPageBackgroundColor("#FFFFFF")`——JCEF 默认画布跟随 IDE 主题色，暗色主题下无背景声明的页面=暗底+黑字不可读；白底兜底后退化为可读的白底黑字。页面自带配色不受影响。
- **页面配色三档下拉（跟随 IDE/浅色/深色）已评估、暂缓**：深色档须成套注入（画布+文字+图片补偿+已暗页探测），决策=先跑白底按实际使用频率再定。
- **agent 生成页面纪律**（pi-browser.js 指南）：页面必须自带成对配色（background+color 一套），不依赖默认画布——页面不需要知道 IDE 主题。

## 五、已知语义边界（如实）

- `read` 快照基于 `document.body.innerText`——input 实时 value 不在其中，读输入值用 `evaluate js=…value`。
- `console` 动作只收 error/warning——页面 console.log(info) 不进面板。
- 合成事件边界：不移动系统光标、反自动化站点可检测、文件上传不可、跨域 iframe 不可达。
- 真 CDP（Input 域真实键鼠）未做——可选增强，需用户 vmoptions 开调试端口。

## 六、相关代码与文档

| 面 | 位置 |
|---|---|
| 动作路由 | `browser/AgentBrowserTool.kt`、`browser/AgentBrowserRequest.kt` |
| 载体与寻址 | `browser/PiBrowserManager.kt`、`browser/BrowserCarriers.kt` |
| 操作层 JS 构造 | `browser/BrowserActionScripts.kt`（转义单测锁死） |
| 内核执行通道 | `browser/PiBrowserKernel.kt`（JBCefJSQuery pendingAction，057 起通用化） |
| pi 侧 schema | `resources/pi-browser/pi-browser.js` |
| 批次留痕 | run-report「054/055/056/057/058」段 + MANUAL_TEST 对应段 + changelog.d 054-058 碎片 |

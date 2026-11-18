# Implementation Plan: 049 内置浏览器 P1（agent 融合 + 链接多选项）

**Branch**: `release/0.5.10` | **Date**: 2026-11-18 | **Spec**: [spec.md](./spec.md)
**Tasks**: [tasks.md](./tasks.md)

## 摘要

两条主线 + 一个顺手条目：**① 链接多选项选择器**（ASK 态从二值模态框升级为 JBPopup 三选项：系统浏览器/内置浏览器/复制链接；SYSTEM/EMBEDDED 默认零变化）→ **② agent 融合**（pi 扩展注册 `pi_browser` 工具，HTTP 直连 LocalUiServer 新端点，IDE 打开工具窗浏览器页签并回读页面快照）→ **③ 工具条「在系统浏览器打开」按钮**（竞品标配，一个按钮的成本）。全链路真机验证用真实鼠标键盘。

## 0. 关键探针证据（本 plan 决策出处）

| # | 结论 | 验证方式 |
|---|---|---|
| Q-1 | pi 扩展可注册 LLM 可调用工具：`pi.registerTool({name, parameters(TypeBox), execute, promptSnippet, promptGuidelines})`；工具出现在 system prompt、进 `pi.getAllTools()` | pi 1.5.2 `docs/extensions.md` §Custom Tools（本机实测阅读） |
| Q-2 | 插件已有 `--extension` 孵化机制：`PiProcessManager.start` 每次启动提取扩展到 config dir 并传 `--extension <path>`，升级自动传播；`PI_APPROVE_POLICY`/`PI_APPROVE_LANG` 环境变量传参先例 | `PiProcessManager.kt:160-194`、`PiApprovalSupport.kt` |
| Q-3 | `pi-approve.js` 扩展形态先例：`export default function(pi)` + `pi.on("tool_call",...)`；Node 22 fetch 可用（pi 进程内） | `resources/pi-approve/pi-approve.js` |
| Q-4 | `LocalUiServer.originAllowed`：`origin == null || origin == ownOrigin` → pi 进程（Node fetch 无 Origin）可过，浏览器网页 CSRF（带外 Origin）被拒 | `BridgeAuth.kt:11` |
| Q-5 | **编译基线 JCEF 无 `getTextVisitor`**（lib-client.jar 常量池验证 False；仅 CookieVisitor）；`executeJavaScript`/`getURL` 存在 → 读回走 JBCefJSQuery 只读注入，无备选 CEF 原生通路 | 本轮探针（2024.3.1 transforms/277a8a49…/lib-client.jar） |
| Q-6 | 前端 ToolCard 对未知工具通用渲染（tool name + argSummary + 输出文本）→ 新工具零前端改动即可显示 | `web/src/components/ToolCard.tsx:97-142` |
| Q-7 | agent-browser 端点鉴权面：token 走自定义 header（跨域浏览器带不出自定义头 → drive-by POST 天然被拒）+ Origin 校验（Q-4）+ token 与 bridge token 独立 | 设计承接 `BridgeAuth` 注释 |

## 技术上下文

- 栈与红线同 048 plan：Kotlin 为主、`PiAgentToolWindowFactory.java` 保持 Java、只用公开 `com.intellij.ui.jcef`/`org.cef` API、verifyPlugin INTERNAL_API_USAGES 红线。
- **前端零改动**（Q-6）：`pi_browser` 工具调用在聊天里走 ToolCard 通用渲染；P1 不碰 web/，e2e 基线不动。
- pi 扩展是**插件资源**（`resources/pi-browser/pi-browser.js`），照 `PiApprovalSupport.ensureExtensionInstalled` 模式每次启动提取到 `<config>/pi-agent/pi-browser.js`——升级自动传播、终端 pi 会话不受影响（不装进 `~/.pi/agent/extensions`）。

## Constitution Check

| 条款 | 涉及点 | 结论 |
|---|---|---|
| I 双端契约同步 | 零新桥接 RPC/事件——agent 通道是 LocalUiServer **HTTP 端点**（pi 进程 → IDE），不经前端 | 不涉及 |
| II 断言含几何与行为 | 选择器选项列表/顺序 = 纯函数单测；工具决策（token 拒绝/动作分发）纯函数单测 | 通过 |
| III 布局不依赖运行时假设 | 工具条追加一个按钮（固定 NORTH 行内）；popup 显示位置用鼠标实时坐标（非布局测量） | 通过 |
| IV 对 pi 写操作可回滚 | 新扩展文件写入 `<config>/pi-agent/`（插件自己的目录，与 032 pi-env 同模式），不写 `~/.pi/agent` | 通过 |
| V 桥接双向声明 | 端点是 pi 进程↔IDE 的新 HTTP 面：请求/响应 JSON 形状在 spec §五硬约束 + 本 plan §D2 固定 | 通过（声明于此） |
| VI 凭据零托管 | agent-browser token 是插件自生成本地能力 token，非用户凭据；读回内容不含凭据（只读快照） | 通过 |

## 设计决策

### D1 工具定义 `pi_browser`（spec Q1）
pi-browser 扩展注册单工具：
- `parameters` = TypeBox `Type.Object({ action: StringEnum(["open","read","reload"]), url: Type.Optional(Type.String()) })`；
- `promptSnippet`：一行说明（验证 web UI 用）；`promptGuidelines`：**必须指名工具**（pi 文档要求）——「Use pi_browser open after starting a dev server; read the returned title/text to confirm the page renders before reporting success」；
- `execute` → `fetch(PI_BROWSER_ENDPOINT, {method:"POST", headers:{X-Pi-Browser-Token: env}, body: JSON})`，超时 20s；env 缺失 → 返回明确失败文本（旧插件版本/无 IDE 场景）；
- 返回文本形状（模型与 ToolCard 双读）：`Pi browser: loaded <url> — "<title>" — text: <excerpt>` / `Pi browser: FAILED <url> — <reason>`；`details` 带结构化 JSON；
- `annotations.readOnlyHint=false / openWorldHint=true`（open 有网络副作用）→ ask 审批模式天然覆盖，yolo 默认直行，不新增设置。

### D2 IDE 端点 `POST /agent-browser`（硬约束 10）
`LocalUiServer` 新 context 路径 `/agent-browser`：
- 请求 `{action, url?}`，header `X-Pi-Browser-Token`；per-project token 登记表（`ConcurrentHashMap<token, Project>`，模式同 `projectTokens`）；
- 鉴权顺序：Origin 非 null 且非自有 → 403（Q-4 语义复用）；token 无效 → 403；**端点零日志**（URL 不进 idea.log，硬约束 8）；
- 分发：`open` → `PiBrowserManager(project).open(url)` + 等待 LOADED/FAILED（≤15s 轮询 kernel.state）→ 返回 `{ok, state, url, title, excerpt?}`；`read` → 当前内核快照（无页签 → 明确失败）；`reload` → kernel.reload + 同 open 等待；
- 响应统一 JSON `{ok, state, url, title, excerpt}`；失败 `{ok:false, reason}`；
- **bridge-token URL 拒绝**：open/reload 的 url 含本项目 bridge token → 403 + reason（硬约束 1，纯函数单测）。

### D3 孵化接线（Q-2 先例）
`PiProcessManager.start` 的 extensions 列表加 `PiBrowserToolSupport.ensureExtensionInstalled()`；环境变量 `PI_BROWSER_ENDPOINT=http://127.0.0.1:<port>/agent-browser` + `PI_BROWSER_TOKEN=<per-project token>`。token 注册：`LocalUiServer` 暴露 `agentBrowserTokenFor(project)`（生成 128-bit token 并登记）。多 project 天然隔离（每 project 拿自己的 token）。

### D4 读回快照（Q-5，唯一通路）
`PiBrowserKernel` 新增：
- 内部缓存 `currentTitle`（display handler 已回显，顺手存）；
- `readPage(timeoutMs): CompletableFuture<ReadResult>`：`JBCefJSQuery.create(browser)` + `executeJavaScript` 注入**只读**快照脚本——
  ```js
  (function(){ return JSON.stringify({ title: document.title, url: location.href, ready: document.readyState, text: (document.body && document.body.innerText || '').slice(0, 3000) }) })()
  ```
  经 jsQuery 回调带回；CompletableFuture.orTimeout(10s) 兜底（CSP/挂页不悬死，硬约束 9）；文本剥控制字符 + 截断；**零日志**；
- 快照注入前校验：browser 未创建 / state=CRASHED → 直接失败结果，不注入；
- 声明：此注入即 spec §五硬约束 1 的修订面——只读、无 token、仅 agent 动作触发。

### D5 链接选择器（spec US1/Q3）
`PiAgentPanel.routeExternal` 的 `LinkRoute.AskUser` 分支从 `Messages.showYesNoDialog` 换成 JBPopup：
- 选项列表 = 纯函数 `LinkRouting.linkOptions(): List<LinkOption>`（SYSTEM_BROWSER / EMBEDDED / COPY，顺序锁死 spec Q3），单测锁顺序与数量；
- `PopupChooserBuilder`（`createPopupChooserBuilder` 公开 API）+ 标题走 bundle；显示位置 = `MouseInfo.getPointerInfo()` 屏幕坐标 `RelativePoint`（点击现场）；鼠标不可得（罕见）→ 面板中心兜底；
- 执行：SYSTEM → `BrowserUtil.browse`（037 语义不变）；EMBEDDED → `PiBrowserManager.open`；COPY → `CopyPasteManager.setContents(StringSelection)`；Esc/点外 = 什么都不做；
- SYSTEM/EMBEDDED 两态执行体逐字不动（默认零变化）。

### D6 设置文案（spec US2）
`settings.linkTarget.ask` 文案更新（如「打开时询问去向 / Ask where to open」）；下拉其余两态文案不动；双语字典成对。

### D7 工具条外开按钮（spec US5）
`BrowserPanel` navRow 追加按钮（AllIcons 族 icon，编译期定名，候选 `Actions.MoveToTopRight`/`General.ExternalTools`），tooltip bundle，行为 `BrowserUtil.browse(kernel.currentUrl())`；位置：刷新钮之后、地址栏之前。

### D8 agent 动作到内核的路径
`BrowserPanel` 新增公开方法 `agentOpen(url, done)` / `agentRead(done)` / `agentReload(done)`（转调 kernel + 回到 HTTP executor 线程回包）；`PiBrowserManager` 新增 `withPanel(project, (BrowserPanel)->Unit)` 复用 doOpen 的页签查找逻辑。**绝不新建第二个 windowed 内核**（P-7）；编辑器载体（OSR）不受 agent 驱动（单页签语义，spec 声明）。

## 触及文件

| 文件 | 改动 |
|---|---|
| `src/main/resources/pi-browser/pi-browser.js` | 新：D1 工具注册 + HTTP 调用 |
| `src/main/kotlin/dev/pi/agent/process/PiBrowserToolSupport.kt` | 新：D3 提取安装 + endpoint/token 常量 |
| `src/main/kotlin/dev/pi/agent/process/PiProcessManager.kt` | 改：extensions 列表 + 两个 env |
| `src/main/kotlin/dev/pi/agent/ui/LocalUiServer.kt` | 改：D2 端点 + token 登记表 |
| `src/main/kotlin/dev/pi/agent/browser/PiBrowserKernel.kt` | 改：D4 currentTitle + readPage |
| `src/main/kotlin/dev/pi/agent/browser/BrowserPanel.kt` | 改：D7 按钮 + D8 三个 agent 方法 |
| `src/main/kotlin/dev/pi/agent/browser/PiBrowserManager.kt` | 改：D8 withPanel |
| `src/main/kotlin/dev/pi/agent/browser/LinkRouting.kt` | 改：D5 linkOptions 纯函数 |
| `src/main/kotlin/dev/pi/agent/toolwindow/PiAgentPanel.kt` | 改：D5 AskUser 分支换 popup |
| `src/main/resources/messages/PiAgentBundle*.properties` | 改：D5/D6/D7 键 |
| `src/test/kotlin/dev/pi/agent/browser/LinkRoutingTest.kt` 等 | 改/新：linkOptions/bridge-token 拒绝/请求解析单测 |
| `MANUAL_TEST.md` / `changelog.d/` / `specs/049-*/` | 收尾 |

## 实现顺序

```
阶段 A 链接选择器（低风险先行，UI 可独立真机验）：
  A1 linkOptions 纯函数 + 单测 → A2 popup 接线 + 文案 → A3 真机验证（ASK 三选项 + 默认态回归）
阶段 B agent 融合（先 IDE 面后 pi 面，可分层验证）：
  B1 kernel readPage + 单测 → B2 端点 + token（curl 可测）→ B3 孵化接线 + 扩展 → B4 pi rpc 离线冒烟（工具注册可见）→ B5 真机完整链路
阶段 C 收尾：
  C1 外开按钮 + 文案 → C2 全量回归 → C3 changelog/run-report/MANUAL_TEST
```

不可颠倒：B2（端点 curl 可测）先于 B3（pi 面）——HTTP 面问题与扩展面问题必须可区分；A 与 B 可穿插提交但真机验证各成一段。

## 测试策略

**Kotlin 单测**：`linkOptions` 数量/顺序/映射；bridge-token URL 拒绝（open/read/reload 全 action）；agent-browser 请求 JSON 解析与未知 action 拒绝；快照文本清洗（控制字符/截断）；既有 LinkRouting 三态回归不动。
**扩展冒烟**：`node --check pi-browser.js`；`pi --mode rpc` 起进程后 `pi.getAllTools()` 含 `pi_browser`（离线验证工具注册）。
**真机**（MANUAL_TEST.md 049 段，全真实键鼠）：
1. ASK 态点击聊天外链 → 选择器三选项，逐项行为正确；Esc 关闭无动作。
2. 默认态回归：点击外链无弹层直接系统浏览器。
3. 复制项：剪贴板内容 = 完整 URL。
4. 工具条外开按钮：系统浏览器打开当前页。
5. 完整 agent 链路：聊天输入「起本地服务器并用内置浏览器验证」→ AI 起 server → `pi_browser` open → 浏览器页签前台打开加载 → AI 读回标题/文本 → 汇报成功（截图留证）。
6. 反向：AI 对不存在端口 open → 读回 failed → 如实汇报。
7. 回归：pi 实例页签/浏览器页签互不干扰；chat 面板零新注入（IDEA 日志无 agent-browser 相关明文 URL）。

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 页面 CSP 拦 executeJavaScript 注入 | 读回超时/失败 | orTimeout(10s) + 明确失败 reason（不悬死）；模型可退化为让用户自查 |
| JBCefJSQuery handler 泄漏（每次 read 新建） | 内存/回调累积 | read 用完 dispose jsQuery；同内核串行（执行期复用单例 query，dispose 挂 Disposer） |
| 鼠标坐标 popup 在多屏/DPI 下偏移 | 选择器跑位 | RelativePoint 屏幕坐标是平台口径；不可得兜底面板中心 |
| pi 旧版本无 registerTool | 工具不生效 | 扩展内 `typeof pi.registerTool === "function"` 防御 + 日志 debug；失败静默降级（agent 无此工具而已） |
| 长轮询期间 EDT 阻塞 | IDE 卡顿 | 端点等待在 HTTP executor 线程轮询 kernel.state（volatile 读），不碰 EDT |
| agent 开非 loopback URL 引 cookie 顾虑 | 隐私 | spec Q2 已声明口径：不承载登录态文档化 + 前台可见；如需限制另立规格 |

# Implementation Plan: 048 内置浏览器 P0（预览基座）

**Branch**: `release/0.5.10` | **Date**: 2026-11-18 | **Spec**: [spec.md](./spec.md)
**Tasks**: [tasks.md](./tasks.md)

## 摘要

把 042 的 P0 层落成可交付实现：**内核层**（与载体无关的 `PiBrowserKernel`，封装 windowed `JBCefBrowser` + 弹窗/下载/证书/崩溃 handler 套装 + 状态机）→ **C1 工具窗页签**（地址栏 Swing 工具条，走 019 multi-Content 基建但不占 pi 实例注册表）→ **入口接线**（外链三态设置 + 本地 HTML 一次性预览路由 + 导出预览）→ **D 轨编辑器呈现**（可滑出）。全部技术通路已在真机/沙盒探针实证（含反例），实现是「按实证结论组装」，不是探索性编码。

## 0. 探针证据基线（plan 的每条决策都有编号出处）

真机探针（裸 CDP 对真机 WebStorm CEF 144 + 探针插件对沙盒 IC-2024.3.1 CEF 122）已完成并留下结论报告（完整报告已入库：`specs/042-in-app-browser/probe-report-2026-11-17.md`，原始工件在 `probe-evidence/`；关键结论已摘入本 plan 各决策条目）。要点：

| # | 结论 | 出处 |
|---|---|---|
| P-1 | 无 handler 时 `target=_blank` 真实点击**弹独立 CEF 窗** | round-4 真实点击 |
| P-2 | 弹窗拦截点 = `CefLifeSpanHandler.onBeforePopup`（RequestHandler 无此回调、`onOpenURLFromTab` 不承接）；返回 true 取消 + 主动 `loadURL` 接续 | 插件 v3/v6 |
| P-3 | 证书放行唯一通路 = `CefRequestHandler.onCertificateError(..., CefSSLInfo, CefCallback)` + `callback.Continue()`（大写 C）；CDP 层不能放行；默认渲染 interstitial 错误页（非白屏） | 插件 v4 + round-2/3 |
| P-4 | 下载必须 `CefDownloadHandler`；`Continue(原生反斜杠路径, showDialog=false)` 落盘成功；**正斜杠静默滞留**；无 handler 时下载凭空消失 | round-1/3 + 插件 v4 |
| P-5 | cookie jar 全局共享；`CefRequestContext.createContext(handler)` **不隔离**（CEF 122） | 插件 v4 双证实 |
| P-6 | `JBCefHealthMonitor` 在 243 **不存在**（2025.x+ 才有）；崩溃判定用 `onRenderProcessTerminated(browser, TerminationStatus)` | 插件 API dump |
| P-7 | windowed 模式 CEF 原生 HWND 会错位压住 Swing 组件（地址栏点击被吃）；多原生实例加剧；resize/最大化可触发重排缓解 | v5 用户试用 + HWND dump |
| P-8 | `CefDisplayHandler.onAddressChange/onTitleChange` 回显可用；`CefFocusHandler.onTakeFocus` 是 **void**（122 签名）；`setEnableOpenDevToolsMenuItem` 存在（P1 用） | 插件 v5/v6 |
| P-9 | 本机窗口化 JCEF 有 stale-frame 旧帧残留；仓库 0.5.4 `wasResized` 反射 workaround 有效 | 0.5.4 + v5 截图 |
| P-10 | 真实点击自动化要用 CDP `Input.dispatchMouseEvent` + 剪贴板粘贴（SendKeys 被系统中文 IME 污染） | round-4/v5 |
| P-11 | 剪贴板中文在 Swing JTextField 渲染完美；地址栏端到端（聚焦→粘贴→Go→回显→加载）真机通过 | v5/v6 |
| P-12 | 无背景色页面透出 IDE 主题底色（平台主题融合），真实站点自带背景不受影响 | 用户截图 + 机制分析 |

## 技术上下文

- **栈**：宿主 Kotlin + 一个 Java 文件（`PiAgentToolWindowFactory` 必须保持 Java——019 既有约束）；前端零改动（P0 不碰 web）。
- **API 面**：只用公开 `com.intellij.ui.jcef`（JBCefBrowser/JBCefBrowserBuilder/JBCefClient）与 `org.cef`（handler/callback）；`build.gradle.kts` 已声明 JCEF 依赖，`verifyPlugin` 红线（INTERNAL_API_USAGES）不得触碰。
- **载体**：Pi Agent 工具窗 multi-Content（019 已实现 `createInstanceContent` + `CloseGuard`）；浏览器是**第二类 Content**，复用建 Content 的模式但**不进** `PiProcessManager` 注册表。
- **约束**：默认不开浏览器页签时既有行为零变化；无新桥接 RPC；新增用户可见文案双语字典；`PI_IDE_E2E` e2e 不覆盖 JCEF 面（真机清单补）。

## Constitution Check

| 条款 | 涉及点 | 结论 |
|---|---|---|
| I 双端契约同步 | P0 零新 RPC/事件（预览路由是 LocalUiServer HTTP 层，非桥接协议） | 不涉及 |
| II 断言含几何与行为 | kernel 决策逻辑纯函数单测 + 真机清单；无自绘复杂布局，几何断言不适用 | 通过 |
| III 布局不依赖运行时假设 | 地址栏工具条固定 BorderLayout.NORTH，无运行时测量 | 通过 |
| IV 对 pi 写操作可回滚 | 不写 `~/.pi/agent`；预览临时文件在插件 temp 目录，会话级清理 | 不涉及/通过 |
| V 桥接双向声明 | 零新桥接方法 | 通过 |
| VI 凭据零托管 | 内置浏览器不碰 auth；cookie 共享风险按「共享」模型文档化 + 登录态 Non-goal | 通过 |

## 现状与代码定位（已核对）

| 位置 | 现状 | 048 会怎样 |
|---|---|---|
| `PiAgentToolWindowFactory.java:53-72` | `createInstanceContent(project, toolWindow, instanceId)` 建 pi 实例 Content + `CloseGuard` 监听 | 新增 `createBrowserContent`（同模式第二类 Content）；`contentRemoved` 里区分实例/浏览器（浏览器直接放行不弹确认） |
| `PiAgentPanel.kt:79-92` | `linkHandler.onBeforeBrowse`：非 loopback → `BrowserUtil.browse` + 取消导航 | 按设置路由：system（现状）/ embedded → `PiBrowserManager.open(url)` / ask → 确认框；决策逻辑抽纯函数 |
| `PiAgentPanel.kt:453-480` | `repaintBrowser()`（反射 `wasResized`） | 提取为 `browser/JcefFrameRepaint.kt` 共享 util，两处复用（零回归改写） |
| `PiAgentPanel.kt:376-451` | 健康轮询 + crash-loop 熔断（`rebuildStamps` 60s 窗 2 次） | kernel 复用同款熔断形态，但触发源是 `onRenderProcessTerminated`/`onLoadError`（P-6：无长轮询心跳可用） |
| `settings/PiAgentSettings.kt` | PropertiesComponent，键 `dev.pi.agent.*` | 新键 `dev.pi.agent.linkTarget`（system/embedded/ask，默认 system） |
| `ui/LocalUiServer.kt` | `/` 单 context 分发：`/webui` 静态 + `/bridge*`（token+Origin 鉴权） | 新增 `/preview/<oneTimeToken>`：只读回吐插件 temp 目录下的预览文件；一次性 token、短时效；**不经 bridge 鉴权但不可枚举**（随机 128-bit token） |
| `bridge/BridgeService.kt:678-699` | `SessionHtmlExporter.render(sessionFile)` → `target.writeText`（用户选定路径） | 导出成功通知追加「预览」action：渲染结果同步写一份到插件 temp + 一次性 token → `PiBrowserManager.open(previewUrl)` |
| `specs/019-toolwindow-multi-instance/plan.md` D7-D10 | Content 命名/关闭确认/进行中标记 | 浏览器 Content 命名独立（`浏览器`/`Browser`）、关闭无确认、无进行中标记（加载态在页面工具条内） |

## 设计决策

### D1 内核层 `PiBrowserKernel`（与载体无关）
`dev.pi.agent.browser.PiBrowserKernel(project)`：懒创建（首次 `ensureLoaded(url)`）windowed `JBCefBrowser`；持有 handler 套装；暴露 `loadURL/reload/back/forward/canGoBack/canGoForward`（导航方法以 `CefBrowser` 编译期实际 API 为准，探针 dump 未覆盖的以编译器为准）与状态监听 `PiBrowserState`（IDLE/LOADING/LOADED/FAILED/CRASHED）。载体（工具窗面板 / 编辑器）只消费 kernel。**Disposer 全链**：kernel 注册到所属 Content/Editor 的 Disposable。

### D2 渲染 windowed；背景跟随主题
windowed（官方交互型默认 + 本机 stale-frame 只在 windowed 出现但 workaround 成熟）；**同一工具窗仅此一个 windowed 实例**（P-7）。页面底色跟随 `JBCefBrowser` 默认主题融合（P-12），spec Q2。

### D3 弹窗：拦截 + 同视口接续（spec US5）
`CefLifeSpanHandler.onBeforePopup` → log（脱敏）→ `kernel.loadURL(targetUrl)` → return true。targetUrl 空白时仅取消不导航。**禁止静默丢弃**（真机教训）。

### D4 证书：默认严格 + 043 hook
`CefRequestHandler.onCertificateError` → `PiCertPolicy` 接口（v1 唯一实现 = StrictPolicy：return false，CEF 渲染 interstitial 错误页，P-3）。043 实施时替换/组合策略，kernel 不改。

### D5 下载：显式落盘 + 通知（spec US6）
`CefDownloadHandler.onBeforeDownload` → 文件名清洗（去路径分隔符、防穿越、重名追加序号——纯函数）→ `Continue(下载目录\清洗名, showDialog=false)`（**原生反斜杠**，P-4）；`onDownloadUpdated` 完成时发通知（notificationGroup `Pi Agent`，成功/失败各一条文案）。

### D6 外链三态设置（spec US4）
`PiAgentSettings.linkTarget(): LinkTarget`（SYSTEM 默认 / EMBEDDED / ASK），PropertiesComponent 键 `dev.pi.agent.linkTarget`；`PiAgentSettingsConfigurable` 加下拉。路由决策抽纯函数 `routeExternalLink(url, target): Decision`（单测锁死：默认态 = 系统浏览器，与 037 语义逐字一致）。

### D7 载体 C1：浏览器 Content（spec US8）
`PiAgentToolWindowFactory.createBrowserContent`（Java）照 `createInstanceContent` 模式建 Content：displayName 走 `PiAgentBundle`（`浏览器`/`Browser`）、可关闭、`Disposer.register(content, kernelPanel)`。**不进 PiProcessManager**：无实例号、无事件桶、无 pi 进程；`CloseGuard.contentRemoved` 对浏览器 Content 直接放行（selection 区分：Content 的 description/userData 标记 kind）。多 project 各自独立（LocalUiServer 按 project 隔离的既有模式）。

### D8 崩溃判定与自愈（spec US7）
`onRenderProcessTerminated`（P-6）与主 frame `onLoadError`（排除 ERR_ABORTED）→ FAILED/CRASHED → 展示 `PiUiErrorPanel` 复用形态（标题/原因/重载）→ 重载 = dispose 旧 kernel 重建（懒创建语义不变）；熔断沿用 60s 窗 2 次上限，超限常驻错误卡。

### D9 旧帧 workaround 共享化（P-9）
`PiAgentPanel.repaintBrowser` 的反射 `wasResized` 逻辑原样提取为 `JcefFrameRepaint.forceRepaint(browser, component)`；kernel 在 LOADED 转换与地址变更时调用；`PiAgentPanel` 改为调用 util（行为零变化，单测/真机回归锁）。

### D10 本地 HTML 一次性预览路由（spec US3；硬约束 2）
`LocalUiServer` 新增 `/preview/<token>`：只读回吐**插件管理 temp 目录**下登记的预览文件；`PiBrowserPreviews`（application 级）登记 {token → path, createdAt}，128-bit 随机 token、5 分钟时效、单次有效（取后即焚）、目录逃逸拒绝。入口两处：HTML 文件右键 action（拷贝到 temp + 登记 + open）与导出完成通知的「预览」action。**token 与桥接 token 无关、不进日志**。

### D11 日志卫生（硬约束 8）
`browser/LogSafe.kt`：URL 只记 host+path（strip query/fragment）、console 一律 debug 级、异常消息截断 200 字符。kernel 全部日志走它；单测锁「query 不落日志」。

### D12 编辑器呈现（D 轨，spec US9，可滑出）
`FileEditorProvider` + `LightVirtualFile`（name 带 `pi-preview` 标记）：provider 按 userData 识别自己发起的预览文件，内嵌 kernel 面板；与工具窗形态**不共享** kernel 实例（两套导航状态，spec 已声明）。实现路径参照 041 已验证的 LightVirtualFile 用法（零新依赖）。

## 触及文件

| 文件 | 改动 |
|---|---|
| `src/main/kotlin/dev/pi/agent/browser/PiBrowserState.kt` | 新：状态枚举 + 转换表（纯函数，单测） |
| `src/main/kotlin/dev/pi/agent/browser/PiBrowserKernel.kt` | 新：D1/D3/D4/D5/D8 主体 |
| `src/main/kotlin/dev/pi/agent/browser/PiBrowserHandlers.kt` | 新：五个 handler（popup/download/cert/load+crash/focus+display） |
| `src/main/kotlin/dev/pi/agent/browser/PiCertPolicy.kt` | 新：D4 接口 + StrictPolicy（043 hook） |
| `src/main/kotlin/dev/pi/agent/browser/JcefFrameRepaint.kt` | 新：D9 wasResized util（从 PiAgentPanel 提取） |
| `src/main/kotlin/dev/pi/agent/browser/LogSafe.kt` | 新：D11 脱敏 util |
| `src/main/kotlin/dev/pi/agent/browser/PiBrowserManager.kt` | 新：project service（D7）：open(url)/ensureContent/lazy kernel |
| `src/main/kotlin/dev/pi/agent/browser/BrowserPanel.kt` | 新：地址栏+按钮+回显 Swing 面板（Kotlin，非工厂） |
| `src/main/kotlin/dev/pi/agent/browser/UrlNormalizer.kt` | 新：地址栏规范化 + 下载文件名清洗（纯函数，单测） |
| `src/main/kotlin/dev/pi/agent/browser/PiBrowserPreviews.kt` | 新：D10 一次性预览登记表（纯逻辑单测） |
| `src/main/kotlin/dev/pi/agent/browser/OpenInPiBrowserAction.kt` | 新：HTML 文件右键 action |
| `src/main/java/dev/pi/agent/toolwindow/PiAgentToolWindowFactory.java` | 改：`createBrowserContent` + CloseGuard kind 区分 |
| `src/main/kotlin/dev/pi/agent/toolwindow/PiAgentPanel.kt` | 改：linkHandler 路由（D6）+ repaintBrowser 换 util（D9） |
| `src/main/kotlin/dev/pi/agent/settings/PiAgentSettings.kt` | 改：linkTarget 三态 |
| `src/main/kotlin/dev/pi/agent/settings/PiAgentSettingsConfigurable.kt` | 改：设置项 UI |
| `src/main/kotlin/dev/pi/agent/ui/LocalUiServer.kt` | 改：`/preview/<token>` 路由 |
| `src/main/kotlin/dev/pi/agent/bridge/BridgeService.kt` | 改：导出通知加「预览」action |
| `src/main/resources/META-INF/plugin.xml` | 改：action 注册 + （如需）projectService |
| `src/main/resources/messages/PiAgentBundle*.properties` | 改：双语字典 |
| `src/test/kotlin/dev/pi/agent/browser/*Test.kt` | 新：状态机/路由决策/规范化/清洗/预览登记/脱敏 单测 |
| `MANUAL_TEST.md` / `changelog.d/` | 收尾清单与碎片 |

## 实现顺序

```
阶段 1 内核层（T001–T008）：纯函数先行单测，kernel 真机冒烟
阶段 2 工具窗载体（T009–T015）：Content + 工具条 + 设置 + 路由
阶段 3 本地预览（T016–T018）：/preview 路由 + 两入口
阶段 4 编辑器呈现（T019–T020）：D 轨，可滑出
阶段 5 收尾（T021–T024）：i18n/基线/MANUAL_TEST/CHANGELOG
```

不可颠倒：**阶段 1 全绿（纯函数单测 + 真机 kernel 冒烟）才进阶段 2**（载体问题与内核问题必须可区分）；T007 util 提取必须先于 kernel 使用它（同一 workaround 两份实现是回归源）。

## 测试策略

**Kotlin 单测**（JCEF 不可实例化 → 只测纯函数与状态机）：
- 状态转换全表；`routeExternalLink` 三态 × URL 种类；UrlNormalizer（补 scheme、保留 localhost、拒绝空白）；下载文件名清洗（穿越/非法字符/重名）；PiBrowserPreviews（单次有效/过期/逃逸拒绝）；LogSafe（query 不落日志）。

**真机清单**（MANUAL_TEST.md 新段；自动化用 `scripts/e2e-ide-real.mjs` 同款 runIde + CDP 通路，探针资产 `D:\code\probe-042` 可复用）：
1. 地址栏手输（真人 IME）+ 粘贴 + Go/Enter；页内跳转回显。
2. `target=_blank` 链接：无新窗口 + 同视口导航（对照探针 P-1 反例）。
3. 下载：文件落盘字节数一致 + 通知。
4. 自签 https：interstitial 可见（043 前默认拒绝）。
5. 杀渲染进程 → 重建 ≤ 熔断 → 常驻错误卡可手动恢复。
6. 浏览器页签与两个 Pi 实例并存：互不干扰；关浏览器页签无确认且 pi 实例无感。
7. 外链三态逐一验证；默认态与 0.5.9 之前行为一致。
8. HTML 右键预览 + 导出通知预览；token 二次访问失效。
9. 无 JCEF IDE（可用 `-Dide.browser.jcef.headless.enabled=false` 模拟）入口降级不崩溃。
10. RDP/远程串流环境目验（本机即此类环境，帧率上限已知 ~30fps，不作为 OSR 判据）。

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| HWND 错位压住工具条（P-7）在真机重现 | 地址栏点不进 | 单一 windowed 实例；工具条放 Content 顶部（HWND 归属浏览器面板内部）；错位复现时 resize 重排手段写进错误卡提示 |
| `CefBrowser` 导航方法名与假设不符 | 编译失败 | 编译期即暴露，按真实 API 调整（探针 dump 未覆盖处以编译器为准） |
| LocalUiServer preview 路由被滥用 | 任意本地进程读 temp 文件 | 128-bit 一次性 token + 5 分钟时效 + 仅 temp 目录白名单 + 不落日志 |
| 导出通知预览的文件与用户另存路径双份 | 磁盘冗余 | temp 副本会话级清理（IV 条款回滚） |
| 编辑器 provider 与平台 HTML 预览冲突 | 打开方式歧义 | 仅对 userData 标记文件注册；不抢平台 HTML 编辑器 |

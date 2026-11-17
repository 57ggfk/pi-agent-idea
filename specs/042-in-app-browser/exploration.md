# 内置浏览器（In-IDE Browser）技术方案探索

> **状态：已并入 042（2026-11-17）**。原稿 2026-11-13 写于独立分支（占位编号 031，该号后被
> `031-compaction-i18n` 占用）；rebase 到 `release/0.5.10` 后按「以新版本定的需求为准」并入
> 042 目录，成为本文件。**需求与范围以 [042 方向性 spec](./spec.md)（用户 2026-11-16 拍板 Q1–Q4）
> 与 [043 协议与证书策略](../043-browser-protocol-cert/spec.md) 为准**；本稿提供技术方案基座：
> 安全硬约束、渲染/生命周期决策点、探针补充与失败模式预案。不含 plan/tasks；
> 042 路线图按能力分层（P0–P3）逐条另立可实施 spec 时引用本稿。

## 1. 背景：从「外链进系统浏览器」到 042 的需求升级

聊天回复里的 markdown 链接在 web 侧就是普通 `<a>`，没有任何点击拦截；真正决定去向的是 CEF 层：

- [`PiAgentPanel.kt:79-92`](../../src/main/kotlin/dev/pi/agent/toolwindow/PiAgentPanel.kt) `linkHandler.onBeforeBrowse`：
  URL 不是 `http://127.0.0.1:*` / `http://localhost:*` → `BrowserUtil.browse(url)` 交系统浏览器，并 `return true` 取消 IDE 内导航。注释原话：「Navigations away from the UI server (markdown links) are handed to the system browser so they can never hijack the SPA.」
- `LocalUiServer` 只绑 loopback（`LocalUiServer.kt:49-52`），一切外部 URL 都到不了本插件的服务。

**这是刻意的安全设计**：聊天面板的浏览器实例承载着带 `?token=` 的 SPA（`LocalUiServer.kt:67-73`），token + Origin 校验是唯一的 agent 控制权边界。任何「让主面板导航去别处」的做法都会破坏这条边界（见 §3 方案 B）。

**042 的升级（2026-11-16）**：需求从「被动接收链接的只读视口」升级为「预览 + 开发交互的内置浏览器」——
本地 HTML 预览 + 通用浏览器页签 + 外链不跳出 IDE 三者都要，地址栏可编辑，工具窗页签 + 编辑器双形态承载，
后续 DevTools 与页面批注回流会话（P1/P2 分层）。本稿原按只读视口写的默认口径，凡与 042 冲突处**一律以 042 为准**（逐条映射见 §9）；本稿的价值在 042 未覆盖的技术面：隔离架构、安全硬约束、失败模式与探针补充。

## 2. 现状架构事实（已逐条核对）

| 事实 | 位置 | 对方案的影响 |
|---|---|---|
| 每 project 一个 `PiAgentPanel` = 一个 `JBCefBrowser()`（无参构造，默认 windowed 渲染） | `PiAgentPanel.kt:327` | 渲染模式、handler 挂法已有本仓先例可抄 |
| 门禁 `JBCefApp.isSupported()` + 三级失败卡（服务器起不来 / JCEF 不支持 / 加载失败），无 JCEF 时降级提示 | `PiAgentPanel.kt:271-352`、`PiAgentToolWindowFactory.java`（按类名探测，不触碰类型） | 内置浏览器沿用同一门禁与降级形态 |
| 健康自愈：30s Swing timer 查桥接静默（90s 阈值），60s 窗口内重建 >2 次熔断进错误卡 | `PiAgentPanel.kt:376-451` | 内置浏览器没有「长轮询」这种现成心跳，需另定崩溃判定（§5.3） |
| 0.5.4 起的 stale-frame workaround：反射调 `CefBrowser_N.wasResized` 强制重绘 | `PiAgentPanel.kt:453-480` | 本机环境对 JCEF 帧滞后敏感 → 渲染模式选型倾向 windowed（§3） |
| handler 四件套 + AWT drop 旁听，dispose 时逐个 `removeXxxHandler` | `PiAgentPanel.kt:482-492` | 释放纪律的现成模板 |
| token 鉴权靠 URL query + `X-Pi-Token` header + Origin 白名单 | `LocalUiServer.kt:67-89` | **内置浏览器实例绝不能加载带 token 的 URL**（§6） |
| **019 已实现**（0.5.9，`7147df2`）：multi-Content 工具窗、每 Content 独立 JBCefBrowser + pi 进程 + 事件按实例分桶 | `specs/019-toolwindow-multi-instance/`、`process/PiProcessManager.kt` | 浏览器页签可直接复用 multi-Content 基建；实例计数与 token 分桶须隔离（§7） |
| JCEF 依赖是 optional `<depends>com.intellij.modules.jcef</depends>`（2026.2 插件化迁移已适配） | `plugin.xml:18` | 载体若新增组件也要保持 optional 模块纪律 |
| `sinceBuild = "233"`（2023.3），验证基线 2024.3.1（243）；`INTERNAL_API_USAGES` 是 verify 失败级别 | `build.gradle.kts:380,409` | 平台 HTML 预览类内部 API 不可直接引用（§3 C4） |
| 工具窗工厂必须写 Java（Kotlin 会生成 jvm-default 前转方法，被 verifier 记为 internal API usage） | `PiAgentToolWindowFactory.java` 类注释 | 新增载体工厂沿用 Java |
| 042/043 已在 `release/0.5.10` 定稿方向与证书面（2026-11-16） | `specs/042-in-app-browser/spec.md`、`specs/043-browser-protocol-cert/spec.md` | 需求口径以上两份为准；043 已明确「内置浏览器是第二个 JBCefBrowser，请求处理链独立挂接」 |

平台事实（jcef-knowledge 知识库，2026-11 磁盘取证 + 源码双验证）：

- JCEF 版本由 IDE 发布火车决定，插件无选择权；2026.2 起 JCEF 是独立捆绑插件 `com.intellij.modules.jcef`。
- **平台没有通用「浏览器工具窗」**：最接近的是 HTML 文件的 IDE 内嵌预览（`OpenHtmlInEmbeddedBrowser` / `JcefHtmlEditorProvider`）与 Web Preview（`WebPreviewEditorProvider`，面向项目内 HTML / dev server），都不是任意 URL 的通用浏览器（official-usage-map §1）——042 的「编辑器呈现」只能自建 FileEditorProvider，只抄形态、不引内部 API。
- 官方选型口诀：**交互型/动效内容 → windowed；被 Swing 浮层覆盖的文档类 → OSR**；Markdown 预览默认 OSR、What's New / SVG 查看器默认 windowed（rendering-modes §2）。
- 每多一个 `JBCefBrowser` = 多一整套 Chromium 子进程（dev-checklist §2、third-party-failure-modes FM-5）→ 实例复用与销毁时机是核心成本变量。
- 第三方 JCEF 面板的失败模式目录 FM-1～FM-6（JSQuery 池耗尽 / 生命周期竞态 / 环境矩阵 / 重叠焦点 / 资源泄漏 / 版本漂移）全部适用于本 feature，但本插件对 FM-2/FM-3 已有实战模板（健康自愈 + 错误卡）。

## 3. 方案空间

### A. SPA 内 iframe（在 React 应用里嵌 `<iframe>`）——否决

在聊天 SPA 的某个 tab 里 iframe 目标 URL。否决理由三条，每条都独立致命：

1. **嵌不进去**：主流站点 `X-Frame-Options: DENY/SAMEORIGIN` 或 CSP `frame-ancestors` 直接拒绝被 iframe，GitHub/Google/文档站几乎全军覆没。做出来的功能对「点开一条 pi 给的链接」这个最主力的场景无效。
2. **同源共存的暴露面**：iframe 页面 JS 与持有 token 的 SPA 同页运行。虽然跨源 iframe 拿不到父页变量，但把不可信内容引进带桥接的页面本身就是扩大攻击面，与 §6 的隔离原则相反。
3. **CSP 要放宽**才能容纳任意源，等价于在桥接页面上开洞。

官方对「agent 富 UI」的用法（Air/GenUI：专用模块 + 沙箱页 + 自有资产协议）恰恰说明：即使官方也不把不可信远程站点混进自己的桥接页面。

### B. 复用聊天面板的浏览器实例导航过去——否决

让主面板直接 `loadURL(外部地址)`。

- SPA 会被销毁重载，聊天 UI 状态（滚动位置、输入框草稿、打开的面板）全丢；`linkHandler` 的存在就是为了「can never hijack the SPA」，这是入库时写明的边界。
- 如果为了让外部页面能回去而保留 token：token 在 URL query 上（`LocalUiServer.kt:67-73`），被导航页面 JS 读 `location` 即得 token，等于**把 agent 控制权交给任意网页**。绝对否决，这条应作为硬约束写进未来 spec 的 Non-goal。

### C. 独立 `JBCefBrowser` 实例（推荐方向，042 已沿此路线）——剩下的决策是「载体」

独立实例意味着：无 JSQuery 注入、无 token、无 drop/drag handler、不注册 `BridgeService` 任何东西——一个「与桥接物理隔离的 Chromium 视口」。043 也已按此口径写明：「内置浏览器是 042 要新建的第二个 JBCefBrowser，其请求处理链需独立挂接，不受现有 linkHandler 影响」。成本是每实例一整套 Chromium 子进程（FM-5），因此必须配懒创建 + 关闭/空闲销毁（§5）。

载体四选项（**042 Q3 已拍板：工具窗页签 + 编辑器呈现双形态都要**；019 已实现使 C1 路径现成）：

| 载体 | 形态 | 优点 | 缺点 / 风险 | 评估 |
|---|---|---|---|---|
| C1 Pi Agent 工具窗新 Content 标签 | 与聊天同窗，标签切换 | 019 的 multi-Content 基建现成（建 Content / 关闭确认 / 命名 / 进行中标记全套已验证） | **必须隔离**：不占 pi 实例计数（D8 上限语义）、不进实例分桶、页面无 token（§7） | **P0 主载体**（042 拍板） |
| C3 编辑器区伪文件标签（FileEditorProvider + 轻量 VirtualFile） | 像 HTML 文件预览那样出现在编辑器 tab 区 | 占主工作区、多标签由编辑器 tab 天然管理、对「预览 dev server / 本地 HTML」的隐喻最贴切；平台先例是 `JcefHtmlEditorProvider` / `WebPreviewEditorProvider`（只抄形态） | 实现量最大：伪文件体系（LightVirtualFile）、provider 注册、与 verifier 的 INTERNAL_API_USAGES 红线要绕 | **P0 第二形态**（042 拍板「如果可以的话最好是这样」） |
| C2 独立工具窗（如 `Pi Browser`） | 新 toolWindow，用户可自由 anchor | 生命周期完全独立；实现路径与 PiAgentPanel 同构 | 与 042 拍板的双形态重复；多占一个工具窗按钮 | 降为备选（若双形态都受阻再启用） |
| C4 浮动 Dialog / JBPopup | 一次性弹窗看一眼 | 实现最轻 | 不能长驻、不能与 IDE 布局共存 | 不推荐做主载体 |

### 渲染模式：windowed（与聊天面板一致）

- 选型口诀直接命中：内置浏览器装的是**动效/交互/视频俱全的通用网页**（042 还要装 dev server 应用），OSR 的帧率上限与软渲染（进程外环境下）是下策；且本项目已在本机踩过 stale-frame 坑并留了 `wasResized` workaround，没有理由再选一条帧滞后更重的路。
- windowed 的代价是 heavyweight 原生窗口盖住 Swing 弹层——平台的 HwFacade 已默认兜底（`ide.browser.jcef.hwfacade.enabled=true`），官方 What's New / SVG 查看器同款选择。
- v1 不做 OSR；042 的「批注覆盖层」若需在浏览器视口上叠自绘 UI，到 P2 探针时再评估是否需要 OSR。

## 4. 入口场景（探索稿原口径 → 042 P0 分层的映射）

| 场景 | 探索稿口径（2026-11-13） | 042 拍板后（2026-11-16，以此为准） |
|---|---|---|
| S1 聊天外链 | 改 linkHandler 路由（默认仍系统浏览器 + 三态设置） | 042 Q2：**默认仍系统浏览器不变**；用户主动在浏览器页签打开才内嵌——方向一致，收窄为「不主动改默认」 |
| S2 会话导出 HTML 预览 | 走一次性只读路由或 data: URL，不直接 file:// | 并入 042 P0「本地 HTML 预览」；加载路径遵循 §6.4（file:// 不走主路径） |
| S3 agent 产出工件预览 | 挂起待 pi 侧事实 | 042 P0「本地 HTML」+ P2「批注回流」方向涵盖；仍待 pi 侧真实工件形态 |
| S4 OAuth/认证跳转 | Non-goal | 042 §七明确不碰认证（014 不改）——关闭 |

## 5. 关键技术决策点（实施 spec/plan 时逐条落）

1. **实例生命周期**：懒创建（首次有 URL 才建）；建议「关闭页签即 `dispose`」，不做实例池。若真机证明反复开合太重，再加「空闲 N 分钟销毁」——每浏览器一整套 Chromium 子进程（FM-5），宁可先保守。
2. **P0 零桥接是身份而非省略**：不注入任何 `JBCefJSQuery`、不加 drag/drop handler、不注册到 `BridgeService`。JS→Java 通道为零，则 FM-1（JSQuery 池）整类不存在；标签标题/地址用 Java 侧 `CefDisplayHandler` 回调（`onTitleChanged`/`onAddressChange`），不进页面。**P1/P2 修订**：开发交互（console/网络采集、批注上下文）需要 JS→Java 时，走**独立受控通道**（Java 侧回调优先；确需 JSQuery/CefMessageRouter 时创建前设池大小——事后设置无效），仍不复用 pi 桥接、不携 token。
3. **崩溃判定**：聊天面板靠「前端 20s 长轮询静默」判死；内置浏览器没有这个心跳。可行替代：`CefLoadHandler.onLoadError` + `JBCefHealthMonitor` TOPIC（`GPU_PROCESS_FAILED` / `CEF_SERVER_DISCONNECTED` / `STARTUP_TEST_FAILED`）→ 错误卡 + 重载按钮（复用 `PiUiErrorPanel` 形态）。**`JBCefHealthMonitor.TOPIC` 在 233–263 全线的 API 存在性是探针项**（dev-checklist §4 的样例代码按 2026.2 写）。
4. **导航控制**：back/forward/reload 走 `cefBrowser` 自带导航栈；地址栏展示走 `onAddressChange`，编辑导航按 042 Q3 为 P0 需求；`target="_blank"`/`onBeforePopup` 的默认行为必须显式定夺（仍在内置浏览器打开 or 交系统浏览器，二选一，**不允许 CEF 默认弹独立 Chromium 窗**）。
5. **下载**：通用网页会触发下载，CEF 无处理时会静默失败——挂 `CefDownloadHandler` 显式转交系统默认下载（或提示用系统浏览器打开该链接）。这是聊天 SPA 从未面对过的新失败面。
6. **证书错误 / HTTP 认证弹窗**：按 **043** 执行（`onCertificateError` 四类错误 × 三种配置形态、默认严格、放行须可见提示）——本稿不重复定义，探针结论回填 043。
7. **主题与滚动条**：`JBCefScrollbarsHelper.buildScrollbarsStyle()` 对齐 IDE 滚动条（dev-checklist §6）；页面内容本身跟随网站，不强做暗色改写。
8. **日志卫生**：现有 `consoleHandler` 会把页面 console 写进 idea.log（`PiAgentPanel.kt:136-152`）；内置浏览器复用同款会把用户浏览的 URL/console 内容打进日志——沿用 022 的脱敏入库口径，实施时定脱敏规则。
9. **键盘/焦点**：windowed 模式焦点桥由平台处理；Ctrl+F 页内查找 v1 明确不做（Non-goal 候选，CEF 无现成 find UI）。
10. **本机 CDP 调试事实（2026-11-14 起）**：本机 vmoptions 常开 `-Dide.browser.jcef.debug.port=9222`（JCEF CDP 随时可挂）；`scripts/probe-033-cdp.mjs` 已验证**页面级裸 CDP** 探针路径（Node ≥22 原生 WebSocket；playwright `connectOverCDP` 在 CEF 122 上不可用）。042 的 DevTools 可用性探针（P1）与渲染/元素采集探针直接复用这条路，不用从零搭。

## 6. 安全边界（硬约束；042 §六 已吸收为「安全硬约束」小节）

1. **内置浏览器与桥接物理隔离**：独立 `JBCefBrowser` 实例，加载的 URL 永不携带 `?token=`；P0 无 JSQuery/无 handler 白名单之外的能力。
2. **CEF 全局状态共享要查清**：JBCefBrowser 实例默认共享同一 CEF 运行时的 cookie/缓存。桥接本身不依赖 cookie（header token + Origin 白名单），但**探针必验**：能否且是否需要给内置浏览器配独立 request context / profile，杜绝「恶意页面种 cookie 影响回 loopback 的任何请求」这类面（042 的「隔离存储」探针项即此）。
3. **Origin 校验天然兜底**：任意网页 JS 对 loopback `POST /bridge` 无 token（403）、Origin 不在白名单（拒绝）。内置浏览器不改变这一层——它只是**多了一个能发起这些请求的源**，全部会被现有 `BridgeAuth` 挡下。
4. **file:// 不进主加载路径**：直接 `loadURL("file:///…html")` 的本地文件语义（路径可见性、缓存残留）比受控路由差。本地 HTML 预览（042 P0）建议经 LocalUiServer 的一次性只读路由（随机短时效 token 换内容）或 data: URL——细节留实施 spec，与 043 的证书面互补。
5. **出站通道默认为零**：浏览器→IDE 仅限**用户显式动作**（地址栏导航、P2 批注/日志回流会话——后者按 042 走现有 Composer/队列通路，不新造消息通道），不给浏览器任何自动化直驱 agent/IDE 的通道。P1/P2 引入的 JS→Java 通道见 §5.2 的受控规则。

## 7. 与 019 的关系（2026-11-17 更新：019 已实现）

019 已在 0.5.9 实现（`7147df2`）：multi-Content 工具窗、每 Content 独立 JBCefBrowser + 独立 pi 进程 + 事件按实例分桶、关闭确认、上限 4。浏览器页签因此**直接复用**这套基建，但三条隔离线必须守住（042 §三 已注明 019 的硬教训）：

1. **不占 pi 实例计数**：浏览器 Content 不进 `PiProcessManager` 注册表（无 pi 进程），不影响 D8 上限 4 的语义与 D9 命名（`Pi 1 / Pi 2`）。
2. **页面无 token**：浏览器页签加载的 URL 与 `?token=` 无关；事件分桶也不为其建桶（它不走 /bridge）。
3. **生命周期并行**：浏览器页签的懒创建/销毁与 pi 实例的启停互不触发；关闭确认语义不同（pi 实例关=中断生成，浏览器关=丢页面状态）。

042 Q3 拍板双形态后：C1（工具窗页签）走 019 已验证路径，C3（编辑器呈现）是新路径——两者共享同一浏览器内核封装层，实施 spec 里应先定「内核层」（一个与载体无关的 browser component），再分别接两个载体。

## 8. 建议实施路径（对齐 042 的 P0–P3 分层）

042 已定「按能力分层逐条另立可实施 spec」。本稿的建议：

```
P0 预览基座（第一个可实施 spec，先行）
  前置探针（042 §五 7 项 + 本稿补充 4 项，见下表）
  - 内核层：与载体无关的 browser component
    （门禁/懒创建/零桥接/导航控制/错误卡/释放纪律，复用 PiAgentPanel 实战模板）
  - C1 工具窗页签（019 路径）→ C3 编辑器呈现
  - 外链策略：默认系统浏览器不变（042 Q2）
  - 证书面按 043 同批或紧随
P1 开发交互（DevTools/控制台/截图）——探针结论决定形态
P2 批注回流会话——数据形状对齐消息/队列语义
P3 仅记方向（042 原文）
```

**探针合并清单**（042 §五 7 项 + 本稿补充 4 项，实施 spec 前真机完成）：

| # | 探针 | 来源 |
|---|---|---|
| 1 | JCEF 多实例 / OSR 绘制共存（焦点/生命周期/GC 停顿） | 042 |
| 2 | DevTools 可用性（DOM/Console/Network 覆盖度；受限时的替代采集） | 042 |
| 3 | 元素选取与上下文采集（稳定选择器/计算样式/裁剪截图/CSP 对注入的影响） | 042 |
| 4 | 批注覆盖层（overlay/shadow DOM 与页面事件共存） | 042 |
| 5 | 承载双形态（工具窗 Content 与编辑器）实现路径与切换语义 | 042 |
| 6 | URL 安全边界（白名单/确认/跨域/下载/隔离存储） | 042 |
| 7 | 批注回流数据形状（文本+截图 vs 结构化上下文；体积/截断） | 042 |
| 8 | `JBCefHealthMonitor.TOPIC` 在 233–263 的存在性与行为 | 本稿 |
| 9 | 独立 request context / cookie 隔离的 API 可行性 | 本稿 |
| 10 | `onBeforePopup` / 下载 / 证书错误的默认行为（结论回填 043） | 本稿 |
| 11 | 渲染模式实测：windowed vs OSR 本机帧滞后对比（stale-frame 史） | 本稿 |

探针工具：本机 CDP 已常开（§5.10），裸 CDP 脚本路径有先例（`scripts/probe-033-cdp.mjs`）；040 Mermaid 的挂起探针同属「JCEF 渲染行为」一族，可共用探针脚本与结论格式。

每步按宪法 II 带「— 验证：…」断言；e2e 侧 mock 不了 JCEF，自动化以 Kotlin 单测（路由策略、生命周期状态机、隔离规则）+ 真机清单为主（dev-checklist §9：Windows+NVIDIA / RDP / Wayland 至少三档）。

## 9. 开放问题：探索稿 Q1–Q6 已全部被 042/043 关闭（映射）

| 探索稿（2026-11-13） | 原默认口径 | 042/043 拍板（2026-11-16，以此为准） |
|---|---|---|
| Q1 入口范围 | S1+S2 | 042 Q1：本地 HTML 预览 + 浏览器页签 + 外链三者都要（**更广，取代**） |
| Q2 默认去向 | 系统浏览器 + 三态设置项 | 042 Q2：默认系统浏览器不变，用户主动才进页签（方向一致） |
| Q3 载体 | C2 独立工具窗 | 042 Q3：工具窗页签 + 编辑器呈现**双形态**（019 已实现使 C1 现成） |
| Q4 地址栏自由输入 | 不做 | **被取代**：042 Q3 拍板地址栏须可展示、可编辑 |
| Q5 多标签 | v1 单视口复用 | 042 P3 仅记方向（多标签与会话绑定），实施 spec 再定 |
| Q6 与 019 先后 | 互不阻塞 | 019 已实现（0.5.9），问题消解 |

遗留的真正开放项全部下放：实施期技术问题见 §5 各条与 043「待 plan 阶段决定的技术问题」；范围级问题见 042 §开放问题（编辑器呈现精确形态、URL 策略呈现、DevTools 降级、批注数据形状、页签生命周期绑定）。

## 10. 证据索引

- 代码：`PiAgentPanel.kt:79-92`（linkHandler 路由）、`:271-352`（门禁与创建）、`:376-451`（健康自愈）、`:453-480`（stale-frame workaround）、`:482-492`（释放纪律）；`LocalUiServer.kt:49-52,67-89`（loopback + token/Origin）；`plugin.xml:18`（optional jcef depends）；`build.gradle.kts:380,409`（233 基线 + verify 红线）；`PiAgentToolWindowFactory.java`（Java 工厂约束 + 类名探测降级）；019 实现 `7147df2`（0.5.9，multi-Content + 实例注册表 + 事件分桶）。
- 同批规格：[042 方向性 spec](./spec.md)（需求口径与 P0–P3 路线图，**以此为准**）、[043 协议与证书策略](../043-browser-protocol-cert/spec.md)（证书面单独定义）、`specs/README.md` 0.5.10 批次段。
- jcef-knowledge 知识库（`C:\Users\Administrator\.agents\skills\jcef-knowledge\`）：SKILL.md 硬规则五条；references/dev-checklist.md §1 门禁、§2 生命周期、§3 JSQuery 池、§4 健康监控、§6 滚动条、§9 测试矩阵；references/rendering-modes.md §2 官方默认选型、§3 HwFacade；references/official-usage-map.md §1（`OpenHtmlInEmbeddedBrowser` / `WebPreviewEditorProvider` 平台先例）、§4（官方模式提炼）；references/third-party-failure-modes.md FM-1～FM-6 与 Continue #8085 案例。
- 本机调试事实（AGENTS.md 2026-11-14）：vmoptions 常开 `-Dide.browser.jcef.debug.port=9222`；`scripts/probe-033-cdp.mjs` 页面级裸 CDP 先例（playwright `connectOverCDP` 在 CEF 122 不可用）。

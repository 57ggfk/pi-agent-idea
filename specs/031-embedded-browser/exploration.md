# 031 内置浏览器（In-IDE Browser）方案探索

> **状态：探索稿，暂不实施**（2026-11-13 用户指令：「仅探索方案暂不实施」「不起多任务，串行执行」）。
> 本文档只做方案空间梳理与推荐，**不含 spec / plan / tasks，不改任何源码**。
> 需求口径（入口范围、默认打开方式、载体）待用户关闭文末 Q1–Q6 后，再按三段式（spec → plan → tasks）补齐。
> 编号 031 为占位防撞号；分支 `031-embedded-browser`（自 main `08ee234` 拉出），工作树 `D:/code/github/pi-agent-idea-wt/031-embedded-browser`。

## 1. 背景：现状是「外链一律进系统浏览器」

聊天回复里的 markdown 链接在 web 侧就是普通 `<a>`，没有任何点击拦截；真正决定去向的是 CEF 层：

- [`PiAgentPanel.kt:79-92`](../../src/main/kotlin/dev/pi/agent/toolwindow/PiAgentPanel.kt) `linkHandler.onBeforeBrowse`：
  URL 不是 `http://127.0.0.1:*` / `http://localhost:*` → `BrowserUtil.browse(url)` 交系统浏览器，并 `return true` 取消 IDE 内导航。注释原话：「Navigations away from the UI server (markdown links) are handed to the system browser so they can never hijack the SPA.」
- `LocalUiServer` 只绑 loopback（`LocalUiServer.kt:49-52`），一切外部 URL 都到不了本插件的服务。

**这是刻意的安全设计**：聊天面板的浏览器实例承载着带 `?token=` 的 SPA（`LocalUiServer.kt:67-73`），token + Origin 校验是唯一的 agent 控制权边界。任何「让主面板导航去别处」的做法都会破坏这条边界（见 §3 方案 B）。

内置浏览器要回答的问题因此不是「怎么嵌一个 Chromium」（本插件天天在嵌），而是：

1. 给它一个**独立的、不带任何桥接能力**的浏览器实例与载体；
2. 定义哪些入口把 URL 交给它、哪些仍走系统浏览器；
3. 处理通用网页带来的新失败面（下载、弹窗、证书、target=_blank），这些聊天 SPA 从来不需要面对。

## 2. 现状架构事实（已逐条核对）

| 事实 | 位置 | 对方案的影响 |
|---|---|---|
| 每 project 一个 `PiAgentPanel` = 一个 `JBCefBrowser()`（无参构造，默认 windowed 渲染） | `PiAgentPanel.kt:327` | 渲染模式、handler 挂法已有本仓先例可抄 |
| 门禁 `JBCefApp.isSupported()` + 三级失败卡（服务器起不来 / JCEF 不支持 / 加载失败），无 JCEF 时降级提示 | `PiAgentPanel.kt:271-352`、`PiAgentToolWindowFactory.java`（按类名探测，不触碰类型） | 内置浏览器沿用同一门禁与降级形态 |
| 健康自愈：30s Swing timer 查桥接静默（90s 阈值），60s 窗口内重建 >2 次熔断进错误卡 | `PiAgentPanel.kt:376-451` | 内置浏览器没有「长轮询」这种现成心跳，需另定崩溃判定（§5） |
| 0.5.4 起的 stale-frame workaround：反射调 `CefBrowser_N.wasResized` 强制重绘 | `PiAgentPanel.kt:453-480` | 本机环境对 JCEF 帧滞后敏感 → 渲染模式选型倾向 windowed（§4） |
| handler 四件套 + AWT drop 旁听，dispose 时逐个 `removeXxxHandler` | `PiAgentPanel.kt:482-492` | 释放纪律的现成模板 |
| token 鉴权靠 URL query + `X-Pi-Token` header + Origin 白名单 | `LocalUiServer.kt:67-89` | **内置浏览器实例绝不能加载带 token 的 URL**（§6） |
| JCEF 依赖是 optional `<depends>com.intellij.modules.jcef</depends>`（2026.2 插件化迁移已适配） | `plugin.xml:18` | 载体若新增组件也要保持 optional 模块纪律 |
| `sinceBuild = "233"`（2023.3），验证基线 2024.3.1（243）；`INTERNAL_API_USAGES` 是 verify 失败级别 | `build.gradle.kts:380,409` | 平台 HTML 预览类内部 API 不可直接引用（§3 C4） |
| 工具窗工厂必须写 Java（Kotlin 会生成 jvm-default 前转方法，被 verifier 记为 internal API usage） | `PiAgentToolWindowFactory.java` 类注释 | 新增载体工厂沿用 Java |
| 019（工具窗多实例）spec+plan 已定稿、**暂不实施**：计划把工具窗改 multi-Content（每 Content = 一个 Pi 实例 + 独立浏览器），`canCloseContents` 改 true | `specs/019-toolwindow-multi-instance/plan.md` | 内置浏览器载体选择必须预判与 019 的叠加（§7） |

平台事实（jcef-knowledge 知识库，2026-11 磁盘取证 + 源码双验证）：

- JCEF 版本由 IDE 发布火车决定，插件无选择权；2026.2 起 JCEF 是独立捆绑插件 `com.intellij.modules.jcef`。
- **平台没有通用「浏览器工具窗」**：最接近的是 HTML 文件的 IDE 内嵌预览（`OpenHtmlInEmbeddedBrowser` / `JcefHtmlEditorProvider`）与 Web Preview（`WebPreviewEditorProvider`，面向项目内 HTML / dev server），都不是任意 URL 的通用浏览器（official-usage-map §1）。
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

### C. 独立 `JBCefBrowser` 实例（推荐方向）——剩下的决策是「载体」

独立实例意味着：无 JSQuery 注入、无 token、无 drop/drag handler、不挂 `BridgeService` 任何东西——一个「只读的 Chromium 视口」。成本是每实例一整套 Chromium 子进程（FM-5），因此必须配懒创建 + 关闭/空闲销毁（§5）。

载体的四个子选项：

| 载体 | 形态 | 优点 | 缺点 / 风险 | 评估 |
|---|---|---|---|---|
| C1 Pi Agent 工具窗加一个 Content 标签 | 与聊天同窗，标签切换 | 改动最小（multi-Content 本来就要为 019 引入）；用户视线不用离开 Pi 窗 | **与 019 抢 ContentManager 语义**：019 的标签是「Pi 实例」，混入「浏览器」标签后命名/关闭确认/上限逻辑都要双轨（见 §7） | 备选，取决于 Q6 |
| C2 独立工具窗（如 `Pi Browser`） | 新 toolWindow，用户可自由 anchor（放右侧与 Pi 并排、或浮在副屏） | 生命周期完全独立；**与 019 零冲突**；`canCloseContents` 不用动；实现路径与 PiAgentPanel 同构（新建一个无桥接的 Panel 类即可） | 多占一个工具窗按钮；「从聊天点链接 → 自动聚焦另一个工具窗」的跳转体验要做 | **推荐（默认口径）** |
| C3 编辑器区伪文件标签（FileEditorProvider + 轻量 VirtualFile） | 像 HTML 文件预览那样出现在编辑器 tab 区 | 占主工作区、多标签由编辑器 tab 天然管理、对 S2「预览导出 HTML」的隐喻最贴切；平台先例就是 `JcefHtmlEditorProvider` / `WebPreviewEditorProvider` | 实现量最大：伪文件体系（LightVirtualFile）、provider 注册、与 verifier 的 INTERNAL_API_USAGES 红线要绕（只抄形态、不引内部 API）；关闭/复用语义要做 | S2 场景成熟后的二期选项 |
| C4 浮动 Dialog / JBPopup | 一次性弹窗看一眼 | 实现最轻 | 不能长驻、不能与 IDE 布局共存、窗口生命周期管理反而琐碎 | 不推荐做主载体；可作为「无 JCEF IDE」之外的辅助形态 |

### 渲染模式：windowed（与聊天面板一致）

- 选型口诀直接命中：内置浏览器装的是**动效/交互/视频俱全的通用网页**，OSR 的帧率上限与软渲染（进程外环境下）是下策；且本项目已在本机踩过 stale-frame 坑并留了 `wasResized` workaround，没有理由再选一条帧滞后更重的路。
- windowed 的代价是 heavyweight 原生窗口盖住 Swing 弹层——平台的 HwFacade 已默认兜底（`ide.browser.jcef.hwfacade.enabled=true`），官方 What's New / SVG 查看器同款选择。
- v1 不做 OSR；若将来出现「浏览器视口上叠自绘 UI」的需求再评估。

## 4. 入口场景梳理（Q1 的选项空间）

| 场景 | 触发点 | 现状 | 备注 |
|---|---|---|---|
| S1 聊天外链 | 点 pi 回复里的 http(s) 链接 | 系统浏览器 | 主力场景；改的是 `linkHandler` 的路由策略（或 web 侧点击经桥接询问 IDE，二选一，plan 时定） |
| S2 会话导出 HTML 预览 | Sessions 导出后「预览」 | 落盘后用户自己开 | 导出物是**本插件自己生成的免脚本单文件**，是唯一「可信内容」场景；但仍建议走 §6 的隔离加载（不直接 file://） |
| S3 agent 产出工件预览 | pi 写出的 HTML/页面类工件 | 无 | 取决于 pi 侧是否真的产出这类工件，先按需求存疑项挂起 |
| S4 OAuth/认证跳转 | `ProviderForm.tsx:383,396` 的 `target="_blank"` 链接 | 系统浏览器 | 认证页敏感，放进内置浏览器收益小、审计面大；建议明确 Non-goal |

## 5. 关键技术决策点（实施时逐条落进 plan）

1. **实例生命周期**：懒创建（首次有 URL 才建）；v1 推荐「关闭工具窗/标签即 `dispose`」，不做实例池。若后续真机证明反复开合太重，再加「空闲 N 分钟销毁」——每浏览器一整套 Chromium 子进程（FM-5），宁可先保守。
2. **零桥接是身份而非省略**：不注入任何 `JBCefJSQuery`、不加 drag/drop handler、不注册到 `BridgeService`。JS→Java 通道为零，则 FM-1（JSQuery 池）整类不存在；标签标题用 Java 侧 `CefDisplayHandler.onTitleChanged` 拿，不进页面。
3. **崩溃判定**：聊天面板靠「前端 20s 长轮询静默」判死；内置浏览器没有这个心跳。可行替代：`CefLoadHandler.onLoadError` + `JBCefHealthMonitor` TOPIC（`GPU_PROCESS_FAILED` / `CEF_SERVER_DISCONNECTED` / `STARTUP_TEST_FAILED`）→ 错误卡 + 重载按钮（复用 `PiUiErrorPanel` 形态）。**`JBCefHealthMonitor.TOPIC` 在 233–263 全线的 API 存在性是阶段 0 必验项**（dev-checklist §4 的样例代码按 2026.2 写）。
4. **导航控制**：back/forward/reload 走 `cefBrowser` 自带导航栈；地址栏 v1 只读展示（`onAddressChange`）；`target="_blank"`/`onBeforePopup` 的默认行为必须显式定夺（建议：仍在内置浏览器打开 or 交系统浏览器，二选一，不允许 CEF 默认弹独立 Chromium 窗）。
5. **下载**：通用网页会触发下载，CEF 无处理时会静默失败——挂 `CefDownloadHandler` 显式转交系统默认下载（或提示用系统浏览器打开该链接）。这是聊天 SPA 从未面对过的新失败面。
6. **证书错误 / HTTP 认证弹窗**：`onLoadError` 给可感知错误卡；不做证书例外 UI（v1）。
7. **主题与滚动条**：`JBCefScrollbarsHelper.buildScrollbarsStyle()` 对齐 IDE 滚动条（dev-checklist §6）；页面内容本身跟随网站，不强做暗色改写。
8. **日志卫生**：现有 `consoleHandler` 会把页面 console 写进 idea.log（`PiAgentPanel.kt:136-152`）；内置浏览器若复用同款，用户浏览的 URL/console 内容会进日志——沿用 022 的脱敏入库口径，实施时定脱敏规则。
9. **键盘/焦点**：windowed 模式焦点桥由平台处理；Ctrl+F 页内查找 v1 明确不做（Non-goal 候选，CEF 无现成 find UI）。

## 6. 安全边界（本节是方案的硬约束）

1. **内置浏览器与桥接物理隔离**：独立 `JBCefBrowser` 实例，加载的 URL 永不携带 `?token=`；无 JSQuery/无 handler 白名单之外的能力。
2. **CEF 全局状态共享要查清**：JBCefBrowser 实例默认共享同一 CEF 运行时的 cookie/缓存。桥接本身不依赖 cookie（header token + Origin 白名单），但**阶段 0 必验**：能否且是否需要给内置浏览器配独立 request context / profile，杜绝「恶意页面种 cookie 影响回 loopback 的任何请求」这类面。
3. **Origin 校验天然兜底**：任意网页 JS 对 loopback `POST /bridge` 无 token（403）、Origin 不在白名单（拒绝）。内置浏览器不改变这一层——它只是**多了一个能发起这些请求的源**，全部会被现有 `BridgeAuth` 挡下。
4. **file:// 不进主加载路径**：S2 若直接 `loadURL("file:///…html")`，本地文件语义（universal access 默认关闭，但路径可见性、缓存残留）比一次性受控路由差。建议给导出预览走 LocalUiServer 的一次性只读路由（随机短时效 token 换内容），或 data: URL——细节留 plan。
5. **定位是「看」，不是「用」**：不给内置浏览器任何 IDE 侧能力（无引用 chip、无文件拖拽、无 pi 调用）。它存在的意义就是让不可信内容**只**出现在一个无权的视口里。

## 7. 与 019 的叠加关系

019 重启实施时，Pi Agent 工具窗会变成 multi-Content（Pi 1 / Pi 2 / …，每标签一个实例 + 独立浏览器）。三种叠加姿势：

- **031 先做、选 C2（独立工具窗）**：零冲突。019 之后两者各管各的窗口。（推荐默认）
- **031 先做、选 C1**：ContentManager 里混入「浏览器」标签；019 的 D8 上限 / D9 命名 / D7 关闭确认都要区分「实例标签」与「浏览器标签」，复杂度上移。**若走此路，必须在 019 plan 补记一笔。**
- **019 先做、031 后做**：031 可自由选 C1（此时 multi-Content 已存在，加一类 Content 顺手）或 C2/C3。

结论：**031 不阻塞 019，019 也不阻塞 031，唯一要避免的是「031 选 C1 且 019 后行」的无协调叠加。** 已记入 Q6。

## 8. 建议实施阶段（口径确认后才启动）

```
阶段 0 取证（真机 + API 存在性，半天）
  - JBCefHealthMonitor.TOPIC 在 233–263 的存在性与行为
  - 独立 request context / cookie 隔离的 API 可行性（§6.2）
  - onBeforePopup / 下载 / 证书错误的默认行为
  - HwFacade 下内置浏览器与 IDE popup 的叠放表现
      ↓
阶段 1 最小可用（按 Q1–Q3 的口径）
  - C2 载体 + 懒创建 + 关闭即销毁
  - 只读地址栏 + back/reload + 外链路由设置项（默认不变，见 Q2）
  - onLoadError/健康 TOPIC → 错误卡 + 重载（复用 PiUiErrorPanel 形态）
      ↓
阶段 2 打磨
  - 下载/弹窗/证书显式策略；空闲销毁；S2 导出预览的一次性路由
  - 日志脱敏规则；MANUAL_TEST 清单（Windows+NVIDIA / RDP / Wayland 至少三档，dev-checklist §9）
```

每步按宪法 II 带「— 验证：…」断言；e2e 侧 mock 不了 JCEF，自动化以 Kotlin 单测（路由策略、生命周期状态机）+ 真机清单为主。

## 9. 开放问题（待用户关闭；每条给了默认口径，不答则按默认实施）

| # | 问题 | 默认口径 |
|---|---|---|
| Q1 | 入口范围：S1 聊天外链 / S2 导出 HTML 预览 / S3 agent 工件 / S4 OAuth，先做哪些？ | S1 + S2；S3 挂起等 pi 侧事实；S4 明确 Non-goal |
| Q2 | 点外链的默认去向：内置浏览器 / 系统浏览器 / 每次询问？ | 加设置项（三态），**默认维持系统浏览器**——不改变既有习惯，也把不可信内容的默认暴露面保持为零 |
| Q3 | 载体：C1 Pi 窗标签 / C2 独立工具窗 / C3 编辑器伪文件 / C4 浮窗？ | C2（独立工具窗，零 019 冲突、实现与 PiAgentPanel 同构）；S2 成熟后可加 C3 |
| Q4 | 要不要地址栏自由输入（通用浏览器定位）？ | 不做。只被动接收链接（Non-goal），避免滑向「维护一个完整浏览器产品」 |
| Q5 | 多标签 or 单视口复用？ | v1 单视口复用（新链接替换内容），历史靠 CEF 自带 back/forward |
| Q6 | 与 019 的先后？ | 互不阻塞；若 031 先做则走 C2，若 019 先做则 C1 变为可行选项 |

## 10. 证据索引

- 代码：`PiAgentPanel.kt:79-92`（linkHandler 路由）、`:271-352`（门禁与创建）、`:376-451`（健康自愈）、`:453-480`（stale-frame workaround）、`:482-492`（释放纪律）；`LocalUiServer.kt:49-52,67-89`（loopback + token/Origin）；`plugin.xml:18`（optional jcef depends）；`build.gradle.kts:380,409`（233 基线 + verify 红线）；`PiAgentToolWindowFactory.java`（Java 工厂约束 + 类名探测降级）；`specs/019-toolwindow-multi-instance/plan.md`（multi-Content 先例与 D7–D10 语义）。
- jcef-knowledge 知识库（`C:\Users\Administrator\.agents\skills\jcef-knowledge\`）：SKILL.md 硬规则五条；references/dev-checklist.md §1 门禁、§2 生命周期、§3 JSQuery 池、§4 健康监控、§6 滚动条、§9 测试矩阵；references/rendering-modes.md §2 官方默认选型、§3 HwFacade；references/official-usage-map.md §1（`OpenHtmlInEmbeddedBrowser` / `WebPreviewEditorProvider` 平台先例）、§4（官方模式提炼）；references/third-party-failure-modes.md FM-1～FM-6 与 Continue #8085 案例。

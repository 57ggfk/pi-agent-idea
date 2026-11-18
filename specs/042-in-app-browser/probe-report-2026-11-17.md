# 042 内置浏览器 · 真机探针报告（2026-11-17，已入库）

> 产出时为工作树临时件（当时指示不提交），2026-11-19 随浏览器工作线统一入库转正。
> 原始脚本/日志/素材：仓库内 `probe-evidence/` 与探针插件 `probe-plugin/`；
> 仓库外原件在 `D:\code\probe-042\`（8MB 级截图不入库，留在现场）。
> 探针方式：真机 WebStorm（继承机器 vmoptions，**未启沙盒**）+ 页面级裸 CDP + 临时本地测试服务器 + pi scratch；
> 插件轮在 runIde 沙盒（IC-2024.3.1 / CEF 122，CDP 9223）。未动插件任何源码。

## 0. 环境事实

| 事实 | 值 |
|---|---|
| 真机 IDE | WebStorm 2026.2（运行中，`webstorm64.exe` PID 34680） |
| CEF 内核 | **Chrome/144.0.7559.172**（CDP `/json/version` 实测；知识库「2026-05 升 144」吻合） |
| CDP | `-Dide.browser.jcef.debug.port=9222` 常开，页面级裸 CDP 全程可用 |
| 现有 targets | `Pi Agent`（token URL + **`&instance=` 参数，019 多实例真机在跑**）、Image viewer |
| `/json/new` | **可用**（PUT 形式）——可在同一 CEF 运行时里凭空开任意 URL 的页，全程零插件代码 |

## 1. 探针结果总表（三轮，24 项）

### 1.1 立即可用的能力（P1/P2 数据面）——全部 PASS

| 探针 | 结果 | 对 042 的意义 |
|---|---|---|
| console 采集 | `Runtime.consoleAPICalled` 全量到手：`types=log,info,warning,error,debug`，带 args/timestamp/**stackTrace**；`Log.entryAdded` 兼容 | **P1「控制台日志进会话」的数据通道成立**，事件形状可直接定 schema |
| 元素选择器 | `div#root > section > button#target-button` 稳定生成 | P2 批注上下文的选择器字段可行 |
| 计算样式 | `getComputedStyle` 9 属性一次取全（对照 Cursor 的 6 项绰绰有余） | 同上，样式字段可行 |
| 元素 rect | `getBoundingClientRect` 正常 | 批注坐标/框选可行 |
| **裁剪截图** | `Page.captureScreenshot` + `clip` 参数成功（723B 元素级、9.5KB 区域级，端到端落盘 `annotation.png`） | **P2「批注附裁剪截图」成立** |
| 多 tab 共存 | 同一 CEF 运行时开 11 个 probe tab，聊天面板不受影响 | 探针 #1「多实例共存」运行时面 PASS |

### 1.2 安全面——两条硬结论

| 探针 | 结果 | 结论 |
|---|---|---|
| **cookie 共享** | tab A `document.cookie="probe042=hello"` → tab B 直接读到 | **同一 CEF 运行时内所有 browser 共享 cookie jar**——§6.3 约束坐实：内置浏览器需要独立 request context（探针插件验证 API），否则用户在内置浏览器里的登录态/种下的 cookie 与其他 JCEF 面（含 loopback 请求面）互通 |
| CSP 注入 | `Runtime.evaluate`（=CDP 通道）**穿透 CSP**；DOM `<script>` 被拦 | 生产注入通道 `CefBrowser.executeJavaScript` 同属 browser-process 通道，大概率同样穿透（探针插件最终确认）→ **P2 批注覆盖层的注入不惧页面 CSP** |

### 1.3 失败面——三个默认行为定论（043 直接可用）

| 探针 | 结果 | 结论 |
|---|---|---|
| **下载（无 handler）** | `Network.loadingFailed errorText=net::ERR_ABORTED canceled=true`；Downloads/dl 目录均无文件；CDP `setDownloadBehavior(allow)` 后请求不再报失败但也**不落盘** | **默认下载凭空消失**——042 §五「下载须显式处理」坐实；生产必须挂 `CefDownloadHandler`（CDP 通道也救不回） |
| **证书错误默认行为** | 自签/错域名/私有 CA 三类（CN=127.0.0.1、CN=other.example.com、私有 CA 签发）→ CEF 144 默认渲染 **Chromium「Privacy error」interstitial 页**（不是白屏！） | 043 FR-002 的重要修正：**默认不是白屏而是可读的错误页**；「白屏」风险低于预期。过期证书 openssl 签不出（`-days` 不接受负数），留待插件探针（CEF 侧 `ERR_CERT_DATE_INVALID` 与域名不符同类处理） |
| **证书放行** | 页面级 CDP：`Security.certificateError` 事件**能收到**（`ERR_CERT_AUTHORITY_INVALID` + requestURL）；`handleCertificateError action="proceed"` **被拒**（"Unknown Certificate Error Action"）；`action="cancel"` 被接受 | **CDP 层无法放行证书**（CEF 的 DevTools 后端未实现 proceed）→ 043 的放行只能走 `CefRequestHandler.onCertificateError` handler 层——这正是插件探针要验证的 API，且现在确认它**不可替代** |

### 1.4 弹窗（部分结论）

`window.open` 从 CDP 注入调用返回 `null`（无用户手势被弹窗拦截）。**真实点击的行为仍未定**（可能弹独立 CEF 窗）——`onBeforePopup` 默认行为必须插件探针（探针 #10 剩余项）。

## 1.5 探针插件轮（2026-11-17 下午，独立 scratch 项目 `D:\code\probe-042\jcef-probe`，沙盒 IC-2024.3.1 / CEF 122，CDP 9223）

前置：真实点击（CDP `Input.dispatchMouseEvent`，受信任手势）证明 **无 handler 时 `target=_blank` 默认弹出新 CEF 窗口**——042 必须拦截，不是可选项。

探针插件 = 最小 ToolWindow 插件，自动创建 windowed + OSR + 隔离 context 三个浏览器并挂全套 handler，测量由沙盒 CDP 外部驱动。结果（v4，全部实测）：

| 探针 | 结果 | 结论 |
|---|---|---|
| **弹窗拦截** | `CefLifeSpanHandler.onBeforePopup(browser, frame, targetUrl, targetFrameName)` 返回 **true** → child target 消失 | **042 弹窗方案定论**：拦截点在 LifeSpanHandler（RequestHandler 上没有 onBeforePopup；`onOpenURLFromTab` 不承接 target=_blank）。内置浏览器返回 true 后自行导航即可 |
| **证书放行** | `CefRequestHandler.onCertificateError(browser, errorCode, url, CefSSLInfo, CefCallback)` + `callback.Continue()` → 自签页面 **完整加载**（windowed 与 OSR 双确认，err=ERR_CERT_AUTHORITY_INVALID, sslStatus=5） | **043 核心通路实证可行**；`CefSSLInfo.statusBiset` 可读。注意：CDP 层无法放行（前轮已证），handler 层是唯一通路 |
| **下载** | `JBCefClient.addDownloadHandler` 存在；`onBeforeDownload` → `callback.Continue(原生反斜杠路径, showDialog=false)` → **文件精确落盘**（65536B），`onDownloadUpdated` 进度完整（received 0→65536→complete） | **042 下载方案定论**：正斜杠路径会静默滞留（v3 实测无进度无文件），**必须用 Windows 原生路径**——实现时的大坑已排 |
| **cookie 隔离** | `CefBrowserFactory.create(..., CefRequestContext.createContext(handler))` 编译可用，但隔离 context 浏览器**读到了全局 context 写的 cookie** | **`createContext(handler)` 不隔离 cookie**（CEF 122）——§6.3 的「request context 隔离」在该 API 面不可实现；042 安全模型须按「cookie jar 全局共享」设计（与竞品「不承载登录态」口径合流），或探 CEF 144 的新 API |
| **API 面发现** | `JBCefHealthMonitor` **在 243 不存在**（2025.x+ 才有）；`onRenderProcessTerminated(browser, TerminationStatus)` 存在；`JBCefBrowserBuilder.setEnableOpenDevToolsMenuItem(boolean)` 存在（**DevTools 可开**）；`setWindowlessFramerate(int)` 存在；`CefBrowser.createScreenshot(boolean)` 存在；`CefRequestContext` 还有 `ClearCertificateExceptions/CloseAllConnections` | 崩溃判定在 233–263 全线用 `onRenderProcessTerminated` + `onLoadError`（exploration.md §5.3 的 HealthMonitor 方案只适用于 2025.2+）；DevTools 探针（P1）有官方菜单入口可用 |
| OSR/FPS | OSR 浏览器创建+渲染进 Swing 成功（截图目视确认）；后台状态下 rAF ~30fps（throttle），前台帧率需 GUI 前台测 | OSR 技术通路 OK；帧率量化留 GUI 项 |

**GUI 目视确认**（PowerShell PrintWindow 截图 `sandbox-window.png`）：信任对话框被 `-Didea.trust.all.projects=true` 绕过；三个浏览器面板并排渲染正常；OSR 内容画进 Swing 面板；windowed 面板出现**旧帧残留**（导航后仍显示上一页内容——仓库 0.5.4 的 `wasResized` workaround 正是为此，内置浏览器必须沿用）。

### GUI 手感项实测（v5：Swing 地址栏 + onAddressChange 回显 + 焦点日志）

| 项 | 结果 |
|---|---|
| **地址栏端到端** | ✅ 全通：点击聚焦 → 输入/粘贴 URL → Enter/Go 按钮 → `loadURL` → `onAddressChange` 回显标签更新 → 页面加载（`onBeforeBrowse → onLoadEnd 200` 全链日志）；element.html 渲染目视确认（Target Heading/Click me/a-b-c 截图） |
| **中文输入** | ✅ **粘贴路径完美**（剪贴板中文「中文批注测试：padding 调大到 8px 12px」在 Swing JTextField 渲染无误）；⚠️ 键盘打字路径被系统中文 IME 污染（ASCII `:` `/` 被转全角 `：` `、`——自动化输入的坑，真人拼音组词不受此影响）；**真人 IME 组词候选窗行为仍需一次人工目验**（唯一开放点） |
| **焦点切换** | ✅ `CefFocusHandler.onGotFocus/onTakeFocus` 日志正常（`onTakeFocus` 是 void，JCEF 122 签名已录）；Swing→browser 无卡死 |
| **前台 FPS** | ⚠️ **本机环境上限**：前台两次读数 windowed = OSR = **150f/5s（恰好 30fps）完全相等**。本机 Console 会话走虚拟显示适配器（向日葵 OrayIdd + GameViewer 4K@144Hz，远程串流管线实际 ~30fps）→ 30fps 是**环境产物而非 OSR 惩罚**（二者相等为证）。物理显示器会话需重测得绝对值；**相对结论「OSR 不比 windowed 差」成立** |
| **自动化交互坑** | SendKeys 打字会被中文 IME 转 full-width（CDP `Input.dispatchMouseEvent` 真实点击 + 剪贴板粘贴是可靠通路）；`onBeforePopup` 拦截后弹窗被取消的目视验证已并入 |

探针插件复跑配方：`cd D:/code/probe-042/jcef-probe && <repo>/gradlew.bat runIde`（沙盒 CDP 9223，真机 9222 不冲突；免信任已配置；项目自动打开 pi-project）。**改代码前必须先关沙盒**（`prepareSandbox` 会被文件锁打挂）。

### v6 两条真机 UX 教训（2026-11-18，用户试用直接暴露）

1. **弹窗「静默取消」= 链接全死**：v3 的 `onBeforePopup` 返回 true 后直接丢弃 URL，真实站点（163 等，链接几乎全 `target=_blank`）表现为「链接都不能跳转」。**042 决策点「拦截后去哪」有了实证答案：拦截后必须同视口导航**（v6 已改：return true + `loadURL(targetUrl)`），spec 里要写死「禁止静默丢弃」。
2. **windowed 原生 HWND 会错位压住 Swing 组件**：实测 CEF 原生窗口漂移盖住地址栏（点击全被浏览器吃掉，日志只有 `GOT focus`）；探针里第三个面板再建一个原生窗口（`isOffScreenRendered=false`）加剧了抢位，v6 已改 OSR 消除。**042 实施：同一工具窗内只允许一个 windowed 实例，工具栏布局要预留 HWND 错位的可恢复手段（resize/重挂父容器触发重排）**；这与知识库 FM-4（heavyweight 覆盖）同类，HwFacade 只兜 IDE 弹层、不兜插件自己的 Swing 组件被 CEF 原生窗口盖住的方向。



## 2. pi 侧批注数据形状（042 开放问题 #4 的直接答案）

实验：scratch `PI_CODING_AGENT_DIR`（隔离）+ `pi -p @annotation-context.json @annotation.png "…"`（pi 1.5.2）。

会话 jsonl（`sessions/--D--code-probe-042-pi-project--/…jsonl`，version 3）里 user 消息的真实结构：

```jsonc
{
  "type": "message",
  "message": {
    "role": "user",
    "content": [
      { "type": "text",
        "text": "<file name=\"D:\\...\\annotation-context.json\">\n{...JSON 全文...}\n</file>" },
      { "type": "image", "data": "iVBORw0KGgo…(12688 chars)", "mimeType": "image/png" }
    ]
  }
}
```

三条结论：

1. **CLI `@file` 被 pi 展开为 `<file name="绝对路径">…全文…</file>` 内联文本块**——注意这与插件 refs chip 的「`@相对路径` 交 pi 自行读取」（044 机制）是**两条不同通路**：CLI 层预展开 vs agent 运行期工具读取。P2 批注回流两种都可用：小上下文直接内联（零工具调用），大上下文走 `@路径` 引用。
2. **截图 = 独立 image 块**（base64 + mimeType），9.5KB PNG → 12688 字符（4/3 膨胀）。插件现有图片通路已同款；批注流若高频截图，会话文件膨胀与截断策略（042 探针 #7）要按这个倍率算。
3. **模型消费验证 ✅ 已闭环（2026-11-17 补跑）**：首轮 402 是因为默认落到了付费模型（moonshotai/…）；真机日常通路是 `settings.json` 的 `defaultModel: openrouter/free`（免费虚拟模型，无需 credits）。加 `--model openrouter/free` 重跑，**pi 逐条确认消费成功**：① 读到 JSON 选择器与样式（原样复述 `div#root > section > button#target-button` / `rgb(18,52,86)` / `14px`）② **看图并准确描述内容**（Target Heading / Click me 按钮 / a-b-c 列表——与测试页完全吻合）③ 复述批注意见（8px 12px）。**P2「批注 → 会话 → pi 据此理解」全链路实证可行**；重跑命令见 §4.4。

## 3. 对探针清单（exploration.md §8，11 项）的结算

| # | 探针 | 结算 |
|---|---|---|
| 1 | 多实例/OSR 共存 | **闭环**（运行时多开 PASS + OSR 渲染进 Swing 目视确认；前台帧率量化留 GUI） |
| 2 | DevTools 可用性 | **大半闭环**：console/网络事件形状、注入通道、截图全部实证；`setEnableOpenDevToolsMenuItem` 存在（243）；DevTools UI 形态留实现期 |
| 3 | 元素选取/样式/截图 | **闭环**（CDP 全 PASS，含 CSP 对注入的影响） |
| 4 | 批注覆盖层 | 数据面闭环（shadow DOM 注入可行）；overlay 与页面事件共存留实现期 |
| 5 | 承载双形态 | 内核层已验证（windowed/OSR/低层 create 全通）；编辑器 FileEditorProvider 形态留实施 spec |
| 6 | URL 安全边界 | **定论改写**：cookie jar 全局共享（CDP 与隔离 context 双证实）→ request context 隔离 API 不可用（CEF 122），安全模型按「无隔离」设计 |
| 7 | 批注数据形状 | **闭环**（含模型消费：pi 准确读图+读 JSON+复述批注） |
| 8 | HealthMonitor TOPIC | **定论**：243 **不存在**该类 → 全线崩溃判定用 `onRenderProcessTerminated` + `onLoadError`；TOPIC 仅 2025.2+ 可用 |
| 9 | request context 隔离 | **定论**：API 存在但**不隔离 cookie**（createContext 实测共享）→ 当前 JCEF 面不可实现 |
| 10 | 弹窗/下载/证书默认行为与放行 | **全部闭环**：弹窗默认开新窗 + LifeSpanHandler 返回 true 拦截成功；下载默认消失 + handler 原生路径落盘成功；证书默认 interstitial + handler Continue() 放行成功 |
| 11 | windowed vs OSR 帧率 | 半闭环：OSR 通路 OK，后台 throttle 均 ~30fps；前台量化留 GUI 项 |

## 4. 未尽事项（等你指挥再动）

1. ~~探针插件~~ **✅ 已完成（2026-11-17 下午，见 §1.5）**——弹窗拦截/证书放行/下载落盘/隔离实测/API 面全部拿到定论。
2. **GUI 项**（仍开放）：前台 FPS 量化（沙盒窗口置前后跑 fps.html）；HTML 内嵌预览/Markdown OSR 平台面对照；Swing 地址栏中文输入法手感（需真人输入）。
3. **过期证书**：CEF 的 `ERR_CERT_DATE_INVALID` 与域名不符同类处理（大概率随 Continue() 同通），可留实现期顺手验。
4. ~~模型消费重跑~~ **✅ 已完成（2026-11-17）**：`--model openrouter/free` 即通（本机日常默认就是它；首轮 402 是落到付费模型所致）。可复跑命令：
   `cd D:/code/probe-042/pi-project && PI_CODING_AGENT_DIR=/d/code/probe-042/pi-sandbox pi -p --model openrouter/free @annotation-context.json @annotation.png "…"`。消费成功的会话证据在 sandbox sessions 目录第二条 jsonl。

## 5. 资产与痕迹清单

| 路径 | 内容 |
|---|---|
| `D:\code\probe-042\` | server.mjs（HTTP 8771 + HTTPS 8772/8773/8774）、certs/（四证书）、probe.mjs / probe-round2.mjs / probe-round3.mjs、各轮日志、annotation.png、pi-sandbox/（auth 副本+会话）、pi-project/（批注素材） |
| 真机改动 | probe 期间 `/json/new` 开过 11+3 个 tab（已全部 `/json/close`）；`~/Downloads` 无残留；scratch pi 会话 1 个（含 402 失败记录，无害） |
| 仓库 | **零 diff**；本文件 untracked，未 commit。 |

## 6. 一句话总结

**P2 批注回流整条数据链（采集 → pi 消息形状 → 模型消费）与 P0 全部关键通路（弹窗拦截/证书放行/下载落盘/崩溃判定 API）均已在真机+沙盒实证闭环**；唯一被推翻的设计假设是「request context 可隔离 cookie」——CEF 122 的 `createContext` 不隔离，042 安全模型须按 cookie jar 全局共享设计（与竞品「不承载登录态」合流）。剩余只有 GUI 手感项（前台 FPS、IME、平台预览对照）。

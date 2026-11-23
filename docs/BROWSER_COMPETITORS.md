# 内嵌浏览器竞品能力矩阵（BROWSER_COMPETITORS）

> 汇总日期：2026-11-20。由四份独立调研的矩阵行合并而成（JetBrains 生态 / VS Code 系 / Agent 工具竞品 / 云工作区与端口面），重复能力点已去重合并、按竞品分组，**每行保留来源与「未验证」标注**，未臆测。
>
> 成本口径：**S ≈ 1 天内；M ≈ 2–5 人日；L ≈ 1–2 周以上或需等平台能力**（四份调研口径略有差异，取中间值）。受 `docs/ARCHITECTURE.md` §13（本文件 :247/:254）约束——`INTERNAL_API_USAGES` 会拒稿、支持下限 sinceBuild=233——任何跨版本平台 API（如 JBCefHealthMonitor 仅 2025.x+、CefDevToolsClient 233 缺位）需反射或版本分支，故 M/L 估计偏保守。
>
> 本次汇总员的复核记录（本机实跑）：`ls` browser/ 包 34 个源文件；grep 核实 PiBrowserManager.kt:130（MAX_TABS=4）、PiBrowserKernel.kt:169 与 toolwindow/PiAgentPanel.kt:558（JBCefApp.isSupported 双门禁）、BrowserPanel.kt:397（无 CefFindHandler）、PiBrowserKernel.kt:293/:297（find/stopFinding）、JcefBrowserZoom.kt:69-77（setZoomLevel）、PiBrowserCookieActions.kt:20/:31（clearAll/clearFor）、PiBrowserHistory.kt:39（MAX_ENTRIES=20）、PageSnapshot.kt:32（MAX_TEXT_CHARS=3000）、AgentBrowserTool.kt:131（recentConsoleLines(5)）、DevServerProbe.kt:15-18/:74（netstat/ss/lsof + looksLikeHtml）、AgentBrowserRequest.kt:8-9（仅 OPEN/READ/RELOAD）；`git show backup/release-0.5.10-browser-pre-reset:specs/049-browser-agent-and-links/spec.md` 确认 049 spec 全文在 backup 分支（worktree 的 specs/ 目录只到 048）；048 spec §四 Non-goals（:56-62，F-215/F-201/F-208）与 ARCHITECTURE §13 均读码确认。其余竞品侧证据来自四份调研的抓取记录，本文如实转写。

## 〇、一句话速读

**预览基座（地址栏/历史/查找/缩放/下载/多页签/编辑器双形态）已对齐或全面超出 VS Code 系与 JetBrains 平台内置**；三大真差距依次是：① agent 交互工具（竞品 7–10 个子动作 vs 我们 3 个）、② 元素级人工回流（Send element / Add to Chat，四家竞品都有）、③ 历史/书签等管理面（多属纯 UI 工作）；隔离/无痕、远程代理、IDE 内嵌 DevTools 属**平台硬限制**而非产品缺陷（详见 §八）。

---

## 一、JetBrains 生态

### 1.1 JetBrains IDE 内置 Web Preview 编辑器（平台捆绑）

| 能力 | 竞品有什么 | 我们有没有 | 差异 | 成本 | 适配判定 | 来源 |
|---|---|---|---|---|---|---|
| HTML 文件内嵌预览（OpenHtmlInEmbeddedBrowser 动作 → 编辑器页签内 JCEF 渲染，走内置服务器，SHIFT=file://，HIDE_DEFAULT_EDITOR） | 有 | **有** | 平台版是纯文件预览器（WebPreviewFileEditor 只 reloadPage：无地址栏/历史/下载/弹窗处理，强制白底 Color.WHITE）；我们有地址栏+历史导航+Bing 直搜+下载 handler+弹窗通知+主题底色融合+错误卡，全面超出 | S | 适配——已交付且更强，属差异化项 | [J1]（intellij-community 源码经 gh api 抓取核实）；[J2]；我方 browser/ 34 文件 |
| Live Edit 式自动重载（预览按 ReloadMode 在保存/输入时自动刷新，默认 reload-on-save） | 有 | **没有** | 我们的本地 HTML 预览是一次性快照路由（PiBrowserPreviews 单次 token），刷新靠手动；无文件变更监听自动 reload | S | 适配——对插件 temp 预览文件挂 file watcher → kernel.reload 即可 | [J2] + WebPreviewFileEditor.kt（reloadPage/ReloadMode）；我方 specs/048 plan D10、changelog.d/048-browser-preview-reload.fixed.md |
| Markdown 分屏实时预览（双栏/滚动同步/导出 PDF-HTML/Mermaid/TeX/自定义 CSS） | 有 | 部分 | 平台管「项目 .md 文件的编辑器分屏预览」；我们管「pi 会话输出渲染」——038 diff/脚注、039 inline SVG、040 KaTeX+Mermaid、041 代码块进 IDE、047 渲染消息复制为图片。两边不做同一件事 | S | 不适配——平台已有，插件重复建设无价值；会话渲染面已对齐平台水准 | [J3]；我方 changelog.d/038-*/039-*/040-*/041-*/047-* |
| 内置服务器（默认 63342）承载 Open in Browser / 预览，可开外部连接与 unsigned requests | 有 | 部分 | 我们的 LocalUiServer 只服务插件自身 webui/一次性预览路由（token 鉴权），不对用户项目开放通用静态服务 | S | 不适配——平台已有该面，重复造轮子；且内置浏览器 token 零进入的硬约束要求两者隔离 | [J2]；我方 specs/048 §五硬约束 1 |
| 通用浏览器工具窗（任意 URL 地址栏导航/前进后退/多页签） | **平台捆绑面不存在此形态**（设置页只有外部浏览器+文件级预览） | **有** | 无——048 核心交付，领先平台本体：地址栏+历史下拉+搜索直搜+Ctrl+F 页内查找+Ctrl±缩放+多 Content 复用（上限 4）+编辑器呈现双形态 | S | 适配——已交付，是我们的差异化基座 | [J2]；我方 specs/048、changelog.d/048-in-app-browser-p0.added.md、browser/ 34 文件（本次 ls 核实） |
| ⚠ Web Preview 对 alert/prompt/下载的处理行为 | 未验证 | 有（下载拦截+弹窗通知） | 平台版源码（WebPreviewFileEditor）无相关 handler，仅确认无显式处理面；**运行时行为未验证** | — | — | [J1]（源码层面确认；运行时未验证） |

### 1.2 JetBrains Chrome DevTools Connect（官方插件，2026.3 起捆绑 WebStorm）——本次调研最有价值的竞品

| 能力 | 竞品有什么 | 我们有没有 | 差异 | 成本 | 适配判定 | 来源 |
|---|---|---|---|---|---|---|
| agent 经 MCP 模块驱动真 Chrome 测试 web app：开页/点击/填表/对话框、读 console+network、截图+DOM+a11y 树快照、视口/暗色/慢网模拟、性能 trace、Lighthouse 审计 | 有 | 部分 | 我们有 pi_browser open/read/reload + console 错误回读 + loopback 端口自动探测；但缺：点击/填表等页面操作、截图回流、DOM/a11y 快照、视口模拟、trace/Lighthouse。**架构差异：官方走外部 Chrome（默认无头临时 profile，可选连用户 Chrome），我们走 IDE 内嵌 JCEF 页签（用户看得见）** | M | 适配——042 P1/P3 既定方向；CDP Input.dispatchMouseEvent 真机已实证（P-10），pi_browser 工具协议可扩展；IDE 内可见页签是相对官方的差异化 | [J4]（Marketplace API 已抓取：xmlId com.intellij.chromeConnect，模块 intellij.chromeConnect.mcp，仅 263.*，2026-10 首版）；我方 changelog.d/049-agent-browser-tool.added.md、browser/AgentBrowserTool.kt、PageSnapshot.kt、BrowserConsoleBuffer.kt、DevServerProbe.kt |

### 1.3 JetBrains AI Assistant / Junie / Air / Fleet

| 能力 | 竞品有什么 | 我们有没有 | 差异 | 成本 | 适配判定 | 来源 |
|---|---|---|---|---|---|---|
| AI Assistant `/web` 命令：聊天内网页搜索，抓取文档/排障资料（2025.1.2 起） | 有 | 没有 | 本插件不自建网页搜索/抓取；该能力属 pi agent 侧（pi 的 fetch/MCP 配置面），插件可做引导而非实现 | S | 适配——以 pi 侧 MCP/webfetch 形态落地，非 JCEF 面；**pi 侧现况未验证，不臆测** | [J5]（原文引用已核实） |
| Junie agent 工具面：文件编辑/终端命令/MCP servers/Debugger MCP Toolset（IDEA Ultimate）；浏览器+网页搜索请求 JUNIE-50 已置 Done（2026-08），2026.3 实际落地物是 Chrome DevTools Connect | 有 | 部分 | pi 已有等价的浏览器工具（pi_browser），但交互深度（点击/截图/模拟）弱于官方 chrome-devtools-cli；Junie 的 debugger 工具与本插件定位无关 | M | 适配——补 pi_browser 交互深度即对齐官方 agent 浏览器工具的水位 | [J6]（已核实）；[J7]（YouTrack API 本次查询：State=Done、resolved≈2026-08-19）；⚠ JUNIE-50 官方交付物未逐条核实（推测经 Chrome DevTools Connect/搜索层落地） |
| Air（2026.3 起随 IDE 分发的 agentic 工作区）：ACP 多 agent 工作区（Codex/Claude/Junie/OpenCode 等，含 pi 后端桥接）+ GenUI——agent 生成 UI 用 JCEF 沙箱页（app-sandbox.html/专用模块/自有资产协议）渲染 | 有 | 没有 | 无 agent 生成富 UI（GenUI）的渲染面；且官方 Air 插件已把 pi 列为可桥接后端，与本插件形成竞合 | L | 不适配——GenUI 是官方产品域，插件补位无意义；其沙箱模式值得本插件 P1/P2 注入通道借鉴 | [J8]（Marketplace API 已抓取，1.1M 下载）；GenUI JCEF 沙箱证据：jcef-knowledge skill references/official-usage-map.md + intellij-community 源码；⚠ 来自本机 2026-11 磁盘取证，本次未重跑验证 |
| Fleet Web Preview（Fleet 时代的内嵌网页预览） | 有 | 有 | 无对照意义：Fleet 已于 2025-12-22 停止分发，2026-05 官宣并入 Air；其 web-preview 文档页已下线（help 链接 301 到 the-future-of-fleet 博客） | S | 不适配——产品已消亡；继任者 Air 见上 | [J9]（已核实：12/22 停止下载、Air 接棒） |

### 1.4 平台形态限制（JetBrains Client / Android Studio / cookie profile）

| 能力 | 竞品有什么 | 我们有没有 | 差异 | 成本 | 适配判定 | 来源 |
|---|---|---|---|---|---|---|
| 远程会话中在瘦客户端内渲染 JCEF 预览（JetBrains Client / Gateway） | 有 | 部分 | 官方口径：瘦客户端历史上不支持 JCEF，JCEF UI 只跑宿主侧、插件需拆分前后端；2025.x out-of-process + intellij.jcef.frontend 在铺路但未收敛（PhpStorm 2025.2 EAP 曾报 Windowed_rendering 错）。我们已有 isSupported() 门禁+降级错误卡（远程客户端内浏览器入口会降级），但**插件在 JetBrains Client 的整体行为未实测** | L | 受平台限制——等平台拆分收敛；我们能做的是保证降级路径可预期（已具备） | [J12]（jcef-knowledge skill，本机 2026-11 磁盘取证）+[J10]；⚠ 2025.x 拆分收敛进度未逐条复核 YouTrack；我方 browser/PiBrowserKernel.kt:169、toolwindow/PiAgentPanel.kt:558（本次读码核实） |
| Android Studio 的 JCEF 内嵌浏览器（捆绑 JBR 不含 JCEF，Google issue 159933628 多年未解） | 无 | 部分 | Android Studio 下我们无法提供浏览器/预览（平台限制）；已具备 isSupported() 门禁与「入口置灰/提示不崩溃」的降级（048 验收口径明文要求） | L | 受平台限制——除非用户手动换 JBR-with-JCEF（社区做法） | [J11]（经 jcef-knowledge skill 转引）；我方 specs/048 验收口径 + PiBrowserKernel.kt:169 |
| 全局 JCEF cookie profile：登录态持久化（243 起 jcef_cache 无条件落盘，全局共享 cookie jar，跨 IDE 重启保留；无分区隔离 API——CEF 122/262 createContext 无 settings 参数） | 有 | 部分 | 共享 profile 的表单登录可用+清除动作已有（PiBrowserCookieActions.clearAll/clearFor），但无隔离——048 明文 non-goal「不承载敏感登录态」，隔离待平台 CEF partition API | L | 受平台限制——隔离能力等平台；现状按「共享」安全模型设计并已文档化 | [O2]（048 spec :60，含本机 jcef_cache 28KB Cookies 实证）+ PiBrowserCookieActions.kt:20/:31（本次读码）；平台侧 [J12] |

---

## 二、VS Code 系

### 2.1 VS Code Integrated Browser（1.109 引入，1.119 进主版本；本插件「IDE 内置浏览器」定位的直接对标）

> 时效说明：1.109（2026-01）→ 1.119（2026-05-06）约四个月完成「预览基座→agent 工具→页签共享」三级跳；截至调研日（2026-11-20）1.120+ 未逐版核查，口径以 1.109/1.110/1.119 三份官方 release notes 与 integrated-browser 官方文档为准。⚠ 有搜索摘要声称「Browser tools GA (July 2026)」，未能在官方页面核实到，未采信。

| 能力 | 竞品有什么 | 我们有没有 | 差异 | 成本 | 适配判定 | 来源 |
|---|---|---|---|---|---|---|
| 预览基座：命令面板输入 URL 打开内嵌预览（Simple Browser，v1.56 起，webview iframe 基座，已被 1.109 取代） | 有 | **有（且更强）** | Simple Browser 受 iframe 限制：不能登录、Google/GitHub/StackOverflow 打不开；我们是 JCEF 真浏览器无此限制；差距只在它是零安装内置、我们是插件 | S | 适配——该形态是我们 048 已交付能力的子集 | [V1][V2] |
| 页面元素批注回流：Add Element to Chat / Comment on Elements（Ctrl+Alt+C）/ 元素截图+HTML+CSS 附进聊天 / console logs 加入聊天，元素评论回流给 agent 做精确修改 | 有 | **没有** | agent 读回只有整页文本快照；无元素级选取/评论回流——这正是 042 P2 的差异化核心，也是 Codex App/Cursor 的范式 | M（合并四条来源后取中） | 适配——注入高亮+CDP DOM 查询+既有 pi_browser 通道可承载；「批注回流」的具体形态 | [V1]（vscode-ib.md:261-314）；我方 specs/042 §四能力分层 |
| agent 浏览器工具（1.110 Experimental，workbench.browser.enableChatTools）：openBrowserPage/navigatePage/readPage/screenshotPage/clickElement/hoverElement/dragElement/typeInPage/handleDialog/runPlaywrightCode，免装依赖 | 有 | 部分 | 我们的 pi_browser 只有 open/read/reload（真机 PASS）+免 URL 端口探测（0.3s 命中）；内核已有 tap 注入与 executeJavaScript 但未暴露 type/hover/drag/对话框处理，无截图能力，console 回读仅加载后错误（加载期错误为结构性限制） | M | 适配——042 记为 P3，但竞品已落地且是我们同类用户的核心诉求 | [V4]；我方 run-report 049 复验轮 2（F-206 部分 PASS/F-214 PASS） |
| 页签共享与隔离（1.119）：Share with Agent 显式批准/一键撤销、agent 自有 ephemeral 隔离会话、autopilot 自动拒绝分享请求、企业域名管控 | 有 | 没有 | 我们的 agent 工具直接驱动共享 profile 的 IDE 内页签，无批准/撤销/隔离语义；「人开的页签继承登录态、agent 开的页签用隔离临时会话」隐私模型我们没有 | M-L | 适配（一半）——批准/撤销语义本身可先做（与 pi 侧审批面的衔接现况未验证）；隔离那半受 CEF partition API 限制 | [V5][V1] |
| 多页签管理：Quick Open Browser Tab、页签放置（activeGroup/sideGroup 锁定侧组/独立辅助窗口）、Ctrl+click 开新页签、关闭全部（含分组） | 有 | 部分 | 我们是同一工具窗按 URL 复用/新建 Content、上限 4（F-208，真机 2+ 页签共存已验）；无标签管理 UI（048 non-goal）、无关闭全部、无侧组/浮动窗口形态、Ctrl+click 不分叉新页签 | M | 适配——JBPopup Quick Pick + Content 管理是平台标准件 | [V1]（vscode-ib.md:152-182）；我方 PiBrowserManager.kt:130、run-report 049（F-208 PASS） |
| 地址栏联想 picker（收藏/历史/已开页签随键入过滤）+ 可选搜索引擎直搜（Bing/Google/DuckDuckGo） | 有 | 部分 | 我们有搜索词直搜但仅 Bing（且 IME 受限、中文靠粘贴，F-212 已进 0.5.10）；地址栏历史只做最近访问下拉（内存 20 条）；无收藏、无联想 picker、无搜索引擎选择 | S-M | 适配——联想器（document listener+JBPopup）048 已记二期 | [V1]（vscode-ib.md:97-130）[V3]；我方 PiBrowserHistory.kt:39、048 spec :61/:80 |
| 浏览器历史管理面板：按天分组/标题或 URL 搜索/单条删除/清空/跨 IDE 重启持久化/默认 200 条可调（ephemeral 域除外） | 有 | 没有 | 历史只存活在会话内地址栏下拉；跨 IDE 重启持久化被 048 列为 non-goal（需先做 URL 隐私决策，F-201 修订口径） | M | 适配——隐私决策先行即可动工 | [V1]（vscode-ib.md:132-150）；我方 specs/048 §四 |
| 数据存储域三态 global/workspace/ephemeral（untrusted 工作区强制 ephemeral，类似隐身） | 有 | 没有 | 登录态/cookie 隔离被 048 明确推迟（CEF partition API 缺失，F-215 等待 CEF 144+ API），当前全局共享持久 profile，安全模型按「不承载敏感登录态」设计 | L | 受平台限制——CEF 122/144 的 createContext 无 partition/settings 参数，非纯工作量问题 | [V1]（vscode-ib.md:332-346，原文「Similar to incognito mode」）[V3]；我方 048 spec §四 |
| localhost/0.0.0.0/[::1] 链接 IDE 全局默认进内置浏览器（openLocalhostLinks 可关，externalBrowser 可选 edge/chrome/firefox/路径） | 有 | 部分 | 我们的三态外链设置（系统浏览器默认/内置/每次询问）只作用于聊天面板外链（037 语义不变）；IDE 其他位置（终端/编辑器）的链接由平台路由、改不了默认跳转；agent 工具另有免 URL 自动探测 dev server 端口 | S-M | 适配——在外链路由设置里加「localhost 默认内置打开」域名规则即可，与 049 US1 选择器兼容 | [V1]（vscode-ib.md:60）；我方 048 spec US4 |
| IDE 内嵌 DevTools（浏览器工具栏直接开关，Elements/Console 在 VS Code 内） | 有 | 部分 | 我们 DevTools 走平台 openDevtools() → cef_server 原生弹窗（UI 不归插件管、无法内嵌进 IDE）；本机曾因 JCEF GPU 进程连环崩溃白屏，已做 052 日志探测+「禁用 GPU 并重启」一键处置；自建 IDE 内检查器路线实测 getDevToolsClient() 静默降级不可靠 | L | 受平台限制——JCEF DevTools 是 cef_server 原生窗口，插件无法接管其 UI | [V1]；我方 run-report 049 DevTools 查证/修复批 + 052 批 |
| 远程代理预览：SSH/WSL/Dev Container/Codespaces/远程 agent host 下 http(s) 流量走远程，免端口转发（实验开关 enableRemoteProxy） | 有 | 没有 | JetBrains 远程开发形态下 JCEF 在前端，localhost 语义错位；插件未建任何远程代理通道 | L | 受平台限制——VS Code 官方也注明不支持非 VS Code 的 agent host；JetBrains 侧需依赖 Gateway 端口转发设施，插件层难独立实现 | [V1]（vscode-docs 仓库 md 核验） |
| 本地 HTML/htm/mhtml 右键「Open in Integrated Browser」+ 文件改动自动重载（autoReloadOnFileChange） | 有 | 部分 | 我们有右键「在 Pi 浏览器中打开」+ 导出通知直达预览 + 刷新可用；但本地文件走一次性只读预览路由（安全约束不走 file://），且无改动自动重载 | S-M | 适配——自动重载见候选 #3 | [V1]；我方 048 spec US3 + changelog 048-browser-preview-reload |
| per-site 权限：地理位置/摄像头/麦克风/剪贴板/蓝牙 USB 串口按站点弹授权，Site Permissions 面板可管理 | 有 | 没有 | 无权限询问机制（CEF 默认行为静默）；本地 dev 场景最常见的是剪贴板/通知/摄像头（视频测试页） | M | 适配——CefPermissionHandler + JBPopup 询问 + 按 origin 记忆，标准平台件 | [V1]（vscode-ib.md:318-330） |
| 页面缩放（workbench.browser.pageZoom；聊天面板与浏览器共用缩放口径） | 有 | **有** | 已实现 Ctrl +/-/0 页面缩放（CEF setZoomLevel 公开 API），且覆盖 chat 面板保持一致——无差距 | S | 适配——已达成 | [V1]；我方 JcefBrowserZoom.kt:69-77（F-205） |
| 弹窗策略：popups blocked but new tabs allowed；Ctrl+click 新标签；agent 同域已开页签时提示共享 | 有 | 部分 | 我们更激进：target=_blank 一律同视口接续（048 US5），永不新开页签；用户没有「按住修饰键开新页签」的逃生门 | M | 适配——在既有 popup 拦截 handler 里识别 Ctrl/中键并允许新 Content（上限 4 内），不破 US5 默认语义 | [V1]（vscode-ib.md:86-87）；我方 048 spec US5 |

### 2.2 VS Code Live Preview（微软官方扩展 ms-vscode.live-server）

| 能力 | 竞品有什么 | 我们有没有 | 差异 | 成本 | 适配判定 | 来源 |
|---|---|---|---|---|---|---|
| 嵌入式浏览器：URL 栏+页历史跟踪+外部浏览器移交+页内查找（Ctrl+F）+webview DevTools+本地静态服务器 | 有 | **有** | 无实质差距：地址栏/历史下拉/Ctrl+F 查找/DevTools 入口/系统浏览器移交全部对齐（049）；我们另有官方扩展没有的下载落盘、弹窗处理、GPU 崩溃护栏、agent 工具 | S | 适配——已对齐，无需动作 | [V6]（README 经 GitHub API 抓取） |
| 托管本地静态 server + 打字/保存自动刷新（autoRefreshPreview 三态、data-server-no-reload 页级 opt-out） | 有 | 没有 | 我们不托管 server：打开已有 localhost（agent 免 URL 自动探测端口）、本地 HTML 走一次性预览快照；「改文件→预览自动刷新」闭环不存在（仅手动刷新/重载） | M | 适配——可复用端口探测+起静态 server；但 JetBrains 用户多已有 dev server，优先级可议 | [V7] + [V6] |
| 预览三形态（编辑器 tab / side panel / 外部浏览器）+ Show Debug Preview（内嵌预览挂 js-debug/Edge Tools 断点调试） | 有 | 部分 | 我们有工具窗页签+编辑器页签双形态+一键系统浏览器外开；无「预览即调试」（断点/变量/步进）——JetBrains 侧等价物需 CDP 挂调试器，而本机实测 debug.port 默认 -1、CDP 端点不可靠 | L | 受平台限制——CDP 路线在 JCEF 默认配置下不成立（run-report 049 插件侧路线查证已排除） | [V6]；我方 run-report 049 DevTools 路线查证段 |
| server 流量日志任务（点流量条目直接打开所服务文件） | 有 | 没有 | 我们不托管 server，无请求流量可视面 | S-M | 不适配——不托管 server 则流量面板无从产生；该项归属 server 起源方职责 | [V6] |

### 2.3 微软 Edge Tools for VS Code（ms-edgedevtools.vscode-edge-devtools）

| 能力 | 竞品有什么 | 我们有没有 | 差异 | 成本 | 适配判定 | 来源 |
|---|---|---|---|---|---|---|
| 「Edge DevTools: Browser」内嵌页签 = headless 浏览器 + screencast 截屏流 + 设备仿真工具条 | 有 | 部分（形态不同） | 我们是 JCEF 直嵌真渲染，交互完整性优于 screencast（官方文档承认其 screencast 不支持 drag-drop、onPaste 事件、不尊重 cursor）；缺设备仿真/视口切换工具条（042 P1 视口/响应式方向） | M | 适配——直嵌渲染是我们的形态优势，不需要 screencast；补视口切换即可 | [V8] |
| Inspect 工具（hover 元素 → 覆盖层 + grid 高亮 → Elements 定位） | 有 | 没有 | 042 P2 元素选取的另一半；我们既无 DOM 悬停高亮也无选取-定位联动 | M-L | 适配——依赖 JS→Java 受控通道，042 已规划通道形态 | [V9] |
| CSS Mirror Editing（Styles 面板改动经 sourcemap 回写 .css/.html 源文件，含 Sass/React，不自动保存由用户决定） | 有 | 没有 | 042 P3「CSS/文本就地编辑回写」仅记方向；实现依赖 DevTools 协议通道（本机 getDevToolsClient 实测静默降级不可靠）+ sourcemap 映射 | L | 适配——差异化方向正确，但受 CDP 通道可靠性制约，需先解通道 | [V9] |
| Console/Network/Application/Issues 面板在 IDE 内 + VS Code 调试工作流集成（断点） | 有 | 部分 | 我们有 DevTools 原生弹窗入口（Elements/Console/Network 齐全但在独立窗口，GPU 白屏史）+ agent 工具回读 console.error；无 IDE 内嵌面板、无断点调试 | L | 受平台限制——同 §2.1 DevTools 内嵌条目 | [V9][V10] |

### 2.4 第三方扩展（生态证据）

| 能力 | 竞品有什么 | 我们有没有 | 差异 | 成本 | 适配判定 | 来源 |
|---|---|---|---|---|---|---|
| Live Server（Ritwick Dey）：静态页 server + live reload 打到外部浏览器（CustomBrowser 可配、网页扩展版支持动态页） | 有 | 没有 | 纯外开方案、无内嵌预览；与官方 Live Preview 能力重叠，对我们边际价值低 | M | 不适配——与官方 Live Preview 行重叠，用户已被官方集成收敛 | [V11] |
| [Deprecated] Browser Preview（auchenberg）：headless Chrome 内嵌预览（简单浏览器类扩展代表） | 有 | —（无需对标） | 2021-09 官方弃维，Marketplace 标题已带 [Deprecated] 并指路 Live Preview；印证「简单浏览器类扩展」生态已被微软官方内置取代 | S | 不适配——已死生态，仅作趋势证据 | [V12] |

### 2.5 VS Code Copilot（changelog 镜像取证）

| 能力 | 竞品有什么 | 我们有没有 | 差异 | 成本 | 适配判定 | 来源 |
|---|---|---|---|---|---|---|
| Simple Browser 元素选取：用户在页内选元素 → 元素截图+HTML+CSS 附进聊天（chat.sendElementsToChat） | 有 | 没有 | 同 Windsurf Send element 行：无元素级上下文回流 | M | 适配——与 Windsurf 行同一实现（JCEF JS 拾取 + 聊天 chip），agent 联动价值大 | [V13]（1.100/1.101 段，changelog 镜像已 grep 原文） |
| agentic browser tools（1.110 实验，Playwright 基座）：openBrowserPage / readPage / screenshotPage / clickElement / typeInPage / runPlaywrightCode | 有 | 部分 | openBrowserPage/readPage 有等价（pi_browser open/read）；screenshotPage/clickElement/typeInPage 缺；runPlaywrightCode 无（我们非 Playwright 驱动） | M | 适配（前三者）；runPlaywrightCode 受平台限制——需页面级 CDP 替代执行任意脚本；其 readPage/screenshotPage 的拆分粒度值得抄：read 只回结构化信息、截图单独一个动作 | [V13]（原文已 grep；⚠ GA 时间（2026-06）来自搜索摘要未逐一复核） |
| #fetch 工具：headless 渲染页面、本地缓存、可反复读 | 有 | 没有 | 缺独立 fetch（早期 JS 禁用版都比我方「必须占用页签」轻量） | S | 适配——低价值但便宜；优先级排在 click/screenshot 之后 | [V13]（#fetch 段） |

---

## 三、Agent 工具竞品（浏览器作为 agent 的手和眼）

### 3.1 Cursor（官方文档全文抓取）

| 能力 | 竞品有什么 | 我们有没有 | 差异 | 成本 | 适配判定 | 来源 |
|---|---|---|---|---|---|---|
| agent 驱动子动作集：navigate / click / type / scroll / screenshot / console / network（7 个子动作一个工具内） | 有 | 部分 | 053 已补 scroll（视口移动 + scrollY 随快照回）与 read selector 元素摘录（outerHTML/innerText，AgentBrowserRequest.kt SCROLL/CONSOLE 枚举）；仍缺 click/type/screenshot/network | M | 适配——同款 JS 注入通道已随 053 落地验证；click/type/截图留待下一批（候选 #9/#10） | [A1] |
| agent 以图像读页面（截图走文件读取通道，agent「看」页面而非读文字描述） | 有 | 没有 | 只回 title/url/readyState/正文摘录/最近 5 条 console 错误（AgentBrowserTool.kt:131-158），布局与样式问题只能靠文字猜 | M | 适配——windowed JCEF 截图需页面级 CDP（本机实证裸 CDP 路径可行，浏览器级 connectOverCDP 不可用）或 OSR 截屏；agent 联动价值大项 | [A1] |
| console/network 日志落盘供 agent 按需 grep（返回行数+预览片段，省 token） | 有 | **有**（console）| 053 console 回读已落地：单调序号+dropped 计数、since/limit 分页、有界行预览 + JSONL 落盘供 grep（BrowserConsoleBuffer.kt + ConsoleLogFile.kt）；network 记录仍无（需 CDP，另算） | —（console 已对齐） | 适配——network 留待 CDP 批次 | [A1]；我方 BrowserConsoleBuffer.kt、ConsoleLogFile.kt、specs/053 |
| dev-server 自动检测（避免 agent 重复起服务器/来回试探端口） | 有 | **有** | 行为已对齐：无 URL open 自动探测 loopback 端口（DevServerProbe.kt:15-18/:74，常见端口启发式优先 + netstat/ss/lsof 兜底），还额外排除插件自身聊天 SPA 端口 | —（已对齐） | 适配 | [A1]（官方文档明确记载 dev-server detection）；我方 DevServerProbe.kt、run-report 049（F-214 PASS） |
| 浏览器会话持久化与隔离（cookie/localStorage/sessionStorage/IndexedDB per-workspace） | 有 | 部分 | 登录态可存储可用但全局共享、无 per-workspace 隔离（048 spec :60 明记隔离推迟：CEF 122 createContext 无 settings 参数） | L | 受平台限制——048 真机探针实证 CEF 122 分区 API 缺失；安全模型已按「共享」设计 | [A1] + [O2] |
| Cursor 2.0：agent 驱动点击/双击/右键/hover/输入/滚动 + 截图直接回流给模型 + console/network 日志落盘可 grep + 人工审批三档 | 有 | 部分 | 只有文本快照读回（innerText≤3000 字符 + console 尾部错误），无交互动作、无截图回流、无 network 流量；049 已把交互/截图列 P2、console/network 列 P2 | L | 适配——CDP 管道已接通（BrowserConsoleBuffer 走 DevTools 事件），主要成本在动作注入与截图回流的前端渲染 | [A1] |

### 3.2 OpenAI Codex

| 能力 | 竞品有什么 | 我们有没有 | 差异 | 成本 | 适配判定 | 来源 |
|---|---|---|---|---|---|---|
| 共享浏览器视图（ChatGPT 桌面/云任务内置浏览器）：open / click / type / inspect rendered state / screenshot / verify，localhost 可达 | 有 | 部分 | 「和 agent 共享同一浏览器视图」我们有（同一页签，AgentBrowserTool 驱动的就是用户可见页签）；click/type/screenshot/inspect 缺；云侧任务浏览器与我们本地 IDE 形态不同不做对齐 | M | 适配（本地桌面部分）；Codex 官方文档明确浏览器在桌面 app 与云任务，CLI/IDE 扩展无 | [A2]（官方文档已全文抓取） |
| 标注模式：用户圈选元素+写评论 → agent 修复（annotation mode） | 有 | 没有 | 无任何页面标注回流；042 路线 P2「批注回流」正是此方向，未实现 | L | 适配——与元素选取（Windsurf/Copilot 行）同族但交互更重，建议排在元素选取之后 | [A2] |
| Developer mode（显式批准的全量 CDP）：profile JS、读 console/network、查 DOM | 有 | 没有 | 无 CDP 接入面；console 只有错误行，无 network/DOM/性能 | M | 受平台限制——JCEF 调试端口需 vmoptions 设置（本机实证可行但非插件默认），不能假设所有用户环境开启 | [A2] |
| Codex App（2026-04 起）：应用内浏览器渲染 localhost/本地 HTML/公开 URL；用户直接在页面上留言给 agent，提交批注自动附截图+相关 DOM 元素；明确不支持认证/cookie/扩展 | 有 | 部分 | 渲染面（含端口自动探测）与 agent 回读（页面文本快照+console 错误）已有；缺「页面上留言批注 → 截图+DOM → 进会话」闭环 | L | 适配——042 P2 既定；认证边界与我们 048 的「不承载敏感登录态」口径一致 | [O1]（042 spec §二，2026-11-16 轻量调研，⚠ 未逐条复核官方文档） |

### 3.3 Cline

| 能力 | 竞品有什么 | 我们有没有 | 差异 | 成本 | 适配判定 | 来源 |
|---|---|---|---|---|---|---|
| browser_action 子动作：launch / click（坐标）/ type / scroll_up / scroll_down / screenshot / close，每个动作后回截图+console | 有 | 部分 | launch≈open、文本回读≈read、console 错误回流已有；缺 click/type/scroll/screenshot/close 五个动作——close 无对应（tab 常驻是合理差异），click 用坐标制（依赖截图循环） | M | 适配——单一工具窗页签天然满足 Cline 的「单会话」约束；加子动作走 JS 注入通道；agent 联动价值最大的一组 | [A3]（apps/vscode/src/services/browser/BrowserSession.ts，已读源码）+[A4]（⚠ 新版 ClineCore 内置工具表已不含 browser_action，浏览器能力保留在 VS Code 应用代码中） |
| 连接用户真实 Chrome：remote browser（CDP remote-debugging-port 9222）+ 3.10 本地 Chrome 集成（用用户已登录会话） | 有 | 没有 | 只能驱动 IDE 内 JCEF 页签，无法借用用户浏览器登录态；fetch_web_content/系统浏览器打开是单向兜底 | L | 受平台限制——插件可做 CDP client 连外部 Chrome，但依赖用户手动开 debug 端口，且 048 安全模型刻意不让内置浏览器承载敏感登录态 | [A5] + [A3]（BrowserSession.ts:114,223） |

### 3.4 Continue（2026-06 被 Cursor 收购、独立产品关停——按收购前文档记录）

| 能力 | 竞品有什么 | 我们有没有 | 差异 | 成本 | 适配判定 | 来源 |
|---|---|---|---|---|---|---|
| fetch_url_content / search_web 内置工具（静态抓取网页内容，不渲染） | 有 | 部分 | 我们的 read 是真渲染 tab（JS 全开）但会占用/切换用户页签；没有一个不打扰用户的纯抓取通道 | S | 适配——LocalUiServer 加一个 fetch 端点或复用 pi 侧 web fetch（⚠ pi 侧是否已带 web fetch 未验证） | [A6] |
| 内置浏览器/预览/截图/console 工具（不通过 MCP） | 双方都没有 | 没有（双方都没有） | Continue 无内置浏览器工具，走 MCP（Playwright MCP 等）；我们以真渲染 tab+console 回流超出其基线，双方均可经 MCP 扩展补齐 | — | 适配 | [A6] + [A7] |

### 3.5 Windsurf / Devin Desktop（Windsurf 官方文档已迁移 docs.devin.ai）

| 能力 | 竞品有什么 | 我们有没有 | 差异 | 成本 | 适配判定 | 来源 |
|---|---|---|---|---|---|---|
| agent 开预览 + console 错误自动进 agent 上下文（preview opened via tool call，代理本地 dev server） | 有 | **有** | 我们等价且更强：agent open 驱动的就是用户可见的同一页签（AgentBrowserTool），console 错误每次成功/失败都随结果回流；差异仅在无「dev server 由会话终端拉起后自动开预览」的时机联动 | S | 适配——监听会话内 run_command 输出触发提示即可 | [A8]（现行官方页已全文抓取） |
| 用户 Send element：点击选中页面元素 → 以 @ 引用进 agent 消息框；console 错误作为待发上下文自动附着 | 有 | 没有 | 聊天里只能贴文本/文件引用，不能把页面上某个元素（HTML/CSS/截图）作为上下文回流给 agent | M | 适配——JCEF JS 注入拾取元素信息 + 聊天 chip 注入；与 042 路线 P2「批注回流」同向，agent 联动价值大 | [A8] |
| Windsurf Cascade（历史版）：browser_preview + browser_console_log 成对工具；页面级 navigate/click/screenshot（出自 Wave 11 系统提示词镜像） | 有 | 部分 | 官方现行文档不再记载 agent 页面级操作（只记用户驱动交互）；历史工具组合中我们有 browser_preview 等价物，缺 click/screenshot | M | 适配（能力本身）；⚠ 来源为泄露提示词镜像，未验证 | [A9]（未验证——泄露源） |

---

## 四、云工作区与端口面

| 能力 | 竞品有什么 | 我们有没有 | 差异 | 成本 | 适配判定 | 来源 |
|---|---|---|---|---|---|---|
| **Gitpod Classic (Ona)**：端口自动检测 + IDE 弹通知——应用开始监听 HTTP 端口即自动暴露并通知用户 | 有 | 部分 | 我们有 DevServerProbe（F-214 loopback 探测，0.3s 命中），但只服务 agent `open` 无 URL 时的兜底，无用户侧「检测到本地服务」通知/提示 | M | 适配——本地等价物是「netstat 探测+工具窗提示一键在 Pi 浏览器打开」，探测逻辑可复用 | [C1]（已抓全文） |
| **Gitpod Classic (Ona)**：端口打开动作配置 onOpen: notify/open-preview/open-browser/ignore（服务起来自动决定预览去向） | 有 | 没有 | 无「dev server 启动后自动在 Pi 浏览器打开」的项目级配置项 | M | 适配——可做成项目设置/Run Configuration 钩子，替代 .gitpod.yml 语义 | [C1] |
| **GitHub Codespaces**：PORTS 面板——手动/自动转发、Set Port Label、HTTP/HTTPS 协议切换、复制 URL、可见性 private/org/public | 有 | 没有 | 无端口管理面板；可见性/分享语义对本地单机无意义，但「已监听端口列表+一键内置打开」的本地等价面板可做 | M | 适配（只取本地等价部分：监听端口列表+打开动作；分享/可见性列不做） | [C2]（已抓全文） |
| **GitHub Codespaces**：终端打印 localhost URL 即自动转发并转成可点链接 + toast 通知 | 有 | 部分 | DevServerProbe 已能探测 loopback HTML 服务（agent 侧），但「用户终端出现 localhost URL → 通知可内置打开」的用户侧链路缺失 | S | 受平台限制——IntelliJ 控制台/终端的超链接由平台路由（默认系统浏览器），插件只能加提示入口，改不了平台默认跳转 | [C2] |
| **Coder**：coder_app/Open Ports 仪表盘——应用图标+healthcheck 健康检查+分享层级 owner/authenticated/public | 有 | 部分 | 无应用级端口注册与健康检查 UI；healthcheck 探测思路与 DevServerProbe 的 looksLikeHtml 探测同源；分享层级本地单机不适配 | M | 部分——健康检查+端口面板适配；分享/公网 URL 部分不适配 | [C3]（v2.37，已抓全文） |
| **Coder Desktop**：VPN 隧道自动转发 workspace 全部端口（<workspace>.coder:PORT，P2P 免配置） | 有 | 没有 | 本地开发无端口转发需求，不适用 | L | 不适配——纯远程场景能力，本地 JCEF 直连 localhost 即可 | [C3] |
| **StackBlitz WebContainers**：浏览器内 Wasm Node 运行时+虚拟 TCP 网络栈映射到 ServiceWorker，localhost 在页面内闭环 | 有 | 没有 | 需 Wasm OS 级工程重写；我们本地有真实 Node/端口，无沙箱闭环需求 | L | 不适配——我们运行在真实本机，端口天然可达；WebContainers 解决的是「浏览器里无后端」问题 | [C4]（官方博客全文） |
| **CodeSandbox**：预览面板——Task 起服务即附着预览 DevTool、可设 Primary Preview、一键独立新标签/窗口打开 | 有 | 部分 | 有工具窗页签+编辑器双呈现（PiBrowserEditorProvider），但预览不附着于任务/进程，无「一键移入独立浮动窗口」形态 | S | 适配——「移入新窗口」是纯 UI 形态工作（VS Code IB 同有 Move into New Window） | [C5]（live 页 403，内容经 GitHub codesandbox/docs 仓库源文件核验） |
| **CodeSandbox**：Element Inspector——点预览中元素 → 编辑器自动打开对应源码 | 有 | 没有 | 无 DOM→源码映射联动；CodeSandbox 官方也标注仅部分 stack 可用（依赖框架 sourcemap） | L | 部分——对 React/Vue sourcemap 场景价值高但工程量大，非 P0/P1 级 | [C5] |
| **CodeSandbox**：预览内嵌全功能 Chrome DevTools（Elements/Console/Sources/Network/Application 面板） | 有 | 部分 | 有 DevTools 独立窗口入口（BrowserPanel.kt:467-470，F-209）+CDP console 缓冲（BrowserConsoleBuffer.kt），无嵌入式面板形态；注意 049 教训：DevTools 空白=GPU 崩溃环（GpuCrashMonitor.kt:30） | M | 适配——CEF DevTools 已打通，嵌入式只是承载形态；需保住 GPU 崩溃护栏 | [C5]；我方 GpuCrashMonitor.kt、052 批 |

---

## 五、通用浏览器基线（Chrome / Edge / Firefox / Chrome DevTools）

| 能力 | 竞品有什么 | 我们有没有 | 差异 | 成本 | 适配判定 | 来源 |
|---|---|---|---|---|---|---|
| 下载中心（Ctrl+J / chrome://downloads / Edge flyout——列表、进度、打开/所在文件夹/删除/清空） | 有 | 部分 | 下载拦截落盘+成败通知已有（PiDownloader + 048 US6/US7），无下载列表面板、无进度与失败重试入口，下载完成后只能靠一次性通知 | S | 适配——把既有下载事件聚合成小面板（列表+打开/在文件夹中显示），复用落盘 handler | [B1][B2]；我方 PiDownloader.kt:31 起 |
| 阅读模式（Edge Immersive Reader F9+朗读+行聚焦 / Firefox Reader View / Chrome 侧栏 Reading mode） | 有 | 没有 | 无 readability 提取与重排版面、无朗读 | L | 不适配——本插件主场景是 dev 预览与 agent 验证，长文阅读是低频旁支，投入产出不划算 | [B3][B4]（⚠ Firefox 支持页被 JS challenge 挡，细节引搜索结果页） |
| 整页截图：Command Menu「Capture full size screenshot」直接产出全页 PNG（另有 viewport/area/node 三式） | 有 | 没有 | 无任何截图能力（全浏览器源码仅 console capture，无 screenshot API 调用）；VS Code IB 同款整页截图也还是实验开关 integrated-browser-full-page-screenshot | M | 适配——CDP Page.captureScreenshot（captureBeyondViewport）+ 落盘/进聊天回流；agent「读回」升级为视觉验证的前置 | [B5][B6] + [V1]（vscode-ib.md:299-308） |
| 区域截图（拖选矩形）与元素截图（Capture node screenshot） | 有 | 没有 | 无区域/节点级截取 | M | 适配——与整页截图同一 CDP 管道，P2 一起做 | [B5] + vscode-ib.md:299-301 |
| 打印为 PDF（Ctrl+P 目的地 Save as PDF） | 有 | 没有 | 无打印/PDF 出口（会话导出有 HTML 无 PDF）；CDP Page.printToPDF 经既有 DevTools 通道可直达 | M | 部分——技术上适配（CDP 通道现成），但开发预览场景低频，优先级低；「会话导出 PDF」或许是更贴合的变体 | [B7] |
| DOM/HTML 抽取：Elements 面板 Copy outerHTML/Copy element、Firefox Copy Outer HTML | 有 | 部分 | agent read 只回 title/url/readyState/innerText 摘录（PageSnapshot.kt:126-136），无 HTML/DOM 结构回读 | S | 适配——read 注入脚本扩展 outerHTML 摘录，或走 CDP DOM.getOuterHTML；对 agent 验证 DOM 结构有直接价值 | [B11]（⚠ Chrome 官方专页未核验到 copy outerHTML 专页，引 SO 高票答案）+ PageSnapshot.kt |
| 页内查找高亮：Ctrl+F 高亮全部命中 +「n/m」匹配计数 | 有 | 部分 | 已有 Ctrl+F 查找条（F-204，find/stopFinding :293-297），CEF 原生高亮+matchCase，但未注册 CefFindHandler → 无匹配计数（BrowserPanel.kt:397 注释明示） | S | 适配——注册 CefFindHandler 即得 activeMatchOrdinal/total，UI 补一位计数文本；**我们领先 VS Code IB（其文档全篇未提页内查找）** | [B10] + BrowserPanel.kt:397（本次读码核实） |
| UA 开关：Network conditions 关掉 Use browser default → 选预设/自定义 UA | 有 | 没有 | 无 UA 覆写；CEF 侧需在 CefRequestHandler/请求头层改写（122 API 形态未验证） | M | 适配——测试后端 UA 分流/移动端适配时有用，属低频开发调试项 | [B8]；⚠ CEF API 形态未验证 |
| 代理开关（Chrome --proxy-server；VS Code IB remote proxy 走远程网络） | 有 | 没有 | 无代理配置；CEF 122 公开 API 无 per-context 代理（需启动参数级全局配置，未验证），会波及 IDE 内其它 JCEF 面 | L | 受平台限制——代理是启动级/IDE 级而非页签级能力，页签级开关做不出 | [B8]（⚠ 代理部分未实测 CEF API）+ vscode-ib.md:352-389 |
| 无痕窗口：临时会话不落盘、关窗即弃 | 有 | 没有 | 同「数据存储域三态」行——cookie 全局共享，无隔离分区可用 | L | 受平台限制——等 CEF partition API；短期内只能文档口径「不承载敏感登录态」 | [B9]（已抓全文核验）+ [O2] §四 |

---

## 六、候选功能清单（按性价比排序）

> 排序原则：S 级、不依赖未验证 API、直接服务 pi agent 主线的排最前；M 级紧随；带前置条件的殿后。★ = 最适合本批次落地。

### 本批次建议（S 级，全部不依赖未验证 API）

| # | 候选 | 类型 | 成本 | 为什么值得（对真实用户 + pi agent 主线） | 参照 |
|---|---|---|---|---|---|
| ★1（✅ 053 已落地，随 0.5.10） | pi_browser 交互第一步：scroll 子动作 + read 结构化扩展（outerHTML/元素查询摘录） | 与 pi agent 联动价值大（JS 注入通道已有先例） | S | 已交付：scroll（down/up，amount 钳 1..10000）与 read selector（outerHTML/innerText，未命中 error 字段），同一 JBCefJSQuery 通道（049 D4 演进为只读 DOM+视口滚动）；真机清单在 specs/053 §七 | [A1][A3][V4][V13]；我方 PageScroll.kt、PageSnapshot.kt、specs/053 |
| ★2（✅ 053 已落地，随 0.5.10） | console 日志落盘 + 按需回读（返回行数+预览片段，省 token） | 与 pi agent 联动价值大（纯 Kotlin + 既有 CDP 缓冲） | S | 已交付：BrowserConsoleBuffer 单调序号+dropped+since 窗口（容量 300），ConsoleLogFile JSONL 落盘（system 目录/仅截断行/超限轮转/绝不进 idea.log），console 响应 {total,dropped,count,lines,file}；真机清单在 specs/053 §七 | [A1]；我方 BrowserConsoleBuffer.kt、ConsoleLogFile.kt、specs/053 |
| ★3 | 本地 HTML 预览文件改动自动重载（file watcher → kernel.reload） | 纯 Kotlin helper 可单测（watcher 逻辑） | S | JetBrains 内置 Web Preview 默认 reload-on-save，我们的快照路由只能手动刷新——唯一落后平台内置预览的点；对插件 temp 预览文件挂 watcher 即可 | [J1][J2] |
| ★4 | 页内查找匹配计数（注册 CefFindHandler） | 需要 JCEF handler | S | Ctrl+F 已有（F-204）但无「n/m」计数（BrowserPanel.kt:397 明示未注册）；补齐 Chrome 基线，且 VS Code IB 无页内查找——保持领先只需一天 | [B10] |
| ★5 | 地址栏联想器（键入过滤）+ 书签收藏 | 纯前端（JBPopup 过滤 model + 持久化 store + 星标） | S | VS Code IB 1.109 已有 favorites+历史联想；我们只有最近 20 条内存下拉（PiBrowserHistory.kt:39）；平台标准件，量小感知强 | [V1]（vscode-ib.md:97-130）[V3] |
| ★6 | localhost/127.0.0.1 域名路由规则（外链设置加「默认内置打开」） | 纯前端（设置项+路由判断） | S | VS Code IB openLocalhostLinks 等价；dev 场景高频路径；与 049 US1 三态选择器兼容，默认行为零变化 | [V1]（vscode-ib.md:60） |
| ★7 | 下载列表面板（列表+打开/在文件夹中显示） | 纯前端（复用 PiDownloader 落盘事件） | S | Chrome Ctrl+J 最小等价；下载拦截落盘 handler 已有（048 US6/US7），只差把事件聚合成面板 | [B1][B2] |
| ★8 | 预览移入独立浮动窗口（Move into New Window） | 纯前端（Content 呈现形态） | S | CodeSandbox/VS Code IB 都有一键形态；复用 PiBrowserEditorProvider | [C5][V1] |

### 紧随批次（M 级，agent 联动主线）

| # | 候选 | 类型 | 成本 | 为什么值得 | 参照 |
|---|---|---|---|---|---|
| 9 | pi_browser 交互第二步：click / type（+对话框处理） | 与 pi agent 联动价值大 | M | 同类用户核心诉求；官方 Chrome DevTools Connect（WebStorm 2026.3 捆绑）已把点击/填表做成水位线；内核已有 tap 注入与 executeJavaScript，主要工作是协议暴露与参数校验 | [J4][V4][A1] |
| 10 | agent 截图回流（screenshotPage：视口起步，整页 captureBeyondViewport 跟进） | 与 pi agent 联动价值大（页面级 CDP 已实证） | M | agent 只能靠 3000 字文本猜布局样式；截图是「读回」升级为视觉验证的前置，也是后续标注模式/区域/元素截图的同一管道底座 | [A1][B5][B6] |
| 11 | 元素级人工回流：Send element / Add to Chat（点选元素 → 选择器+HTML+截图 → 会话 chip） | 与 pi agent 联动价值大（需要 JCEF handler JS 拾取） | M | Windsurf/Devin、VS Code IB、Copilot 三家都有；「把页面上某个元素作为上下文回流给 agent」是 042 P2 差异化核心，用户侧感知最强 | [A8][V1][V13] |
| 12 | 视口/设备仿真切换（响应式宽度/暗色模拟工具条） | 需要 JCEF handler（CDP Emulation 通道） | M | Edge Tools/DevTools 设备仿真与 Chrome DevTools Connect 都有；直嵌真渲染是我们的形态优势（优于 screencast），只缺视口切换 | [V8] |

### 后续批次（M 级，体验补齐，带前置条件）

| # | 候选 | 类型 | 成本 | 为什么值得 / 前置条件 | 参照 |
|---|---|---|---|---|---|
| 13 | dev server 启动监听 → 工具窗提示一键打开（notify 语义） | 纯 Kotlin + UI（复用 DevServerProbe） | M | Gitpod/Codespaces 用户侧感知最强的「服务起来了」通知；agent 侧探测已有（F-214），补用户侧入口 | [C1][C2] |
| 14 | 多页签管理 Quick Pick（切换/关闭全部）+ Ctrl/中键开新页签 | 纯前端 + JCEF handler（popup handler 识别修饰键） | M | 上限 4 的 Content 已真机验证（F-208）；缺管理 UI；Ctrl+click 逃生门不破 048 US5 默认语义 | [V1]（vscode-ib.md:152-182） |
| 15 | per-site 权限询问（剪贴板/通知/摄像头，按 origin 记忆） | 需要 JCEF handler | M | 本地 dev 测试页最常碰的三类权限；CEF 默认静默，CefPermissionHandler+JBPopup 是标准平台件 | [V1]（vscode-ib.md:318-330） |
| 16 | 历史持久化 + 管理面板（按天分组/搜索/删除） | 纯前端 + 持久化；前置：URL 隐私决策（048 F-201） | M | VS Code IB 历史面板等价；决策定了就是标准 UI+持久化工作 | [V1]（vscode-ib.md:132-150） |
| 17 | Share with Agent 批准/撤销语义（agent 访问页签需批准、一键撤销） | 与 pi agent 联动价值大；隔离半边受 CEF 限制 | M-L | VS Code 1.119 隐私模型；「批准/撤销」可先做（与 pi 侧审批面衔接现况未验证），「隔离临时会话」等 CEF partition API | [V5] |
| 18 | UA 覆写（预设/自定义） | 需要 JCEF handler；⚠ CEF 122 API 形态未验证，先探针 | M | 测试后端 UA 分流/移动端适配有用；低频调试项 | [B8] |
| 19 | 独立纯抓取 fetch 通道（不占用/不切换用户页签） | 与 pi agent 联动价值大（低优先级）；⚠ pi 侧是否已带 web fetch 未验证，先查再加 | S | Continue #fetch 式轻量抓取；低价值但便宜，优先级排在 click/screenshot 之后 | [A6] |

---

## 七、明确不建议做的（避免把平台限制当成产品缺陷）

**平台已有、重复建设：**
1. **通用静态文件服务器（对用户项目开放）**——平台 built-in server（63342）已有该面；且内置浏览器 token 零进入的硬约束要求两者隔离。
2. **Markdown 编辑器分屏预览**——平台 Markdown 捆绑插件已有；我们管的是 pi 会话输出渲染（038-041/047 已对齐平台水准）。
3. **GenUI / agent 生成 UI 渲染面**——官方 Air 产品域（随 IDE 分发、1.1M 下载），插件补位无意义；其沙箱模式只作 P1/P2 注入通道借鉴。

**受平台限制、等平台收敛（非产品缺陷）：**
4. **IDE 内嵌 DevTools 面板**——JCEF DevTools 是 cef_server 原生窗口，插件无法接管 UI；自建检查器路线实测 getDevToolsClient() 静默降级不可靠；且有 GPU 崩溃白屏史（052 已做护栏+一键处置）。
5. **「预览即调试」（Debug Preview / 断点）**——CDP 挂调试器在 JCEF 默认配置下不成立（debug.port 默认 -1，run-report 049 路线查证已排除）。
6. **远程代理预览**——JetBrains 远程架构未收敛（瘦客户端 JCEF 缺位、out-of-process 铺路中）；VS Code 官方也注明不支持非自家 agent host。
7. **会话隔离 / 无痕 / 存储域三态（ephemeral）**——CEF 122/262 createContext 无 partition/settings 参数（048 真机探针实证）；等 CEF partition API，现状安全模型按「不承载敏感登录态」文档化。
8. **页签级代理开关**——代理是启动级/IDE 级能力（CEF 122 无 per-context 代理），页签级开关做不出。
9. **连接用户真实 Chrome（借登录态）**——依赖用户手动开 debug 端口，且与 048「不承载敏感登录态」安全模型冲突（Cline 路线在 IDE 插件语境不成立）。
10. **Codex 式 Developer mode 全量 CDP**——JCEF 调试端口需 vmoptions 设置，不能假设所有用户环境开启。

**场景不符 / 低频低值：**
11. **WebContainers 式浏览器内运行时**——我们运行在真实本机，端口天然可达；解决的是「浏览器里无后端」问题。
12. **VPN/远程端口转发（Coder Desktop 类）**——纯远程场景，本地 JCEF 直连 localhost。
13. **阅读模式（readability/朗读）**——dev 预览主场景外的低频旁支。
14. **server 流量日志面板**——我们不托管 server，面板无从产生；归属 server 起源方职责。
15. **端口可见性/分享语义（Codespaces private/org/public、Coder 分享层级）**——本地单机无意义。
16. **Element Inspector（DOM→源码映射）**——依赖框架 sourcemap、工程量大，非 P0/P1。
17. **打印为 PDF**——技术上可行（CDP printToPDF 通道现成）但开发预览低频；如做，「会话导出 PDF」是更贴合的变体。

**死/收敛生态：**
18. **对标 Live Server（Ritwick Dey）/[Deprecated] Browser Preview/Fleet**——用户已被官方集成收敛或产品已消亡（Fleet 2025-12-22 停分发）。

---

## 八、未验证与来源等级（如实声明）

1. **JetBrains Client 内插件整体行为未实测**——官方「瘦客户端无 JCEF」口径来自 jcef-knowledge skill（本机 2026-11 磁盘取证）+ 2023 年支持帖；2025.x 拆分收敛进度未逐条复核 YouTrack。
2. **AI Assistant 聊天 UI 转 Compose / Air GenUI JCEF 沙箱 / ACP 桥接 pi 后端**——来自 jcef-knowledge skill 本机磁盘取证，本次未重跑验证。
3. **JUNIE-50**——State=Done、resolved≈2026-08-19 经 YouTrack API 核实；官方交付物未逐条核实（推测经 Chrome DevTools Connect/搜索层落地）。
4. **平台 Web Preview 对 alert/prompt/下载的运行时行为**——源码 WebPreviewFileEditor 无相关 handler（仅确认无显式处理面），运行时未验证。
5. **Windsurf Cascade 历史工具组合**——出自泄露系统提示词镜像（deepwiki），未验证；官方现行文档不再记载 agent 页面级操作。
6. **「VS Code Browser tools GA (July 2026)」搜索摘要**——未在官方页面核实到，未采信；以 1.110 Experimental + 1.119 主版本交付为口径。Copilot agentic browser tools 的 GA 时间（2026-06）同属搜索摘要未复核（工具列表本身已在 changelog 镜像 grep 到原文）。
7. **CEF 122 的 UA 覆写与代理配置 API 形态**——仅确认公开 API 无 per-context 代理；落地前需探针。
8. **Chrome「Copy outerHTML」官方专页未核验**（引 SO 高票答案）；**Firefox 支持页被 JS challenge 挡**（阅读模式/打印细节引搜索结果页）。
9. **Codex App 行（2026-04 起）**引自 042 spec §二（2026-11-16 轻量调研，未逐条复核官方文档）；OpenAI Codex 三行（共享视图/标注模式/Developer mode）已全文抓取官方文档 [A2]。
10. **pi 侧 web fetch 能力与 pi 工具审批是否覆盖 pi_browser**——未验证（候选 #19/#17 已标注「先查再加」）。
11. **049 无独立 spec 目录**（worktree specs/ 只到 048）——049 现状以 changelog.d/049-* 四碎片 + run-report + 源码为准；049 spec 全文在 `backup/release-0.5.10-browser-pre-reset` 分支（本次 `git show` 读到，含其自带 2026-11-18 竞品矩阵）。
12. **华为云 Doer IDE**（042 §二画像）未单列——能力点已被 Codex/Cursor 行覆盖。

---

## 九、来源索引

**JetBrains 侧**
- [J1] intellij-community 源码（gh api 抓取核实）：https://github.com/JetBrains/intellij-community （platform/platform-impl/jcef/src/com/intellij/ide/browsers/actions/{OpenHtmlInEmbeddedBrowserAction.java, WebPreviewEditorProvider.kt, WebPreviewFileEditor.kt}）
- [J2] JetBrains help · Settings/Tools/Web Browsers：https://www.jetbrains.com/help/idea/settings-tools-web-browsers.html
- [J3] JetBrains help · Markdown：https://www.jetbrains.com/help/idea/markdown.html
- [J4] Chrome DevTools Connect 插件页（Marketplace API 已抓取：modules=[intellij.chromeConnect.mcp]，仅 263.*，2026-10 首版）：https://plugins.jetbrains.com/plugin/35419-chrome-devtools-connect
- [J5] JetBrains AI Assistant 2025.1.2 发布博客（原文引用已核实）：https://blog.jetbrains.com/ai/2025/04/jetbrains-ai-assistant-2025-1-2/
- [J6] Junie help（已核实）：https://www.jetbrains.com/help/ai-assistant/junie-agent.html
- [J7] YouTrack JUNIE-50（API 查询：State=Done、resolved≈2026-08-19）：https://youtrack.jetbrains.com/issue/JUNIE-50
- [J8] Air 插件页（Marketplace API 已抓取，1.1M 下载）：https://plugins.jetbrains.com/plugin/33314-air
- [J9] The Future of Fleet（已核实 12/22 停止下载、Air 接棒）：https://blog.jetbrains.com/fleet/2025/12/the-future-of-fleet/
- [J10] JetBrains 远程开发支持帖：https://intellij-support.jetbrains.com/hc/en-us/community/posts/9449847922066-Remote-development-cannot-use-markdown-preview
- [J11] Google issue 159933628（Android Studio JCEF）：https://issuetracker.google.com/issues/159933628 （经 jcef-knowledge skill 转引）
- [J12] jcef-knowledge skill references（本机 2026-11 磁盘取证：os-pitfalls.md §远程开发/§Android Studio、architecture-and-versions.md、official-usage-map.md）：C:\Users\Administrator\.agents\skills\jcef-knowledge\

**VS Code 系**
- [V1] VS Code Integrated Browser 官方文档（全文抓取 + vscode-docs 仓库 md 逐行核验，行号 vscode-ib.md:*）：https://code.visualstudio.com/docs/debugtest/integrated-browser
- [V2] VS Code 1.56（Simple Browser）：https://code.visualstudio.com/updates/v1_56
- [V3] VS Code 1.109（Integrated Browser 引入）：https://code.visualstudio.com/updates/v1_109
- [V4] VS Code 1.110（agent browser tools Experimental）：https://code.visualstudio.com/updates/v1_110
- [V5] VS Code 1.119（页签共享/隔离）：https://code.visualstudio.com/updates/v1_119
- [V6] microsoft/vscode-livepreview README（GitHub API 抓取）：https://github.com/microsoft/vscode-livepreview
- [V7] Live Preview Marketplace：https://marketplace.visualstudio.com/items?itemName=ms-vscode.live-server
- [V8] Edge Tools · external-browser-window：https://learn.microsoft.com/en-us/microsoft-edge/visual-studio-code/microsoft-edge-devtools-extension/external-browser-window
- [V9] Edge Tools 文档主页：https://learn.microsoft.com/en-us/microsoft-edge/visual-studio-code/microsoft-edge-devtools-extension
- [V10] Edge Tools Marketplace：https://marketplace.visualstudio.com/items?itemName=ms-edgedevtools.vscode-edge-devtools
- [V11] Live Server（Ritwick Dey）：https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer
- [V12] [Deprecated] Browser Preview：https://marketplace.visualstudio.com/items?itemName=auchenberg.vscode-browser-preview
- [V13] VS Code Copilot changelog 镜像（原文已 grep）：https://github.com/Davidobot/vscode-copilot-chat-sidecar/blob/sidecar/CHANGELOG.md

**Agent 工具竞品**
- [A1] Cursor browser 工具官方文档（全文抓取，明确记载 dev-server detection）：https://cursor.com/docs/agent/tools/browser
- [A2] OpenAI Codex browser 官方文档（全文抓取）：https://learn.chatgpt.com/docs/browser
- [A3] Cline BrowserSession 源码（已读）：https://github.com/cline/cline （apps/vscode/src/services/browser/BrowserSession.ts）
- [A4] Cline 内置工具表（新版已无 browser_action）：https://docs.cline.bot/tools-reference/all-cline-tools
- [A5] Cline 3.10 本地 Chrome 集成博客：https://cline.bot/blog/cline-3-10-local-chrome-integration-yolo-mode-drag-drop-and-more-workflow-enhancements
- [A6] Continue agent 工作方式文档（全文抓取）：https://docs.continue.dev/ide-extensions/agent/how-it-works
- [A7] Cursor 收购 Continue：https://thenewstack.io/cursor-acquires-continue-coding
- [A8] Devin Desktop previews（Windsurf 官方文档现行页，全文抓取）：https://docs.devin.ai/desktop/previews
- [A9] Windsurf Cascade 系统提示词镜像（**未验证——泄露源**）：https://deepwiki.com/x1xhlol/system-prompts-and-models-of-ai-tools/5.2-windsurf-cascade-system

**云工作区与端口面**
- [C1] Gitpod Classic ports（ona.com，已抓全文）：https://ona.com/docs/classic/user/configure/workspaces/ports
- [C2] GitHub Codespaces 转发端口（已抓全文）：https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace
- [C3] Coder port forwarding（v2.37，已抓全文）：https://coder.com/docs/user-guides/workspace-access/port-forwarding
- [C4] StackBlitz WebContainers（官方博客全文）：https://blog.stackblitz.com/posts/introducing-webcontainers/
- [C5] CodeSandbox preview（live 页 403，经 GitHub codesandbox/docs 仓库源文件核验）：https://codesandbox.io/docs/learn/vm-sandboxes/preview

**通用浏览器基线**
- [B1] Chrome 下载中心：https://support.google.com/chrome/answer/95759
- [B2] Edge 下载管理：https://www.microsoft.com/en-us/edge/learning-center/how-to-manage-downloads
- [B3] Edge Immersive Reader：https://support.microsoft.com/en-us/edge/use-immersive-reader-in-microsoft-edge
- [B4] Firefox Reader View（⚠ 被 JS challenge 挡，引搜索结果页）：https://support.mozilla.org/en-US/kb/firefox-reader-view-clutter-free-web-pages
- [B5] DevTools full size screenshot：https://developer.chrome.com/blog/devtools-tips-33
- [B6] DevTools Command Menu：https://developer.chrome.com/docs/devtools/command-menu
- [B7] Edge 打印为 PDF：https://support.microsoft.com/en-gb/edge/print-in-microsoft-edge
- [B8] DevTools UA 覆写（含代理部分）：https://developer.chrome.com/docs/devtools/device-mode/override-user-agent
- [B9] Chrome 无痕窗口（已抓全文核验）：https://support.google.com/chrome/answer/9845881
- [B10] Chrome 页内查找：https://support.google.com/chrome/answer/95440
- [B11] Copy outerHTML（⚠ 引 SO 高票答案，官方专页未核验）：https://stackoverflow.com/questions/23343191/copying-html-code-in-google-chromes-inspect-element

**我方材料**
- [O1] specs/042-in-app-browser/spec.md §二竞品画像（2026-11-16 轻量调研材料）
- [O2] specs/048-in-app-browser-p0/spec.md（§四 Non-goals :56-62、§五硬约束、F-201/F-208/F-212/F-215）
- [O3] specs/049-browser-agent-and-links/spec.md（worktree specs/ 缺失；全文在 backup/release-0.5.10-browser-pre-reset 分支，git show 读到）
- [O4] specs/0.5.10-run-report.md（048 走查修复 / 049 复验轮 2 / 049 工具条复检 / 049 DevTools 两段 / 050 / 051 / 052）
- [O5] changelog.d/048-*、049-*、050-*、051-*、052-* 共 20 个碎片（本次 ls 核实）
- [O6] docs/ARCHITECTURE.md §13 平台 API 与 Marketplace 兼容性检查（:247 起；INTERNAL_API_USAGES 拒稿 :254；支持下限 233）
- [O7] src/main/kotlin/dev/pi/agent/browser/ 34 个源文件（本次 ls + grep 行号核实）

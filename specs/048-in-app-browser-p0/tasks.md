# Tasks: 048 内置浏览器 P0（预览基座）

> 每 task 自带「— 验证：…」（宪法 II：无断言覆盖不得标记完成）。JCEF 面单测不可实例化 → 纯函数/状态机进 Kotlin 单测，handler 行为进真机清单（plan §测试策略）。
> 探针证据编号 P-1～P-12 见 plan §0；实施顺序不可颠倒项见 plan §实现顺序。

## 阶段 1 内核层（纯函数先行）

- [ ] T001 `PiBrowserState.kt`：IDLE/LOADING/LOADED/FAILED/CRASHED 枚举 + `transition(state, event)` 纯函数（loadStart/loadEnd/loadError/crash/rebuild/reset 全表）。
  — 验证：单测覆盖全部合法转换与 ≥6 条非法转换拒绝；`gradlew test --tests "*PiBrowserState*"` 绿。
- [ ] T002 `UrlNormalizer.kt`：地址栏规范化（无 scheme 补 `http://`、空白/纯空白拒绝、`localhost`/IP 保留、尾斜杠不动）。
  — 验证：单测 ≥10 例（含 `example.com`→`http://example.com`、`https://a.b` 原样、`""` 拒绝）。
- [ ] T003 `UrlNormalizer.downloadFileName(suggested)`：清洗下载名（去 `\ / : * ? " < > |`、防 `..` 穿越、空名回退 `download.bin`、重名序号由调用方处理）。
  — 验证：单测 ≥8 例（穿越 `..\..\x` → `x`；`a/b` → `a_b`；P-4 反例注释引用）。
- [ ] T004 `LogSafe.kt`：`url(host+path，strip query/fragment)`、`truncate(msg,200)`；kernel 侧全部日志经它。
  — 验证：单测断言 query/fragment 零出现、超长截断；grep 确认 kernel 源码无裸 `LOG.warn(".*$url` 模式。
- [ ] T005 `JcefFrameRepaint.kt`：从 `PiAgentPanel.repaintBrowser`（`PiAgentPanel.kt:453-480`）原样提取 `forceRepaint(browser, component)`（反射 `wasResized`，P-9）；`PiAgentPanel` 改为调用 util。
  — 验证：`gradlew test` 全量绿（PiAgentPanel 既有行为零变化）；真机冒烟：切换页签后无旧帧残留。
- [ ] T006 `PiCertPolicy.kt`：接口 + `StrictPolicy`（`onCertificateError` → return false，P-3 interstitial 兜底）；kernel 持有 policy 字段（043 hook）。
  — 验证：单测默认策略 = Strict；接口 javadoc 注明 043 接管点与 `Continue()`（大写 C）签名出处。
- [ ] T007 `PiBrowserHandlers.kt`：五个 handler 按探针实证签名实现——`CefLifeSpanHandler.onBeforePopup`（拦截 + `kernel.loadURL(targetUrl)` + true，空白 URL 仅取消；P-2）、`CefDownloadHandler`（T003 清洗名 + 原生反斜杠路径 `Continue(...,false)`；P-4）、`CefRequestHandler.onCertificateError`（走 T006 policy）、`CefLoadHandler`（主 frame onLoadError 非 ERR_ABORTED → loadError 事件）、`CefDisplayHandler`（onAddressChange/onTitleChange → 状态监听）。
  — 验证：编译过（签名即断言）；纯决策分支（空白 URL 不导航）抽静态函数单测；真机清单 #2/#3/#4 全过。
- [ ] T008 `PiBrowserKernel.kt`：懒创建 windowed `JBCefBrowser`（D2 单实例）+ `ensureLoaded/reload/back/forward`（导航 API 以编译期为准）+ 状态机接线（T001）+ `onRenderProcessTerminated` → CRASHED（P-6）+ rebuild 熔断（60s 窗 2 次，复用 `PiAgentPanel` 形态）+ Disposer 全链。
  — 验证：熔断窗口纯逻辑单测；真机冒烟：加载 localhost 页成功、杀渲染进程自动重建、超限常驻错误卡。

## 阶段 2 工具窗载体

- [ ] T009 `PiBrowserManager.kt`（project service）：`open(url)` → 确保 Content 存在（懒建）并激活 → kernel `ensureLoaded(url)`；`contentRemoved` 时释放 kernel。
  — 验证：单测「open 两次 → 单 Content 复用」（service 层可用 fake contentManager）；真机清单 #6 前半。
- [ ] T010 `PiAgentToolWindowFactory.java`：`createBrowserContent(project, toolWindow)`（对齐 `createInstanceContent` 模式；displayName 走 bundle；Content userData 标记 kind=BROWSER）；`CloseGuard.contentRemoved` 对 BROWSER kind 直接放行（无确认），对 INSTANCE 保持 019 语义。
  — 验证：真机开两个 pi 实例 + 浏览器页签并存（spec US8）；关浏览器页签无确认、pi 实例页签无感；`gradlew test` 全量绿。
- [ ] T011 `BrowserPanel.kt`：工具条（地址栏 JTextField + Go + 后退/前进/刷新三钮）+ URL/标题回显行 + 状态接 kernel 监听（EDT invokeLater）；按钮随 `canGoBack/canGoForward` 置灰；布局固定 NORTH（宪法 III）。
  — 验证：真机清单 #1（手输/粘贴/Go/Enter/回显）；按钮置灰随历史变化目验；`Ctrl+L` 聚焦地址栏（spec Q5）。
- [ ] T012 `PiAgentSettings.linkTarget`（system 默认/embedded/ask）+ `PiAgentSettingsConfigurable` 下拉 + 双语字典键。
  — 验证：单测默认值 = SYSTEM；真机设置页可见可改、重启后保持。
- [ ] T013 外链路由：`routeExternalLink(url, target)` 纯函数（SYSTEM→BrowserUtil.browse 语义 / EMBEDDED→manager.open / ASK→确认框决策）+ `PiAgentPanel.linkHandler` 接线（`PiAgentPanel.kt:79-92`）。
  — 验证：`routeExternalLink` 单测 ≥9 例（三态 × loopback/外部/空白；**默认态与现状逐字一致**——037 语义零变化）；真机清单 #7。
- [ ] T014 错误卡接入：FAILED/CRASHED → `PiUiErrorPanel` 形态（标题/原因/重载按钮 → kernel rebuild 清熔断）；LOADED 恢复面板。
  — 验证：真机清单 #5（杀进程路径）；加载不存在域名显示错误卡非白板。

## 阶段 3 本地 HTML 预览

- [ ] T015 `PiBrowserPreviews.kt`：登记表 {128-bit token → temp 文件路径, createdAt}；单次有效（取后即焚）、5 分钟过期、路径必须位于插件 temp 目录白名单内（防逃逸）。
  — 验证：单测 ≥7 例（二次取用失败、过期失败、白名单外拒绝、并发登记互不覆盖）。
- [ ] T016 `LocalUiServer` `/preview/<token>` 只读路由：按 token 回吐文件字节（text/html），不经桥接鉴权；404 兜底；**不落日志**（硬约束 8）。
  — 验证：单测（注册→GET 200→再 GET 404→过期 404）；真机 curl 二次访问 404。
- [ ] T017 `OpenInPiBrowserAction`：HTML 文件右键（ProjectViewPopupMenu + EditorTabPopupMenu，plugin.xml 注册）→ 拷贝到插件 temp → 登记 token → `manager.open(previewUrl)`；i18n 双语。
  — 验证：真机右键打开一个含脚本的项目 HTML 页渲染正常；token 复用失败；动作在非 HTML 文件上置灰。
- [ ] T018 导出预览接线：`BridgeService.kt:678-699` 导出成功通知追加「预览」action → 渲染结果同步写插件 temp 副本（IV 回滚：会话级清理）→ 同 T017 通路。
  — 验证：真机导出 → 通知 → 预览打开内容与导出文件一致；temp 副本在清理点消失。

## 阶段 4 编辑器呈现（D 轨，可滑出——spec Q3）

- [ ] T019 `FileEditorProvider` + `LightVirtualFile`（userData 标记 `pi-preview`）：provider 只认自己的标记文件，内嵌独立 kernel 实例（两形态不共享状态，spec US9）；参照 041 LightVirtualFile 用法，不抢平台 HTML 编辑器。
  — 验证：真机从右键菜单选「在编辑器中打开」→ 编辑器页签渲染；关闭后 Disposer 无泄漏（无残留 CEF 进程组）；平台普通 HTML 文件打开行为不变。
- [ ] T020 provider 注册 + i18n + `verifyPlugin`。
  — 验证：`verifyPlugin` 全 Compatible、无 INTERNAL_API_USAGES 新增。

## 阶段 5 收尾

- [ ] T021 i18n 扫尾：全部新增用户可见文案双字典；bundle 键 grep 清点零漏网。
  — 验证：脚本清点新增键在 `PiAgentBundle.properties` 与 `_zh_CN` 成对出现。
- [ ] T022 全量基线：`gradlew test` / `vitest` / `playwright` 全绿；基线变化逐条注明「非回归」。
  — 验证：run-report 记录数字（对照 0.5.10 反馈批次基线：e2e 405 / vitest 502）。
- [ ] T023 `MANUAL_TEST.md` 新段（plan §测试策略 10 条真机清单）+ 真机执行留痕。
  — 验证：10 条逐条打勾或注明跳过原因；截图/日志入 run-report。
- [ ] T024 `changelog.d` 碎片（collectChangelog 两行格式）+ run-report 段落。
  — 验证：`collectChangelog` 校验通过；碎片计数正确。

## 交付边界

阶段 1–3 完成 = 用户可用的 P0（地址栏页签 + 预览 + 外链路由）；阶段 4 可滑出（spec Q3 默认口径）；每阶段末跑对应验证层（阶段 1：单测+真机冒烟；阶段 2/3：真机清单对应项；阶段 5：全量基线）。

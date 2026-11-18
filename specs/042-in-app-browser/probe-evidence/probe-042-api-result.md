# 042/043 真机 API 存在性探针结果（2026-11-18）

宿主：IDEA 2026.2.3，JCEF 版本 `144.0.15-g72717cf-chromium-144.0.7559.172-api-1.21-262-b37`，API 1.21。
方法：直接解析安装目录下 `plugins/jcef-plugin/lib/*.jar` 的 `.class` 常量池（`scripts/probe-042-api.py`），不依赖 javap（本机 JBR 无 javap）。原始输出 `build/probe-042-api.json`。

## 结论一览

| 探针项（spec 来源） | spec 原表述 | 真机事实 | 判定 |
|---|---|---|---|
| HealthMonitor TOPIC（探索稿 §5.3 / #8） | `JBCefHealthMonitor.TOPIC` | 实际是内部类 **`JBCefHealthMonitor.JBCefHealthCheckTopic.TOPIC`**，类型 `Topic<JBCefHealthCheckTopic>`；监听方法 `onHealthHealthStatusChanged` | **需更正写法** |
| HealthMonitor 状态常量（探索稿 §5.3） | `GPU_PROCESS_FAILED` / `CEF_SERVER_DISCONNECTED` / `STARTUP_TEST_FAILED` | `Status` 枚举**只有 5 个值**：`OK` / `UNKNOWN` / `GPU_PROCESS_FAILED` / `UNPRIVILEGED_USER_NS_DISABLED` / `RUN_UNDER_SUPER_USER`。后两个常量不存在 | **实质落差，须更正** |
| 证书错误码（043 FR-002 四类） | 自签名/过期/域名不匹配/私有 CA | `CefLoadHandler.ErrorCode` 含 18 个 `ERR_CERT_*`：`ERR_CERT_AUTHORITY_INVALID`（自签名/私有 CA）、`ERR_CERT_DATE_INVALID`（过期）、`ERR_CERT_COMMON_NAME_INVALID`（域名不匹配）、`ERR_CERT_REVOKED`、`ERR_CERT_WEAK_*` 等 | **有直接支撑**（四类有误码对应），但回调签名参数需按真实类型写 |
| 证书回调签名（043 FR-002） | `onCertificateError`（未写签名） | `onCertificateError(CefBrowser, CefLoadHandler.ErrorCode, String, CefSSLInfo, CefCallback) : boolean`；另有 `getAuthCredentials(...CefAuthCallback) : boolean` | 已确认，供 plan 直接引用 |
| 独立 request context / cookie 隔离（探索稿 §6.2 / #9） | 「API 可行性待证」 | `CefRequestContext.createContext(CefRequestContextHandler) : CefRequestContext` 存在；另有 `getGlobalContext` / `isGlobal` / `setPreference` / `ClearCertificateExceptions` | **API 可用**，隔离路径可行（行为仍须原型真机验证） |
| 弹窗控制（探索稿 §5.4 / #10） | `onBeforePopup` 待定夺 | `CefLifeSpanHandler.onBeforePopup(CefBrowser, CefFrame, String, String) : boolean` 存在 | 已确认 |
| 下载（探索稿 §5.5 / #10） | `CefDownloadHandler` 待挂 | `onBeforeDownload(...CefBeforeDownloadCallback) : boolean` + `onDownloadUpdated(...CefDownloadItemCallback) : void` 存在 | 已确认 |
| 标题/地址回调（探索稿 §5.2） | `onTitleChanged`/`onAddressChange` | 实际方法名 **`onTitleChange`**（无 d）/ `onAddressChange`；类 `CefDisplayHandler` | **需更正方法名** |
| 加载失败判定（探索稿 §5.3） | `CefLoadHandler.onLoadError` | `onLoadError(CefBrowser, CefFrame, ErrorCode, String, String) : void` 存在 | 已确认 |
| DevTools 菜单开关（042 P1） | 未提及 | `JBCefBrowserBuilder.setEnableOpenDevToolsMenuItem(boolean)` 存在 | 新增有利事实 |
| 渲染模式（探索稿 §3 / #11） | 拍板 windowed | `JBCefBrowserBuilder.setOffScreenRendering` / `setWindowlessFramerate` 存在；类内字符串明确：「Trying to create windowed browser when remote-mode is enabled. Setting isOffScreenRendering=false will be ignored.」→ **remote 模式下 windowed 会被强制忽略** | **风险信号**：本机是否 remote 变体须 plan 前真机确认；若 remote，windowed 拍板需重新评估 |

## 证据

- 脚本：`scripts/probe-042-api.py`（可复跑）
- 原始 dump：`build/probe-042-api.json`
- jar：`intellij.platform.ui.jcef.jar`（JBCef* 系列）、`intellij.libraries.jcef.jar`（org.cef.* 系列）

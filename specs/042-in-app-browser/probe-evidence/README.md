# 042 探针证据链（P-1～P-12）原始工件

plan §0 引用的每条探针结论的原始脚本与日志，2026-11-17/18 产出，从
`D:\code\probe-042`（探针工作区）与 031 工作树 `build/` 吸收入库。
**截图（8MB BMP/PNG）不入库**——留在 `D:\code\probe-042\` 与 031 工作树 `build/`，
需要时按本 README 的工件名对应关系去现场取。

## 两类探针环境

1. **真机 CDP**（WebStorm/IDEA CEF 144，端口 9222）：`probe.mjs`、`probe-round2/3/4.mjs`、
   `probe-popup-click.mjs`、`server.mjs`（本地静态服务器模拟 dev server）。
2. **沙盒探针插件**（runIde，IC-2024.3.1 CEF 122）：`../probe-plugin/`（源码）+
   `probe-plugin-drive*.mjs`（驱动脚本）+ `plugin-results.log`。插件 v1→v6 迭代，
   每轮验证一个 handler 面（popup/下载/证书/focus/display）。

## 工件 → 结论对照

| 工件 | 证明 |
|---|---|
| `probe-run.log` | round-1：下载无 handler 凭空消失（P-4 反例） |
| `probe-round2.log` | round-2：证书 interstitial 默认渲染（P-3） |
| `probe-round3.log` | round-3：`Continue()` 大写 C 唯一放行通路 + 反斜杠路径落盘（P-3/P-4） |
| `probe-round4.log` | round-4：真实点击 `target=_blank` 弹独立 CEF 窗（P-1 反例）+ CDP 真实点击通路（P-10） |
| `probe-popup-click.mjs` | round-4 的真实点击脚本（`Input.dispatchMouseEvent`） |
| `plugin-results.log` + `probe-plugin-drive.log/drive2/drive4` | 探针插件 v1–v6 各轮结果：onBeforePopup 是唯一拦截点（P-2）、`createContext` 不隔离 cookie（P-5）、`onTakeFocus` void（P-8） |
| `probe-042-result.json`（031 build/） | 真机 CDP 平台探针 16/16 PASS（通道全 available） |
| `probe-042-api.json` + `probe-042-api-result.md` | JBR 常量池 API 存在性：`JBCefHealthMonitor.TOPIC` 不存在（P-6）、`onTitleChange` 无 d、18 个 `ERR_CERT_*`、`setEnableOpenDevToolsMenuItem` 存在 |
| `probe-048-smoke.log` + `probe-048-smoke.mjs` | 048 P0 冒烟（干净安装版前置版；正式版见 `scripts/probe-048-smoke-clean.mjs`） |
| `server.mjs` | 本地静态服务器（模拟 AI 起的 dev server，供探针访问） |

## 042 P-1～P-12 结论汇总（对应 plan §0 表）

P-1 弹窗反例 / P-2 onBeforePopup / P-3 证书通路 / P-4 下载反斜杠 / P-5 cookie 共享 /
P-6 HealthMonitor 不存在 / P-7 HWND 错位 / P-8 display+focus 签名 / P-9 stale-frame /
P-10 真实点击自动化 / P-11 Swing 粘贴渲染 / P-12 主题底色。

# IDE 真机探针工具集（scripts/ide-probe/）

内置浏览器线（042 探索 → 048 P0 → 049 P1）的真机验证工具，2026-11-17/18 从
`pi-agent-idea-wt/031-embedded-browser` 工作树与 `D:\code\probe-042` 探针工作区
吸收入库。使用前先读技能文件
`C:\Users\Administrator\.workbuddy\skills\jetbrains-jcef-cdp-e2e\SKILL.md`
（模态框陷阱 / vmoptions 追加规则 / 锁屏对策都在里面）。

| 文件 | 用途 | 来源 |
|---|---|---|
| `win_ui.py` | 主桌面 GUI 自动化（ctypes）：`list` / `click x y` / `rclick` / `focus <标题或hwnd>` / `type <文本>` / `key <vk>`。点信任框、发按键、真实鼠标 | 031 工作树 build/ |
| `win_shot.py` | 全桌面截屏为 32-bit BMP（`Add-Type` 被安全策略拦的替代品），ViewImage 可读 | 031 工作树 web/ |
| `cdp-verify.mjs` | CDP 通道连通性验证（9222 端口 /json/list + Runtime.evaluate） | 031 工作树 build/ |
| `capture-window.ps1` | 按窗口句柄截窗（PrintWindow 路径，锁屏可用） | D:\code\probe-042 |
| `dump-hwnd.ps1` | 枚举窗口/子 HWND（OSR 判据：无 `Chrome_WidgetWin_0`） | D:\code\probe-042 |
| `gui-ops.ps1` | 组合 GUI 操作 | D:\code\probe-042 |
| `idea-probe.vmoptions` | 真机 IDEA 探针 vmoptions 模板（9222 调试端口 + autoOpen + ja-netfilter 许可补丁）。**用法**：复制副本后 `IDEA_VM_OPTIONS` 环境变量指向副本启动 IDEA；**只能追加不能替换**（javaagent 行丢了会弹许可框冻 EDT） | 031 工作树 build/ |

配套探针脚本（按规格）：
- 042 平台探针：`scripts/probe-042-cdp.mjs`、`scripts/probe-042-api.py`（git 内）
- 048 冒烟：`scripts/probe-048-smoke-clean.mjs`
- 049 链接选择器：`scripts/probe-049-link-selector.mjs`；rpc 离线冒烟：`scripts/probe-049-pi-browser-rpc.mjs`

已知陷阱速记（详见 skill）：程序化 `element.click()` 不触发 JCEF `onBeforePopup`
（用 `Input.dispatchMouseEvent`）；CDP 点击不移动 OS 光标（`MouseInfo` 取到的是
真实光标位置）；OSR 页面只有 Swing 焦点在浏览器组件上时真实键盘才可达；工具窗
切页签后真实点击落在当前可见页。

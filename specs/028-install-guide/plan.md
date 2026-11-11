# 028 安装引导 — 技术方案（精简执行版）

> 依据 spec.md（2026-11-12）。时间盒内先保证 FR-003/004/005/006/010 + FR-001/002/007/008 的闭环。

## 1. Kotlin

### PiEnvironment.kt
- `MIN_NODE_MAJOR=18` → `MIN_NODE="22.19"`；纯函数 `nodeMeetsMin(version)`：解析 `vMAJOR.MINOR`，
  major>22 → true；major==22 → minor≥19；解析失败 → false（FR-003，表驱动单测 6 例）。
- `detect()`：`nodeOk` 按新口径；新增 `nodeVersion`、`minNode`、`installBlocker`
  （`no-node` / `node-version` / `no-npm` / null，FR-009）；`canInstall = npm != null && nodeMeetsMin`。
- 新增 `installScriptArgs(isWindows)` 纯函数：Windows
  `[powershell,-NoProfile,-ExecutionPolicy,Bypass,-Command,"irm https://pi.dev/install.ps1 | iex"]`；
  其他 `[sh,-c,"curl -fsSL https://pi.dev/install.sh | sh"]`（FR-001/002，单测断言命令与 URL）。
- 新增 `installScript(...)`：与 npm 安装共用 `beginInstall`/`installProcess`/`cancelInstall`
  （FR-007 一条通道），无时间上限、可停止；成功后同一次 `refresh` 重新定位（FR-005 靠探测不假设路径）。

### PiAgentSettings.kt / PiLocator.kt
- settings 增 `nodePath`（`dev.pi.agent.nodePath`，空=自动）；`setNodePath` 变更即
  `restartPiEverywhere()`（FR-006，与 piPath 同语义）。
- `PiLocator.locateNode()`：**settings.nodePath 优先**，其次现有推导（FR-004/005）；
  `nodeInterpreterFor`/`nodeBinDirFor` 同源（启动 pi 的 PATH 注入与 npm 安装共用）。
- npm 安装用 `dirname(nodePath)` 下的 npm/npm.cmd：`locateNpm()` 先查该目录。

### BridgeService
- detect 自动生效（走 PiLocator）；新增 `manage.envSetNodePath {path}`：settings.setNodePath +
  restartPiEverywhere（FR-006）。

## 2. Web

- `SetupCard.tsx`：env.installBlocker 驱动「npm 禁用 + 原因文案」（三态，FR-009）；
  「官方安装脚本（会一并安装 Node）」区块：完整命令 + URL 展示（`pi.dev/install.ps1|.sh`）+
  确认后调用 `manage.envInstall {method:"script"}`（FR-002）；失败 → 错误区含退出码与尾部输出 +
  「改用 npm」按钮（有 npm 时）（FR-008）；共用同一输出区/停止按钮。
- `SettingsPanel.tsx`：piPath 旁增 `nodePath` 输入（保存调 envSetNodePath，可清空回自动）（FR-010）。
- mock：`?setup=nonode`（node/npm null→blocker no-node）、`?setup=nodeold`（v20.11.0 → blocker
  node-version）；`envInstall` 接受 `{method}`；detect 增同名字段。
- 四处同步：types.ts / manage.ts / mock.ts / BridgeService（envSetNodePath）。

## 3. 测试

| 层 | 用例 |
|---|---|
| Kotlin PiEnvironmentTest | nodeMeetsMin 表驱动 6 版本；installScriptArgs 双平台；detect 的 blocker 三态 |
| vitest mock | nonode：npm 禁用+脚本可点；nodeold：nodeOk=false；envSetNodePath 后 detect.nodePath 生效 |
| e2e setup-provider / 新增 install-methods | 脚本命令可见（URL 字样）、确认、成功路径走 027 表单；setup.spec 7 条零回归 |

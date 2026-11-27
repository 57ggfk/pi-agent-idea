# Feature Specification: pi 版本双显（运行版 + 磁盘版）与更新按钮兜底

**Feature Branch**: `[20261127-190334-pi-version-display]`
**Created**: 2026-11-27
**Status**: 草稿（待实现）

**GitHub Issue**: [#5 「更新 pi」按钮在 npm 全局安装上必然失败](https://github.com/57ggfk/pi-agent-idea/issues/5)（Bug）· [#6 状态栏 pi 版本双显](https://github.com/57ggfk/pi-agent-idea/issues/6)（Feature）

**Input**: 用户在真机上用 npm 外部把 pi 从 1.6.0 升到 1.6.1，随后看插件的诊断面板：
诊断卡里的「pi 1.6.1」已经变了，左下角状态栏的版本号却没跟着变。用户问：**外部更新之后，
左下角的不变，这个怎么优化好？** 维护者拍板：**双版本并列（运行版 + 磁盘版），不一致时
标「重启后生效」**；顺带修掉「更新 pi」按钮在 npm 全局安装上必然失败的问题。

## 背景：同一个「pi 版本」有两个来源

插件里有两处显示 pi 版本，取数路径完全不同：

| 位置 | 取数 | 时机 |
|---|---|---|
| 左下角状态栏（webview `StatusBar.tsx`） | `pi-state` 事件里的 `version` → `PiConnectionState.Running.installation.version` | **pi 进程启动那一刻**捕获，之后不再变 |
| 诊断卡（`DiagnosticsPanel.tsx`） | `manage.environment` → `PiLocator.locate(forceRefresh = true)` → 现场跑 `pi --version` | 每次进诊断页重新读磁盘 |

所以外部更新（`npm install -g`）之后：诊断卡立刻显示新版本，左下角还钉在旧版本上。
用户看到的是「插件自相矛盾」——同一个版本号，两处不一样，且左下角那个永远不变。

更糟的是 `PiLocator.locate()` 默认返回**进程级缓存**（`cached` 字段），
`PiProcessManager.start()` 拿的就是这个缓存。外部更新之后即便重启 pi 进程，
只要中途没人调过 `forceRefresh`，启动快照里仍然是旧版本号。

## 用户场景与验收

### User Story 1 — 外部更新后，左下角如实反映磁盘上的新版本（Priority: P1）

作为在终端里用 npm 升级 pi 的用户，我希望插件左下角显示的版本是**此刻磁盘上那个 pi** 的版本，
而不是我上次启动它时的版本。

**为什么重要**：状态栏是插件唯一一个「一直挂在眼前」的事实。钉着一个过期版本号，
用户会以为升级没生效，或者更糟——以为自己的会话跑在新版上。

**独立可测**：外部升级 pi → 看左下角 → 无需重启 IDE 即应看到新版本。

**验收场景**：

1. **Given** pi 1.6.1 在跑，**When** 用户在终端 `npm install -g` 升到 1.6.2，
   **Then** 左下角显示「运行版 1.6.1」且标注磁盘版 1.6.2，并明示「重启后生效」
2. **Given** 磁盘版与运行版一致，**When** 用户看左下角，**Then** 只显示一个版本号，
   不出现多余的「重启后生效」噪音
3. **Given** 用户重启了 pi 进程（会话重启），**When** 磁盘版已是新版，
   **Then** 两个版本号收敛成一个，提示消失

### User Story 2 — 「更新 pi」按钮在 npm 全局安装上真的能更新（Priority: P1）

作为用 npm 全局装 pi 的用户，我希望点诊断卡上的「更新 pi」按钮时它真的把 pi 更新了。

**为什么重要**：pi 自己的 `pi update --self` 在 npm 全局安装上会判定「这个安装不受全局包管理器
管理」而拒绝——因为它拿 `npm root -g` 的输出当基准，而那台机器上 PATH 里的 npm 与装 pi 的
npm 未必是同一个 prefix。插件把失败原样透给用户，用户只能自己去终端手动升级。

**独立可测**：点「更新 pi」→ pi 版本号真的变大。

**验收场景**：

1. **Given** `pi update --self` 因「不受全局包管理器管理」而拒绝，
   **When** 插件执行更新，**Then** 自动回退到 `npm install -g --prefix <pi 所在的 prefix>`，
   升级到 pi 实际所在的那个 prefix，不装到别的 prefix 去
2. **Given** 回退用的 npm 找不到，**When** 更新，**Then** 明确报错说明「找不到能管理这个安装的 npm」，
   而不是静默失败
3. **Given** 更新成功，**When** pi 正在跑，**Then** 插件按既有约定重启 pi 进程，
   状态栏版本号随之更新

### User Story 3 — 版本事实只有一个来源（Priority: P2）

作为维护者，我希望「pi 版本」在插件里的定义是唯一的、可测的。

**验收场景**：

1. **Given** 任意时机，**When** 问「磁盘上的 pi 是哪个版本」，
   **Then** 状态栏与诊断卡给出同一个答案
2. **Given** 版本探测要起子进程，**When** 频繁刷新，**Then** 探测有节流，不会每次重绘都 spawn 一次 node

## 需求（Functional Requirements）

- **FR-001**：插件必须能区分并分别呈现「运行中的 pi 版本」与「磁盘上的 pi 版本」。
- **FR-002**：两者不一致时，状态栏必须明示需要重启才能生效，不得让用户自己推断。
- **FR-003**：两者一致时，状态栏只显示一个版本号，不制造噪音。
- **FR-004**：磁盘版探测必须有节流，不得在每次 UI 重绘时起子进程。
- **FR-005**：`pi update --self` 因「不受全局包管理器管理」失败时，插件必须回退到 npm 通道。
- **FR-006**：npm 回退必须使用**能管理当前 pi 安装的那个 prefix**，不得装到别的 prefix。
- **FR-007**：找不到可用的 npm 时必须明确报错，不得静默失败。
- **FR-008**：跨 Kotlin ↔ web 的字段名必须同一次改动里一起改（真源 `web/src/store/types.ts`）。

## 非目标（Out of Scope）

- 不做「检查 pi 是否有新版本可用」的主动轮询——pi 没有这个子命令，插件不猜。
- 不改 IDE 原生状态栏 widget（`PiStatusWidget.kt`）的文案——它显示的是运行态，不是磁盘态。
- 不动 `pi update --extensions`（扩展包更新）那条通路。

## 边界与风险

- **磁盘版探测会起一次 `pi --version` 子进程**（node 冷启动约 1s）。节流窗口内重复请求直接用缓存。
- **双 prefix 机器上「正确的 npm」是算出来的，不是猜的**：从 pi 的实际安装路径反推 prefix，
  再用该 prefix 校验 npm 的 `root -g` 输出确实覆盖 pi 的包目录。
- **真机验收不可跳过**：版本显示要 IDE 前端渲染 + 外部升级配合，只能真机确认。

## 假设与依赖

- pi 的 `--version` 输出形如 `1.6.1`（既有 `PiLocator.version()` 已做格式校验）。
- npm 全局安装布局：`<prefix>/node_modules/@earendil-works/pi-coding-agent`。

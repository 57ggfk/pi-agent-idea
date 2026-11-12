# Feature Specification: 安装引导覆盖官网全部安装方式 + 支持手动选择 Node 路径

**Feature Branch**: `release/0.5.8`

**Created**: 2026-11-12

**Status**: Draft

**Input**: 用户需求（2026-11-12）
> 引导用户安装，支持官网的几种安装方式，支持选择 node 路径。

已定口径（2026-11-12）：**官方脚本 + npm**，不做 nix。

**难度定位**：中。脚本执行与 npm 安装共用「可停止、可看输出」的既有通道，真正的风险是
**在插件里下载并执行远端脚本**（安全边界）与 **Node 版本门槛写错了**（见下，现成缺陷）。

## 问题陈述

### 现状：只有一条安装路，且 Node 门槛是错的

- `SetupCard.tsx` 只提供 **npm 安装**（三档 registry + 自定义）+ 「手填 pi 可执行路径」。
  `PiEnvironment.install()` 把命令写死成 `[npm, "install", "-g", PI_PACKAGE, --registry=…]`（`PiEnvironment.kt:169-173`）。
- 官网给了 4 条路（`@earendil-works/pi-coding-agent/README.md:28-45`）：
  `curl -fsSL https://pi.dev/install.sh | sh`（mac/Linux）、
  `powershell -c "irm https://pi.dev/install.ps1 | iex"`（Windows）、
  `npm install -g --ignore-scripts`、`nix profile add github:earendil-works/pi/stable`。
  **前两条会替用户装 Node**——正是「机器上没有 Node」的人最需要的路径，而插件现在完全不给。
- **现成缺陷**：`PiEnvironment.kt:60` 是 `MIN_NODE_MAJOR = 18`，而 pi 要求 **Node ≥ 22.19**。
  于是 node 18/20 的机器上 `nodeOk` 报 true、安装按钮可点，然后 npm 装完 pi 起不来，
  用户看到的是一连串 `env: node` 或语法错误，而引导页说「环境正常」。
- Node 路径**没有配置项**：`PiAgentSettings` 只有 `piPath`（`dev.pi.agent.piPath`），
  Node 只能靠 `PiLocator.locateNode()` 猜（从 pi 位置向上找、再查登录 shell PATH）。
  nvm/fnm/volta/多版本共存的机器上，猜中的那个不一定是用户想要的那个。

### 为什么「选 Node 路径」比看起来重要

GUI 启动的 IDE 继承的是最小 PATH（`PiLocator.kt:113-114` 的注释就写着这条），
所以「终端里 `node -v` 正常、插件里找不到 node」是常态。给一个显式的 `nodePath` 是唯一确定性的解法，
且它同时解决三件事：① 启动 pi 时注入该 node 的 bin 目录 ② npm 安装用同目录的 npm ③ 官方脚本装完后做版本校验。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 机器上没有 Node，用官方脚本一键装好 (Priority: P1)

引导页检测到「没有 node 或版本过低」时，除了 npm 之外给出「官方安装脚本（会一并安装 Node）」按钮，
点之前显示**将要执行的完整命令与来源 URL**；点之后实时显示脚本输出，可停止；成功后自动重新检测并进入下一步。

**Why this priority**: 这是当前最大的死路——没 node 的机器上 npm 路根本走不通，用户只能自己开终端。

**Independent Test**: 把 `node`/`npm` 探测都返回 null 的 mock 环境 → 断言引导页出现脚本按钮且 npm 按钮禁用；
mock 脚本执行成功 → 断言重新 `envDetect` 并进入 provider 步骤。

### User Story 2 - 手动指定 Node 路径，环境立刻按它计算 (Priority: P1)

「环境」里给一个 Node 路径输入（含「浏览…」文件选择），填完保存后：
探测结果里的 `node` 版本、`nodeOk`、npm 位置都改用这条路径推导；重启工具窗后 pi 也用它启动。

**Why this priority**: 与 US1 互补——已经有 Node 但插件找不到（GUI PATH 问题）的人靠这条。

**Independent Test**: 设 `nodePath` 指向一个假 node（`-v` 输出 `v22.19.0`）→ 断言 `detect` 的 `node` 为该路径、`nodeOk=true`；
指向 `v20.11.0` → `nodeOk=false` 且文案说明「需要 22.19 或更新」。

### User Story 3 - Node 版本门槛说对话 (Priority: P1)

`nodeOk` 必须按 **22.19**（major.minor 比较）判定，而不是 major ≥ 18。
不满足时引导页明确写出「需要 Node 22.19 或更新，当前 v20.11.0」，并优先推荐官方脚本（它会装 Node）。

**Independent Test**: 表驱动：`v18.20.0`/`v20.11.0`/`v22.18.9` → false；`v22.19.0`/`v23.0.0`/`v24.1.0` → true。

### User Story 4 - 安装过程可见、可停、失败有原文 (Priority: P2)

脚本与 npm 两条路共用同一个输出区（已有 npm 输出组件）；「停止」对脚本同样有效；
失败时显示退出码与最后 N 行输出，并给出「改用 npm 重试」的按钮（有 npm 时）。

**Independent Test**: 注入脚本退出码 1 + stderr → 断言错误区含 stderr 原文与「改用 npm」入口。

### User Story 5 - 装完的下一步不丢 (Priority: P2)

无论走哪条路，成功后都用**同一次探测**刷新 `setupGate`，不出现「装完了还停在安装页」或「回到了聊天但模型列表是空的」；
provider 步骤复用 027 的表单。

**Independent Test**: 成功路径断言 `setupGate` 从 needsSetup → 完成，且出现 provider 步骤（027 组件）。

## Requirements *(mandatory)*

- **FR-001** 引导页 MUST 提供三种方式并标注适用性：**官方脚本**（按平台选 `install.ps1`(Windows) / `install.sh`(mac/Linux)）、
  **npm**（沿用三档 registry）、**手动指定 pi 路径**（已有能力）。
- **FR-002** 执行官方脚本前 MUST 展示完整命令与 URL 并要求确认；
  **不得**静默下载执行；脚本通过系统 shell 执行（Windows: powershell，其他: sh），带超时与可停止。
- **FR-003** Node 版本判断 MUST 改为 **major.minor 与 22.19 比较**（`MIN_NODE` = 22.19），
  `detect` 返回 `nodeVersion` 与 `nodeOk` 均按此口径；文案给出「需要 22.19 或更新，当前 X」。
- **FR-004** 新增设置 `nodePath`（`dev.pi.agent.nodePath`，空 = 自动探测），
  优先级：`nodePath` > 从 pi 位置推导 > 登录 shell PATH。
- **FR-005** `nodePath` 生效范围 MUST 覆盖三处：`PiLocator.locateNode()`、
  启动 pi 时的 PATH 注入（`nodeBinDirFor` 同源）、npm 安装时使用的 npm（优先取 `dirname(nodePath)` 下的 npm/npm.cmd）。
- **FR-006** `nodePath` 变更 MUST 触发与 `piPath` 相同的「重启所有项目的 pi」（`PiAgentSettings.restartPiEverywhere`）。
- **FR-007** 官方脚本与 npm MUST 共用同一条「安装中」通道：同一时刻只允许一个安装、共享停止按钮与输出区，
  且 `manage.envCancelInstall` 对脚本进程同样生效（杀进程树，不是只杀 shell）。
- **FR-008** 脚本失败 MUST 展示退出码 + 尾部输出，并在有 npm 时提供「改用 npm 重试」；
  npm 失败时的建议反向指向脚本（若平台支持）。
- **FR-009** 探测结果 MUST 增加字段说明「为什么不能安装」：缺 node / node 版本低 / 缺 npm，
  三者文案不同（现在统一是「npm not found」式的一句话，误导）。
- **FR-010** 设置界面 MUST 同时提供 `piPath` 与 `nodePath` 两个路径项，都能清空回「自动」。

## 验收口径

| 项 | 判据 |
|---|---|
| 三种方式可选 | 无 node 的 mock 环境：npm 禁用 + 脚本可点；有 node 22.19+：三者都可点 |
| 版本门槛 | 表驱动 6 个版本用例全绿；`detect.nodeOk` 与 `nodeVersion` 一致 |
| nodePath 生效 | 设置了 `nodePath` 后 `detect.node.path === nodePath`，`canInstall` 按它推导 |
| 命令可见 | 点脚本安装前 DOM 中出现完整命令与 `pi.dev/install.ps1`（或 `.sh`）URL |
| 可停止 | 安装中触发 cancel 后 5s 内进程退出、状态复位、按钮回到可点 |
| 失败原文 | 注入退出码 1 + stderr「boom」→ 错误区含「boom」，且出现「改用 npm」 |
| 零回归 | `setup.spec.ts` 7 条（012 US4 独占语义）全绿 |

## 非目标

- 不实现 nix 安装（用户已定）。
- 不做 Node 版本管理器（nvm/fnm）探测与切换——只认「用户指一个 node 可执行文件」。
- 不改安装独占语义（012 US4：缺 pi 时 App 只渲染引导子树、可停止、不可跳过）。
- 不做静默自动升级 pi（`manage.envUpdate` 保持现状）。

## 待确认 / 已知风险

- **安全**：执行 `irm … | iex` 等价于执行远端代码。规格要求「先展示命令 + 用户确认」，但仍是信任边界内的操作；
  若你希望更强（例如只允许 `npm` + 手动安装），需要在实现前改口径。
- 官方脚本安装位置与 npm 全局前缀可能不同（脚本可能装到 `~/.local/bin` 或 `%LOCALAPPDATA%\pi`）；
  装完必须靠**重新探测**定位，不能假设路径。T 任务里要有一次真机确认脚本实际落地位置。
- Windows 上 `install.ps1` 走 powershell 会受执行策略影响（`-ExecutionPolicy Bypass` 是否要显式加，需实测）。
- `MIN_NODE_MAJOR = 18` 若是历史兼容（曾有低版本可用的 pi），改成 22.19 会让一部分旧环境从「可安装」变「不可安装」——
  这是**修正**而非回归，但要在 CHANGELOG 里写清楚。

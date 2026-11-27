# Feature Specification: 诊断页的环境识别卡重做

**Feature Branch**: `[20261127-214745-diagnostics-env-card]`
**Created**: 2026-11-27
**Status**: 草稿（待实现）

**GitHub Issue**: [#14](https://github.com/57ggfk/pi-agent-idea/issues/14)

**Input**: 用户报缺陷——「诊断页版本识别区排版，自动异步检测 pi 版本。现在这样式太丑，
你也看见过。」

## 背景

「管理 → 诊断」页顶部的**环境识别卡**（`.diag-env`）把五类信息塞进一个 flex 容器：
pi 版本 + 路径、agent 目录、node 行、npm 行、插件行、以及「更新 pi」按钮。

现状（`web/src/styles.css`）：

```css
.diag-env { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.diag-env-version { flex: 1 1 auto; word-break: break-all; }
.diag-env-row { display: inline-flex; align-items: center; gap: 6px; }
.diag-env-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diag-env-update { flex: 0 0 auto; }
```

问题（用户看到的「丑」）：
- **版本行**用 `word-break: break-all` —— 长路径被拦腰截断成好几段
- **版本行**（flex 1 1 auto）与**工具行**（inline-flex）挤在同一行，基线不齐
- **按钮**跟在最后，视觉上像贴在内容尾巴上，而不是一个动作
- 「pi 1.6.1 · 路径」把版本和路径用中点连在一起，但版本是**主体**、路径是**附属**

## 附带的能力诉求：异步检测 pi 版本

「自动异步检测 pi 版本」——今天 `PiManage.environment()` 内部调
`PiLocator.locate(forceRefresh = true)`，**会起一个 `pi --version` 子进程**
（node 冷启动约 1s）。诊断页一进来就卡这一下。

**本轮刚落的 `PiDiskVersion` 正好解决**（见 `specs/20261127-190334-pi-version-display/`）：
- 优先读 npm 包的 `package.json`（纯文件读，**零子进程**）
- 用「可执行文件 + package.json 的 mtime/size」当指纹，指纹不动就不重探
- 结果已经由 `pi-disk-version` 事件推给前端（每 30 秒一跳）

所以磁盘版版本**已经是异步、且不花子进程**的——诊断卡只要用上它即可。

## 用户场景与验收

### User Story 1 — 环境卡一眼看得懂（Priority: P1）

**为什么重要**：诊断页是用户排查环境问题的地方。「这条是什么、那个路径指向哪、
版本对不对」必须在三秒内读明白，而不是在一堆挤在一起的行里找。

**独立可测**：打开诊断页，看环境卡。

**验收场景**：

1. **Given** 打开诊断页，**When** 环境卡渲染完，
   **Then** 版本、路径、node、npm、插件各占**一行**，行间对齐一致
2. **Given** pi 路径很长（nvm 多版本机），**When** 渲染，
   **Then** 路径**不拦腰断行**（省略号或独立一行），版本号完整可读
3. **Given** 窄面板（360px），**When** 渲染，
   **Then** 不横向溢出，各行仍能读

### User Story 2 — 版本号自动就位，不用等（Priority: P1）

**为什么重要**：现在进页面要等一次 `pi --version` 子进程（约 1s）才出版本号。

**验收场景**：

1. **Given** 打开诊断页，**When** 首屏渲染，
   **Then** 版本号**不阻塞**其它内容（异步到达后填入）
2. **Given** 外部升级过 pi，**When** 诊断页已打开，
   **Then** 磁盘版版本**自动更新**（复用 `pi-disk-version` 事件，无需刷新页面）
3. **Given** 探测失败，**When** 渲染，**Then** 明确显示「未检测到」而不是空白

### User Story 3 — 版本双显在诊断卡上也一致（Priority: P2）

**验收场景**：

1. **Given** 运行版与磁盘版不同（外部升级过），**When** 看诊断卡，
   **Then** 两处都显示，且标注「磁盘上的已是 X，重启后生效」

## 需求（Functional Requirements）

- **FR-001**：环境卡改为**每项一行**的纵向列表，标签与内容对齐一致。
- **FR-002**：长路径**不得**拦腰断行；用省略号 + tooltip 承载完整路径。
- **FR-003**：pi 版本**异步**取得，不阻塞首屏；「更新 pi」按钮不得因等版本而不可用。
- **FR-004**：版本探测**不起子进程**（复用 `PiDiskVersion` 的 package.json 路径）。
- **FR-005**：诊断卡显示的磁盘版与状态栏**同源**（同一个 `PiDiskVersion`），
  两处不得各探各的。
- **FR-006**：探测失败有明确文案（未检测到 / 原因），不空白。
- **FR-007**：窄面板不横向溢出（360px 判据）。

## 关键设计取舍（待拍板）

- **「未检测到」怎么表达**：空字符串、破折号、还是「未检测到 pi」一句话。
- **运行环境与磁盘版要不要分开两行**：分开更清楚（用户要知道「跑的是哪个、
  装的是哪个」），挤一行更紧凑。
- **node/npm 行要不要留在这个卡里**：它们跟 pi 版本不是一回事，挪到「工具」分组
  会让卡更聚焦——但会改变现有信息架构。

## 非目标

- 不改诊断页其它卡片（数据源列表、信任状态）。
- 不做「检查 pi 有无新版本」——pi 没有这个子命令，插件不猜。

## 边界与风险

- **复用 `PiDiskVersion` 而不是新写一套**：本轮刚落，两处同源才不会出现
  「诊断卡说 1.6.1、状态栏说 1.6.0」的新矛盾。
- **package.json 路径只覆盖 npm 安装**：非 npm 布局退回 `pi --version`（有子进程），
  这是可接受的退化（FR-004 的例外要在文案里说清）。

## 假设与依赖

- `PiDiskVersion`（`src/main/kotlin/dev/pi/agent/process/PiDiskVersion.kt`）
  与 `pi-disk-version` 事件已在本轮落地（commit `2fb8051`）。
- 诊断卡现有数据来自 `manage.environment`（`PiManage.environment()`）。

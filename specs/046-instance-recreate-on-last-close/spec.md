# Feature Specification: 关闭仅剩实例时自动重建（避免空白 / 加载不出来）

**Feature Branch**: `release/0.5.10`

**Created**: 2026-11-17

**Status**: Implemented（已实现并随 0.5.10 内测；发布文案见 changelog.d/046-*。真机验证缺口：「关闭最后一个 Content 自动重建」这一动作受 macOS 自动化权限拦截，只能从日志侧验证）

**Input**: 用户提出（2026-11-17）
> 多实例，关闭仅剩的一个就再创建出一个，相当于刷新了，避免出现空白的情况。否则可能出现强行关闭 IDE 重新打开出现一直加载不出来的问题。

## 一、意图与边界（用户已确认 2026-11-17）

- **核心期望**：工具窗里关闭**最后一个** Pi Agent Content 时，不留下空白工具窗，而是**立即自动新建**一个 Content（等价于"刷新"）——用户得到一个干净可用的实例，而不是空白页。
- **动机**：现状关掉最后一个后工具窗空白；更糟的是强关 IDE 再打开时，可能陷入"一直加载不出来"（残留状态导致新 Content 起不来）。自动重建让"关到空"这个状态不存在，从源头规避空白与卡加载。
- **范围**：仅针对"关掉最后一个实例"这一特定时机；正常多实例场景（关闭其中一个后仍有其它 Content）行为不变。

## 二、可行性与现状（读码核实）

- **多实例基建**：019 C3（0.5.9 `7147df2`）已实现——一个 ToolWindow 多 Content，各自独立 `PiAgentPanel` / JCEF / pi rpc / 事件桶；上限默认 4（`canCloseContents="true"`）。
- **关闭决策归属**：`PiAgentPanel.dispose()`（`:522-530`）注释明确"ContentManager owns the close decision. The factory asks for confirmation after removal and stops the instance only when the close is accepted; keeping this callback side-effect free lets a cancelled close recreate a fresh panel for the same instance."——即确认弹窗在 factory、accept 后才停实例、取消则重建。
- **两条 019 硬教训（必须遵守）**：① 实例计数/分配只认 `ContentManager` 真实 Content 的 panel id，**不能**用 `PiProcessManager.liveInstanceIds()`——关闭后残留长轮询会经 `slot(id)` 的 `computeIfAbsent` 重建 stale slot，让"+"永久禁用；② 关闭守卫必须用 IDE 原生 `Messages.showYesNoDialog`，点「否」要**新建** Content 而非复用已 dispose 的浏览器。
- **"一直加载不出来"根因（真机已取证 2026-11-17，见下「十、真机取证」）**：关闭仅剩实例时**旧 JCEF 页面未被销毁**（变成无 Content 的孤儿页面），同时自动建出新实例 → 页面数 1→2；孤儿页面/残留状态若被持久化，构成"强关重开卡加载"的链条。干净状态下强关重开不复现，说明卡加载依赖这条"残留 → 持久化"序列，而非无条件必现。

## 三、User Scenarios & Testing

### US1 - 关闭最后一个实例自动重建 (P1)
工具窗只剩一个 Pi Agent Content 时，用户点关闭（接受确认弹窗），系统**不**留下空白工具窗，而是立即新建一个干净 Content 并加载出可用面板（等价于刷新）。

### US2 - 强关 IDE 重开不再卡加载 (P1)
用户强关 IDE 后再打开，工具窗不再出现"一直加载不出来"——因为"关到空"状态被 US1 消除，残留状态无机会形成；若仍发生，用户可用新建 Content 恢复。

### US3 - 正常多实例零回归 (P1)
关闭一个 Content 后仍有其它 Content 时，**不**触发自动重建（只在"最后一个"时触发）；实例计数正确、"+"按钮可用、事件不串桶（019 语义不变）。

### US4 - 取消关闭不改变 (P2)
用户在确认弹窗点「否」时，保持当前 Content，不触发重建（沿用 019 现状）。

## 四、Requirements

- **FR-001** 关闭 Content 后若 `ContentManager` 中**不再有** Pi Agent Content，MUST 自动新建一个 Content 并加载可用面板；MUST NOT 留下空白工具窗。
- **FR-002** 自动重建 MUST 走与手动「+」**相同**的新建路径（同一 factory / 实例分配），MUST NOT 复制一套创建逻辑或复用已 dispose 的 JCEF 浏览器（019 硬教训②）。
- **FR-003** 实例计数/分配 MUST 只认 `ContentManager` 真实 Content 的 panel id，MUST NOT 用 `PiProcessManager.liveInstanceIds()` 等可能含 stale slot 的来源（019 硬教训①）。
- **FR-004** 关闭最后一个前的实例清理（pi 进程 / 长轮询 / 事件桶 / 队列 / token 映射）MUST 完整，确保新建 Content 不继承失效状态；这是"强关重开不卡加载"的根因修复方向。
- **FR-005** 自动重建 MUST 在确认弹窗**被接受后**触发；取消关闭（点「否」）MUST NOT 触发重建。
- **FR-006** 关闭一个后仍有其它 Content 时 MUST NOT 触发自动重建；多实例上限（默认 4）与既有行为零回归。
- **FR-007** 本机制 MUST NOT 造成无限重建循环（如新建 Content 加载失败又被判为"关闭"→再建）；须有防重入/失败保护，失败时给出可感知错误而非静默循环。

## 五、Decisions（用户已拍板 2026-11-17）

| # | 问题 | 结论 |
|---|---|---|
| Q1 | 触发时机 | 仅在"关闭后不再有 Pi Agent Content"时自动重建；取消关闭不触发 |
| Q2 | 重建形态 | 走同一新建路径创建干净 Content（等价刷新），不复用旧浏览器 |
| Q3 | 是否新增 spec | 独立 spec 046（019 已发布，属行为变更，不塞回 019） |
| Q4 | 版本 | 全部进 0.5.10 |

## 六、待 plan 阶段决定的技术问题（本规格不锁定）

- "最后一个"的判定时机与位置：在 ContentManager 的 `contentRemoved` 事件里判定，还是关闭确认 accept 回调里判定；与确认弹窗时序的精确衔接。
- "强关重开卡加载"根因的真机复现与取证（LocalUiServer 映射 / 长轮询残留 / 首启握手竞态），据此定 FR-004 的具体清理点。
- 防重建循环的判定条件与失败上报告警（FR-007）。
- 自动重建是否需要短暂"刷新中"占位态，避免闪一下空白。

## 七、不做的事

- 不改 019 多实例的其它行为（上限、确认文案、事件分桶、token 隔离）。
- 不改 042 内置浏览器的多 Content（独立能力，不共用本机制）。
- 不把"关到空"持久化成用户偏好——自动重建是固定行为，不提供开关（除非后续用户要求）。

## 八、与既有规格的关系

- **019 C3 工具窗多实例**：本规格是 019 的行为补丁；必须遵守 019 两条硬教训（FR-002/FR-003）。
- **044 / 045 / 041**：无耦合；本规格只动 Content 生命周期。

## 九、验证计划

| 层 | 用例 | 期望 |
|---|---|---|
| Kotlin 单测/集成 | 关最后一个 Content | ContentManager 中立即出现一个新 Pi Agent Content，实例 id 分配正确 |
| Kotlin 单测/集成 | 关一个但仍有其它 | 不新建；"+"可用；实例计数正确 |
| Kotlin 单测/集成 | 取消关闭 | 保持原 Content，不重建 |
| Kotlin 单测/集成 | 防循环 | 新建失败时不无限重建、有错误上报 |
| 真机 JCEF | 关最后一个 / 强关 IDE 重开 | 无空白、无"一直加载不出来"、面板可用 |

## 十、真机取证（2026-11-17，隔离实例，WebStorm 2026.2 / 插件 0.5.9）

- **环境**：独立桌面第二个 WebStorm（隔离 config/system，CDP 9223，不碰主桌面实例），untitled 项目已信任。探的是**当前 0.5.9 构建的实际行为**（046 尚未实现），属现象复现/根因取证，非修复验证。
- **步骤 1｜关闭仅剩实例**：工具窗只有 `Pi 1` 一个 Content，点其标签关闭 ×。
  - **无确认弹窗**：GUI 点击后未观察到 `Messages.showYesNoDialog`（019 说关最后一个也应走确认守卫）——关闭唯一实例时确认环节疑似被绕过，待 plan 核实。
  - **页面残留 + 自动重建**：CDP `/json/list` 页面数 **1→2**；`probe-c3-instances` 显示关闭后同时存在 `instance=1`（旧）与 `instance=2`（新），两者 URL 相同。
  - **孤儿页面**：关闭后 GUI 显示一个无标签的全新欢迎页（Pi Agent / DeepSeek 模型选择），但旧 `instance=1` 页面仍 `readyState=complete`、有 tabs/composer、无对应 Content——即**旧 JCEF 页面/pi 进程未随 Content 销毁**，成为孤儿。
  - 结论：**关闭最后一个实例造成"旧页面残留 + 新实例重建"并存**，正是 FR-004（实例清理完整）与 FR-007（防重建混乱）要解决的问题；也为"关到空 → 残留持久化 → 强关重开卡加载"提供了可信链条。
- **步骤 2｜强关 IDE 重开**：`taskkill /F` 强杀隔离实例 PID，再用同一配置重开。
  - **干净状态下不复现卡加载**：重开后页面数回到 1，CDP 立即就绪，工具窗正常显示（pi 1.5.2 已加载），无"一直加载不出来"。
  - 结论：卡加载**非无条件必现**，需"关实例残留 + 强关"的特定序列（残留写进 workspace 后被重开读取）；plan 阶段须复现该完整序列以锁定持久化点。
- **证据**：`probe-c3-instances.mjs`（适配 9223）关闭前/后快照；CDP `/json/list` 页面数 1→2；隔离桌面截图（关闭后无标签欢迎页、重开后正常工具窗）。

## 开放问题

无阻塞项。触发时机/重建形态/独立 spec/版本均已拍板；根因已真机取证（旧 JCEF 页面残留成孤儿 + 自动重建并存，卡加载依赖残留持久化序列），具体清理点与防循环细节留 plan 阶段定。

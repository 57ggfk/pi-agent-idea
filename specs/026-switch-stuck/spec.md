# Feature Specification: 会话切换卡死 —— 「仍在切换」无收敛、无取消、连带新建会话也点不动

**Feature Branch**: `release/0.5.8`

**Created**: 2026-11-12

**Status**: Draft

**Input**: 用户反馈与真机取证（2026-11-11 深夜，0.5.7 验收时抓到）
> 2 秒内连切三次会话，最后一次 `switch.pending` 之后没有 `switch.ready`，界面卡「仍在切换」超过 90 秒；
> 没有超时、没有重试、没有取消。pi 侧其实已经切好了，是前端状态没清。

**难度定位**：中偏小。改动只在 `store.ts` 的两处切换入口与一个桥接超时参数，
但**要先把「卡死」定义为可判定的失败**，否则改完只是把 360 秒缩短成 30 秒。

## 问题陈述

### 观测到的事实（真机 `idea.log` 埋点）

一次连点三次会话列表后，日志里 `switch.pending` 出现 3 次（`kind:"history"`），
`switch.ready` 出现 2 次，**最后一次没有配对**。界面停在「正在切换」占位，超过 90 秒未恢复；
期间 pi 侧 `get_state` 已经是目标会话（另开一次性 RPC 探针读到的 `sessionId` 正确），
说明**数据层没问题，是 UI 状态机没有出口**。

### 三条独立缺陷叠加，任一条单独出现都不该卡死

**① 桥接请求的默认截止时间太长。**
`bridge/jcef.ts:160` 的默认 `deadline` 是 **360 000 ms**（6 分钟），5 秒轮询清理一次。
只要 pi 漏回一条响应（切会话时 `abort` 与 `switch_session` 交叠、pi 正在压缩上下文、进程重启中），
那个 `await` 就会**悬停 6 分钟**。信号：`bridge request timeout` 在日志里要 6 分钟后才出现。

**② 旧的那次切换被「静默丢弃」，不清理自己留下的状态。**
`store.ts:1813` 先 `set({ pendingSwitch: {...} })`，RPC 回来后 `store.ts:1849` 是：

```ts
if (seq !== switchSeq) return;   // D8: a newer target owns the screen
```

注释本身没错（后到的响应不该覆盖新目标），但它**连 pendingSwitch 都不清**。
一旦最新那次自己失败了（①），界面就永久停在 pending —— 前两次的 `return` 也不会有任何补偿。

**③ `pendingSwitch` 在 `newSession` 里被当成阻塞锁，且是静默的。**
`store.ts:777`：`if (get().pendingSwitch) return;`（本意是防双击开两个会话）。
卡死之后，用户点「新建会话」**完全没有反应**——连错误都没有。用户因此只会觉得「整个插件挂了」。

此外 `switchSession` 在 RPC 之前还有 `await get().abort()`（`store.ts:1837`），
流式中途切换会让它多一段等待，同样没有超时。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 切换失败必须在可感知时间内结束 (Priority: P1)

用户连点会话列表三下（或在 pi 忙的时候点一下），无论 pi 回不回话，界面最迟在 **8 秒**内离开「正在切换」：
要么内容出来了，要么给一条「切换失败，重试」并回到会话列表。永远不出现无限等待。

**Why this priority**: 卡死是唯一会让人重启 IDE 的形态，影响面比延迟大一个量级。

**Independent Test**: mock 把 `switch_session` 的响应**永久吞掉**，断言 8s 内 `pendingSwitch === null`
且存在一条错误/可重试提示（用 fake timers 或缩短超时注入值断言，不真的等 8s）。

### User Story 2 - 连点三次，最终停在你最后点的那个会话 (Priority: P1)

三次点击后，最终显示的会话 = 第三次点的那行；中间那次的响应迟到也不能把界面拽回去
（D8 的意图保持），且迟到响应同样要清理它自己可能留下的 pending。

**Why this priority**: 现在的 D8 只保证「不覆盖」，没保证「收敛」。

**Independent Test**: mock 让第 2 次的 `get_messages` 比第 3 次晚 1s 返回；断言最终 `sessionId` 是第 3 个，
`s items` 属于第 3 个，`pendingSwitch === null`。

### User Story 3 - 卡在切换时，新建会话不是死的 (Priority: P2)

如果确实处在切换中，用户点「新建会话」应该得到**明确反馈**（「正在切换，请稍候」或直接接管为一次新的切换），
而不是按钮毫无反应。

**Why this priority**: 静默锁是「插件挂了」错觉的直接来源。

**Independent Test**: 手工 `set({pendingSwitch:{...}})`，点新建，断言出现提示或 pending 被接管为 `kind:"new"`。

### User Story 4 - 失败可重试，重试一键到位 (Priority: P2)

失败提示里带「重试」，点了重新切到原目标（记住 `file`），无需用户在列表里再找一遍。

**Independent Test**: 注入失败 → 点重试 → 断言再次发出目标为原 `file` 的 `switch_session`。

## Requirements *(mandatory)*

- **FR-001** `switch_session` 的请求 MUST 带显式超时（建议 **5s**）；`abort`（若在关键路径上）同为 5s；
  `get_messages` / `get_session_stats` / `get_state` 三段并行的总超时建议 **3s**（它们已 `catch` 兜底，超时只降级为「内容为空」而不算失败）。
- **FR-002** 「切换失败」的判据 MUST 包括**超时**，与 RPC 抛错同等处理：清 `pendingSwitch`、回会话列表、给可重试错误。
- **FR-003** 任何一次切换离开作用域时（`seq !== switchSeq` 的 early return、catch、成功），
  MUST 清理**属于自己的** pendingSwitch：判据用 `pendingSwitch.startedAt === startedAt`（或携带一个 `token`），
  **不得**清掉更新那次留下的 pending。
- **FR-004** `newSession` 在 `pendingSwitch` 存在时 MUST NOT 静默 return：要么提示「正在切换」，
  要么接管（把新的 `kind:"new"` 设为当前 pending 并让旧的那次自行作废）。
- **FR-005** 失败提示 MUST 带重试入口，并记住目标 `file`（`retrySwitch` 存进 store 的一个字段，成功后清空）。
- **FR-006** 三段并行读的 `catch(() => ...)` 兜底 MUST 保留——超时不得把「切换成功但统计缺失」升级成失败。
- **FR-007** 埋点补一条可发现的失败事件（如 `switch.failed`，带 `reason: "timeout" | "rpc"`），
  使「pending 无 ready」不再是唯一签名。

## 验收口径

| 项 | 判据 |
|---|---|
| 无限等待消失 | 吞掉 `switch_session` 响应 → `pendingSwitch` 在超时值 + 2s 内为 null，且出现错误条目 |
| 收敛到最新 | 三次点击 + 第 2 次迟到 1s → 最终 `sessionId` 与 `items` 属于第 3 个目标 |
| 不误清新 pending | 第 2 次迟到返回时，若第 3 次仍在进行，`pendingSwitch.startedAt` 不变 |
| 新建不再静默 | pending 存在时点新建 → DOM 出现提示或 pending.kind === "new" |
| 重试可用 | 失败后点重试 → 发出的 `switch_session.sessionPath` === 原目标 file |
| 零回归 | 021 的 T1–T4 阈值断言（mock 注入 1.2s 延迟）全绿 |

## 非目标

- 不改 021 的乐观切换设计（先跳页、后填内容）。
- 不改 bridge 的**全局**默认 deadline（360s 仍适用于 npm 安装、`pi update` 等长任务），只在切换相关调用上传入更短的超时。
- 不做自动重试（失败即提示，重试由用户触发），避免在 pi 真的忙时打转。

## 待确认 / 已知风险

- 360s 的全局默认值是给安装/升级这类长任务用的，**不要**为了本条把它调小。
- 「abort 卡住」是否是本次卡死的真实触发点尚未逐帧确证（只确证了「最后一次无 ready」）。
  实现时先按超时兜底，再由 `switch.failed` 埋点在真机上补一次归因；若确认是 `abort`，
  则 `abort` 也应从关键路径移到后台（它不阻塞内容填充）。

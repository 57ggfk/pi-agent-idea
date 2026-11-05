# Implementation Plan: 消息级 Fork、底部 Fork 隐藏与确认框

**Feature**: `specs/007-message-fork/spec.md`

**Branch**: `release/0.5.2`

**Status**: ✅ 已实现（2026-11-05）。V1/V2 已对 pi 1.5.0 实测，见下文「待验证事项」与
`fork-semantics.json`；20/21 task 完成，仅 T020 真机 JCEF 目视待做。

## 摘要

三块：① 消息工具条新增 Fork，把「分支点」从「最后一条用户消息」变成「任意一条 pi 回复」；
② 底部 Fork 用一个常量隐藏（不删代码）；③ 引入统一的应用内确认弹窗，替换 `window.confirm` 与现有的 New 行为。

## 技术上下文

- 分支协议（已实测于 0.5.1）：`get_fork_messages` → `[{entryId, text}]`（用户消息，oldest first）；
  `fork{entryId}` → `{text, cancelled}`，**不返回会话路径**；分支后须 `syncAfterBranch()` 从 pi 重读消息并刷新会话列表。
- `clone`：`clone{sessionPath}` → `{cancelled}`，把当前会话整体复制为新会话。
- 前端：`web/src/store/store.ts`（zustand）、`web/src/components/MessageActions.tsx`（工具条）、
  `web/src/components/Composer.tsx`（底部控制栏）。
- mock：`web/src/bridge/mock.ts` 已有 `get_fork_messages` 与 `fork`（005 建立），需扩展为**任意 entry 可分支**。

## 待验证事项（结论已出，2026-11-05 实测 pi 1.5.0）

> 证据：`specs/007-message-fork/fork-semantics.json`（原始 RPC 报文 + 前后消息序列）。
> 探针：`pi --mode rpc --no-tools --session-dir <temp>`，两步 prompt 后 `get_fork_messages`
> → `fork` 第二条用户消息 → `get_messages` → `clone` → `get_messages`。

**V1. `fork(entryId)` 的边界语义 —— 结论：不包含该 entry（position: before）**

实测：会话 U1/A1/U2/A2，`get_fork_messages` 返回 `[{entryId, "第一条…"}, {entryId, "第二条…"}]`；
对**第二条**用户消息 fork → 新会话消息序列为 `system + U1/A1`，`U2/A2` 不在其中，
响应体 `{text: "第二条…", cancelled: false}` 里的 `text` 是**被排除**的那条用户消息。
即 fork 的分支点在目标 entry **之前**，与 `get_fork_messages` 的「用户消息」粒度天然对齐。

| 结论 | 实现取法 |
|---|---|
| 不包含 entry | 对 assistant A<sub>i</sub>，取 A<sub>i</sub> **之后第一条用户消息** U<sub>i+1</sub> 的 entryId → 新会话恰为 `U1/A1/…/A_i`；末条回复无后继用户消息，走 `clone` |

**方案 B 不再需要**：协议粒度足够，消息级 Fork 可以准确实现，按钮不必降级隐藏。

**V2. `clone` 与 `fork` 在队列 / 统计上的差异 —— 结论：clone 复制整条活动分支，队列不跟随**

实测：`{"type":"clone"}` **不需要** `sessionPath`；clone 后 `sessionId` / `sessionFile` 换新，
`get_messages` 与 clone 前逐条一致（本例 fork 后是 3 条，clone 后仍是同样的 3 条），
`get_session_stats` 按新会话重算（`userMessages` 从 2 → 1，因为 fork 已经截断），
新会话 `pendingMessageCount` 为 0（队列未跟随）。
→ 末条回复 Fork 用 `clone` 是安全的；FR-013 的「清队列/草稿」仍按原计划在分支后主动执行，
不依赖协议行为。


## 设计决策

### D1. 分支点解析放进 store，不在组件里算

```
forkAtItem(itemId: number): Promise<void>
```
1. `items` 里定位该 assistant 条目的序号 `i`；
2. 统计 `items[0..i]` 中 user 消息数 `k`；
3. `entries = await forkEntries(bridge)`；若 `entries.length === 0` → 报错「没有可分支的提问」；
4. 目标 entry = `entries[k]`（下一条用户消息）或 末条走 clone（见 V1/V2）；
5. `fork` → `syncAfterBranch()` → 清空草稿/图片/队列（FR-013）。

把「assistant 序号 → 目标 entry 序号」抽成纯函数 `branchTargetFor(...)`，用 vitest 直接断言。
实现落地为 `branchTargetFor(userCount, forkableCount)`（+ `userCountUpTo(items, index)`）：
两条输入都来自 store，纯函数不做 DOM 之外的判断，`store.test.ts` 覆盖中间回复 / 末条 / 无 entry 三种。

### D2. 底部 Fork：常量隐藏，不删代码

```ts
// Composer.tsx —— 0.5.2 隐藏底部 Fork，功能改由消息工具条提供（spec 007 US2）。
// 恢复时改回 true 即可，密度测量按实际渲染的子节点计算，无需其他改动。
const SHOW_COMPOSER_FORK = false;
```
- 用 `{SHOW_COMPOSER_FORK ? <button .../> : null}`，**不**用 CSS `display:none`——
  后者仍会参与 `children` 遍历，`measureDensity()` 会把不可见按钮的宽度算进去。

### D3. 统一确认弹窗

- store 增加 `confirm: ConfirmRequest | null` + `askConfirm(req)` / `closeConfirm()`。
- 新组件 `web/src/components/ConfirmDialog.tsx` 挂在 `App` 的 `.app` 内（唯一实例）：
  `role="dialog" aria-modal="true"`、遮罩拦截点击、`pointer-events` 与滚动锁、
  Tab 焦点圈定（首/末元素循环）、Esc 取消、Enter 确认、打开时聚焦主按钮。
- 调用点：`newSession`（有内容或流式中）、`forkSession`（底部，虽然 UI 隐藏但保留能力）、
  `forkAtItem`、`deleteSession`（Sessions 页）。
- 文案先写英文原文，并在同一行用注释标出将来的 i18n key（`// i18n: confirm.newSession.title`）。
  i18n 在 008 落地（`i18next`），此处**不要**提前建常量表或接 `t()`——008 会按 key 规约统一搬迁。

### D4. 队列与草稿的清理时机

`syncAfterBranch()` 之后统一调用现有的 `resetComposerState()`（若无则新增）：清空 `items` 之外
只属于旧会话的状态——`pendingPrompt`、`editing`、`images`（由 Composer 本地 state 持有，需通过
`pendingPrompt` 之外的信号触发，实现时新增 `composerResetSeq` 计数器，Composer `useEffect` 监听后清空）。

## 触及文件

| 文件 | 改动 |
|---|---|
| `web/src/store/store.ts` | `forkAtItem`、`branchTargetFor`（导出纯函数）、`confirm` 切片、`newSession` 接确认、`deleteSession` 接确认、分支后状态清理 |
| `web/src/components/MessageActions.tsx` | 工具条新增 Fork 图标按钮（`actionsForItem` 增加 `fork` 动作） |
| `web/src/store/types.ts` | `MessageAction` 增加 `"fork"`；适用矩阵：assistant + 空闲 + 有前置用户消息 |
| `web/src/components/ConfirmDialog.tsx` | **新增** |
| `web/src/App.tsx` | 挂载 `<ConfirmDialog />` |
| `web/src/components/Composer.tsx` | `SHOW_COMPOSER_FORK = false`、New 走 `askConfirm` |
| `web/src/components/SessionsView.tsx` | 删除确认改走 `askConfirm` |
| `web/src/bridge/mock.ts` | `fork` 支持任意 entryId：按 entry 之前的消息重建 transcript；`clone` 复制完整 transcript |
| `web/e2e/message-fork.spec.ts` | **新增** |
| `web/e2e/confirm.spec.ts` | **新增** |
| `web/src/store/store.test.ts` | `branchTargetFor` 与矩阵用例 |

## 顺序

1. **V1/V2 协议验证**（真机或 RPC 直连），结论写回本文件。
2. `types.ts` 动作矩阵 + `branchTargetFor` 单测（红 → 绿）。
3. mock 扩展（否则 e2e 无从断言）。
4. `forkAtItem` + 工具条按钮 + e2e。
5. `ConfirmDialog` + 四个调用点 + e2e（含 Esc/Enter/焦点圈定/几何）。
6. 底部 Fork 隐藏 + 密度回归（360px 不换行）。
7. 真机：JCEF 内确认框渲染、消息工具条 hover、fork 后切回旧会话。

## 风险

| 风险 | 缓解 |
|---|---|
| V1 结论是「包含 entry」→ 消息级 Fork 无法精确实现 | 走方案 B：隐藏按钮而非给出错误行为；把限制写进 CHANGELOG「已知限制」 |
| `fork` 后 `items` 与工具条状态不同步（0.5.1 曾踩过） | 复用 `syncAfterBranch()`，并 e2e 断言 fork 后工具条只出现在正确位置（旧消息不应再出现 Fork） |
| 确认弹窗在 JCEF 里的焦点/滚动行为与 Chromium 不一致 | e2e 断言焦点与滚动锁；真机目视一次 |
| 隐藏底部 Fork 后，用户找不到 Fork 入口 | 消息工具条 Fork 在最后一条回复上始终出现；CHANGELOG 明写「Fork 已移到消息工具条」 |

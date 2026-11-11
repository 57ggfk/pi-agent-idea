# 026 会话切换卡死 — 技术方案

> 依据 spec.md（2026-11-12）与 2026-11-12 代码复核。所有行号以当次复核为准。

## 0. 复核结论（写方案前逐条核实过）

| spec 断言 | 复核结果 |
|---|---|
| `jcef.ts:160` 默认 deadline 360s | ✅ 属实：`timeoutMs ?? 360_000`，`timeoutLoop` 每 5s 扫一次（ Granularity 5s → 桥接层超时最少迟到 5s） |
| `store.ts:1849` `if (seq !== switchSeq) return;` 不清自己的 pending | ✅ 属实，try 与 catch 两处 early return 都不清 |
| `store.ts:777` `newSession` 被 pending 静默挡住 | ✅ 属实：`if (get().pendingSwitch) return;` |
| `store.ts:1837` `await get().abort()` 无超时 | ✅ 属实；`abort` 内部 `catch` 吞错但 rpc 不返回时 await 悬挂 |
| 三段读已有 `.catch` 兜底 | ✅ 属实（`store.ts:1842-1848`），超时只需接入现有兜底 |
| mock 无「永久吞响应」旋钮 | ✅ 属实：`?slow=` / `?failcmd=` 均 one-shot（`mock.ts:403-409,395-401`），新增 `?hang=` |

**关键设计裁决：超时在 store 侧实现（`withTimeout` race），不传 `bridge.request` 的 `timeoutMs`。**
理由：JCEF 的 `timeoutLoop` 粒度 5s，桥接层 5s 超时实际在 5–10s 之间触发，破坏 US1 的 8s 预算；
store 侧 `setTimeout` 精确、可被 fake timers 测试、且不碰 spec 明令不改的全局 360s 默认值。
迟到响应/迟到拒绝已由 race 的 then 处理器接住，不会产生 unhandled rejection。

## 1. 常量（全部集中在 store.ts，名字带 SWITCH 前缀防误用）

```ts
const SWITCH_RPC_TIMEOUT_MS = 5_000;   // switch_session / new_session（FR-001 建议 5s）
const SWITCH_ABORT_TIMEOUT_MS = 3_000; // 关键路径上的 abort（3+5=8s 恰为 US1 预算上限）
const SWITCH_READ_TIMEOUT_MS = 3_000;  // 三段并行读；超时仅降级为空内容（FR-006）
```

abort 取 3s 的理由：abort → switch_session 串行，3+5 = 8s 正好贴住 US1「最迟 8 秒」；
spec 的「abort 同为 5s」是建议值，与 8s 预算冲突时以验收口径（US1）为准，plan 记录在案。

## 2. `lib/timeout.ts`（新文件）

```ts
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T>
```

- 计时器先到 → reject `Error(`${label} timeout`)`；
- 底层 promise 后到 → 已 settled 的 race 不再变化，resolve/reject 均被 then 处理器接住（无 unhandled rejection，单测覆盖）；
- 不引入 AbortController—— pi 侧命令无法真正取消，取消只是本地放弃等待。

## 3. store.ts 改动（四组）

### 3.1 超时接线（FR-001/002）

| 调用点 | 现状 | 改为 |
|---|---|---|
| `switchSession` 内 `switch_session` | 裸 rpc | `withTimeout(rpc(...), SWITCH_RPC_TIMEOUT_MS, "switch_session")` |
| `switchSession` 内 `abort`（wasStreaming） | 裸 `await get().abort()` | `withTimeout(..., SWITCH_ABORT_TIMEOUT_MS, "abort")`，超时按切换失败处理 |
| `switchSession` 内三段读 | 裸 rpc + `.catch` | 各包 `withTimeout(..., SWITCH_READ_TIMEOUT_MS, ...)`，`.catch` 兜底原样保留（超时→空内容，不算失败） |
| `runNewSession` 内 `new_session` | 裸 rpc | `withTimeout(..., SWITCH_RPC_TIMEOUT_MS, "new_session")` |

超时与 RPC 抛错走同一条 catch：清 pending（identity 判据）、`tab:"sessions"`、错误条目、`retrySwitch=file`。

### 3.2 FR-003 identity 清理

```ts
const clearOwnPending = (startedAt: number) => {
  if (get().pendingSwitch?.startedAt === startedAt) set({ pendingSwitch: null });
};
```

接线点（spec 列举的三类出口全覆盖）：
- `switchSession`：try 内 seq 早退、catch 内 seq 早退（成功路径的 `pendingSwitch: null` 仅在 seq 匹配时执行，语义已正确，不动）；
- `runNewSession`：try / catch 两处 seq 早退各加一行。

### 3.3 FR-004 newSession 接管

```ts
// 旧：if (get().pendingSwitch) return;
// 新：
const pending = get().pendingSwitch;
if (pending?.kind === "new") return; // D8 保留：同动作去重，防 pi 侧开出两个空会话；
                                     // 屏上已有「正在切换」占位 = FR-004 的提示形态
// kind:"history" → 接管：不再 early return，落到下方 seq bump + 新 pending，
// 旧 history 切换由 seq 早退 + identity 清理自行作废
```

裁决记录：`kind:"history"` 接管（US3 判据「pending.kind === "new"」）；`kind:"new"` 早退保留 021 D8
（第二个 new 与第一个同意图，fire 两发 `new_session` 会让 pi 开出两个孤儿空会话；占位符即提示）。
既有单测「ignores a second new-session request while one is in flight」预期不变。

### 3.4 FR-005 重试 + FR-007 埋点

- state 增 `retrySwitch: string | null`；action 增 `retryLastSwitch(): Promise<void>`（读字段调 `switchSession`）。
- 写入点：`switchSession` catch（seq 匹配时）。清空点：history 切换成功、newSession 成功、迟到成功（seq 匹配的成功路径统一清）、bar 上的 ×。
- `perf.ts` 的 `PerfEvent` 增 `"switch.failed"`；catch（seq 匹配）里发
  `perfMark("switch.failed", startedAt, { reason: msg.includes("timeout") ? "timeout" : "rpc" })`，
  abort 超时发 `reason=abort_timeout`。stale 失败（seq 早退）不发——失败属于已让屏的旧作用域。

## 4. UI：`SwitchRetryBar`（新组件，App 级挂载）

- 挂载点：`App.tsx` 的 `<QueueDiscardBanner />` 之后——**所有 tab 可见**（失败落在 sessions tab，错误条目在 chat 的 items 里不可见，这正是需要独立 bar 的原因）。
- 结构：`data-testid="switch-retry-bar"`，文案 `switch.failed`（title 属性带目标 file），
  按钮「重试」`data-testid="switch-retry-btn"`（调 `retryLastSwitch`）、
  关闭 `data-testid="switch-retry-dismiss"`（清 `retrySwitch`）。
- 样式：新增 `.switch-retry-bar`（复用 `.setup-gate-error` 的横条模式，warning 色）。
- i18n：`switch.failed`（zh/en 双字典）+ 复用既有 `common.retry`。

## 5. mock：`?hang=<cmd>[:count]`（e2e 注入「永久吞响应」）

- `parseFailPlan` 复用（`?hang=switch_session` = 1 次）；`hangPlan` + `hangServed` 与 `failCmd*` 同构。
- 接线点：`request()` 内 `shouldFailCommand` 之后、`commandDelay` 之前：
  `if (this.shouldHangCommand(type)) return new Promise(() => {})`（永不 settle）。
- 不碰 `?slow=`/`?failcmd=` 语义（one-shot 延迟/失败保持原样，021 的阈值测试零回归）。

## 6. 测试设计

### 单测（store.test.ts，fake timers；util 单独 timeout.test.ts）

| # | 场景 | 断言 |
|---|---|---|
| U1 | switch_session 永不返回，advance 5s | pendingSwitch null、tab=sessions、items 有 isError、retrySwitch=file、`switch.failed reason=timeout` |
| U2 | 三段读 get_messages 永不返回，advance 3s | 切换成功（pending null、无 isError、tab 停在 chat、items 空数组）——FR-006 不升级为失败 |
| U3 | wasStreaming + abort 永不返回，advance 3s | 走失败路径、`reason=abort_timeout` |
| U4 | A 切换中、B 接管，A 的 rpc **reject** 迟到 | B 的 pending 原样（startedAt 不变）、retrySwitch 不被 A 污染 |
| U5 | B 完成后 A 的 get_messages 迟到 resolve | items/sessionName 仍是 B 的（内容级不拽回） |
| U6 | pendingSwitch={kind:"history"} 时 newSession | 接管：pending 变 kind:"new"，new_session 发出 |
| U7 | pendingSwitch={kind:"new"} 时 newSession | 早退：不发 new_session（D8） |
| U8 | 超时失败后点 retryLastSwitch | 再次发出的 switch_session.sessionPath === 原 file；成功后 retrySwitch null |
| U9 | withTimeout：晚到的 resolve/reject 不产生 unhandled rejection | timeout.test.ts |
| U10 | 正常路径不超时（既有 021 断言） | 全部保持绿 |

### e2e（web/e2e/switch-stuck.spec.ts，新文件）

| # | 注入 | 断言 |
|---|---|---|
| E1 | `?hang=switch_session` | 点行 → 8s 内 retry bar 可见、`session-switching` 占位消失、回到 sessions tab |
| E2 | `?failcmd=switch_session` | 点行 → bar 出现 → 点重试 → 第二次成功落 chat、bar 消失 |
| E3 | `?slow=switch_session:5000` | 点行后立即点新建 → empty-state 快速出现（接管生效，非静默）；5s 后仍 empty-state 且无 A 的内容 |
| E4 | `?slow=get_messages:1000` | 点行 A 再点行 B → 最终 title/items 是 B；A 的内容永不渲染；占位由 B 收敛 |
| E5 | （零回归）sessions.spec.ts 既有 021 阈值测试 | 全绿 |

E1 真等 5s 超时（playwright timeout 8s 内断言），是本 spec 唯一的真实时钟成本。

## 7. 触及文件

```
web/src/lib/timeout.ts            新增
web/src/lib/timeout.test.ts       新增
web/src/lib/perf.ts               PerfEvent + switch.failed
web/src/store/store.ts            核心（超时/identity/接管/retry/埋点）
web/src/components/SwitchRetryBar.tsx  新增
web/src/App.tsx                   挂载 bar
web/src/styles.css                .switch-retry-bar
web/src/i18n/*                    switch.failed 等键（zh/en）
web/src/bridge/mock.ts            ?hang= 旋钮
web/src/store/store.test.ts       U1–U8
web/e2e/switch-stuck.spec.ts      E1–E4
```

不改：`jcef.ts`（全局 360s 保留）、`rpc()` 签名（不传 timeoutMs，理由见 §0）、021 的乐观切换结构。

## 8. 风险与边界

- **超时后的迟到成功**：pi 实际切成功了但 UI 已报失败（retrySwitch=file）。迟到响应在 seq 匹配时仍会
  填充内容并清 retrySwitch（§3.4 清空点）——数据最终一致，用户看到的失败条目不回滚（可接受，注释说明）。
- **接管时机**：newSession 接管发生在 queue 确认**之后**（队列确认优先，避免确认框被接管路径绕过）。
- **fake timers 与 vi.waitFor**：U 组测试用 `vi.useFakeTimers({ shouldAdvanceTime: true })` 或手动
  advance，避免与 store 内部 `setTimeout(0)` 的收尾任务死锁；实现时按实际表现选。

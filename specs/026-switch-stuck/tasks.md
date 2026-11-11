# 026 会话切换卡死 — Tasks

> 每个 task 自带「— 验证」，绿了立刻提交（宪法第 II 条）。执行顺序即编号顺序。

- [x] **T801** `web/src/lib/timeout.ts`：`withTimeout<T>(p, ms, label)` —— 先到者赢；晚到的
  resolve/reject 必须被 then 处理器接住（无 unhandled rejection）；label 进错误消息。
  — 验证：新增 `web/src/lib/timeout.test.ts`，含「先到者赢」「晚到 resolve 不翻转」「晚到 reject
  不产生 unhandled rejection（进程级监听断言）」「错误消息含 label」四条，`npx vitest run
  timeout.test.ts` 全绿。

- [x] **T802** `web/src/lib/perf.ts`：`PerfEvent` 增 `"switch.failed"`（FR-007 的埋点载体）。
  — 验证：`perf.test.ts` 增一条格式断言（`[pi-agent] perf switch.failed 123 reason=timeout`），
  `npx vitest run perf.test.ts` 全绿。

- [x] **T803** `store.ts` 超时接线（FR-001/002/006）：`switch_session`/`new_session` 5s、关键路径
  `abort` 3s、三段并行读各 3s（`.catch` 兜底原样保留，读超时只降级为空内容）；超时错误与 RPC 抛错
  走同一条失败路径；catch（seq 匹配）发 `switch.failed`（reason=timeout|rpc|abort_timeout）。
  — 验证：`store.test.ts` 新增 U1（吞 switch_session → 5s 后 pending 清空+回列表+错误条目+埋点）、
  U2（读超时降级不算失败）、U3（abort 超时走失败，reason=abort_timeout）三条绿；既有 021 断言全绿。

- [x] **T804** `store.ts` FR-003 identity 清理：`clearOwnPending(startedAt)` 助手，接线
  `switchSession` try/catch 两处 seq 早退与 `runNewSession` try/catch 两处 seq 早退；不得清掉
  更新一次留下的 pending。
  — 验证：`store.test.ts` 新增 U4（A 迟到 reject 不清 B 的 pending、retrySwitch 不被 A 污染）、
  U5（A 的 get_messages 迟到 resolve，内容仍是 B 的）两条绿；既有「drops a late response」仍绿。

- [ ] **T805** `store.ts` FR-004：`runNewSession` 改判定——`pending?.kind === "new"` 才早退（D8
  防双开保留，屏上占位即提示）；`kind:"history"` 接管（落到 seq bump + 新 pending，旧切换由 T804
  的 identity 清理自行作废）。
  — 验证：`store.test.ts` 新增 U6（history pending 时点新建 → 接管为 kind:"new" 且 new_session
  发出）、U7（new pending 时点新建 → 早退不发）两条绿；既有「ignores a second new-session」
  （calls===1）仍绿。

- [ ] **T806** `store.ts` FR-005：state 增 `retrySwitch: string | null`、action 增
  `retryLastSwitch()`；写入点=switchSession catch（seq 匹配）；清空点=history 成功、newSession
  成功、迟到成功（统一放 seq 匹配的成功路径）、bar 的 ×。
  — 验证：`store.test.ts` 新增 U8（超时失败 → retrySwitch=file → retryLastSwitch 重发原 file →
  成功后 retrySwitch null）绿；U1 断言含 retrySwitch=file。

- [ ] **T807** `bridge/mock.ts`：`?hang=<cmd>[:count]` —— 首次（或前 N 次）rpc 命令永不 settle；
  接线在 `shouldFailCommand` 之后、`commandDelay` 之前；`?slow=`/`?failcmd=` 语义不变。
  — 验证：`mock.test.ts` 新增一条（首次调用挂起、第二次正常返回），`npx vitest run mock.test.ts`
  全绿。

- [ ] **T808** UI：`SwitchRetryBar.tsx`（bar + 重试 + ×，data-testid 三件套）+ `App.tsx` 挂载在
  `<QueueDiscardBanner />` 之后（所有 tab 可见）+ `styles.css` 的 `.switch-retry-bar` + i18n
  `switch.failed`（zh/en 双字典，复用 `common.retry`）。
  — 验证：`npm run typecheck` 0 错误；`npx vitest run` 全绿（store 层断言已覆盖状态机）；
  bar 的可见性/点击行为由 T809 的 e2e 锁。

- [ ] **T809** e2e：新增 `web/e2e/switch-stuck.spec.ts` 四条——E1 吞响应 8s 内收敛到 retry bar
  并回 sessions；E2 失败 → 点重试 → 落 chat 且 bar 消失；E3 history pending 时点新建 → empty-state
  快速出现（接管非静默）、5s 后无旧内容回灌；E4 A 读迟到 1s → 最终 title/items 是 B、A 内容永不渲染。
  — 验证：`npx playwright test switch-stuck` 4 条全绿；`npx playwright test sessions`（021 阈值）
  零回归。

- [ ] **T810** 收尾：全量三件套（`npm run typecheck` + `npx vitest run` + `npx playwright test`）；
  写 `changelog.d/026-switch-timeout.fixed.md`（两行：中文/英文，只写用户可见变化）；更新
  `specs/0.5.8-run-report.md` 第 2 节（勾 task、记基线变化）。
  — 验证：三件套全绿；changelog 两行格式通过既有 `collectChangelog`/CI 校验；run-report 第 2 节
  026 全部 ✅、无遗留 ⬜。

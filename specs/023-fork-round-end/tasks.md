# Tasks: 023 Fork 以「整轮」为单位

> 状态：**已实现并验收**（2026-11-11）。T516 真机：131 条消息 / 44 轮的会话上 44 个 Fork、零错位
> （见 [0.5.7-run-report](../0.5.7-run-report.md)）。
> 顺序即编号，串行执行。技术方案、算法、场景剧本一律以 [plan.md](./plan.md) 为准；本文只排顺序与验证方式。
> 每条 task 自带「— 验证：…」；无断言覆盖的实现不得标记完成（宪法第 II 条）。
> **禁止**把既有 e2e 断言放宽成「至少 1 个」「count > 0」来掩盖本次语义变更。

## 阶段 1：判据（S1）

- [x] **T501** [US1] `ActionContext` 增加 `isRoundEnd: boolean`，注释写明「该回复之后、下一条用户消息之前没有其他 pi 回复」（plan D1/D2）— 验证：`npm run typecheck` 通过；`types.test.ts` 的 `IDLE` 同步补 `isRoundEnd: true`
- [x] **T502** [US1] `actionsForItem` 的 `canFork` 加上 `ctx.isRoundEnd`；两处分支（有文字 / 无文字）的 `"fork"` 都由它控制（plan D1/D5）— 验证：单测 `isRoundEnd: false` 时 `copy`/`quote` 仍在、`fork` 不在；`isRoundEnd: true` 时 `fork` 在
- [x] **T503** [US1] 改造既有单测：`"offers Fork on a middle pi reply (007 FR-001)"` 改名为「中间轮次的末尾回复仍有 Fork（023 FR-001）」；新增 `"hides Fork on a mid-round reply"`（`isRoundEnd: false`）；纯图片那条的期望同步（plan D7）— 验证：`npx vitest run src/store/types.test.ts` 全绿，且新用例的断言是 `not.toContain("fork")` 这类明确断言

## 阶段 2：组件（S2）

- [x] **T504** [US1] `MessageList` 在 `lastUser` / `lastAssistant` 同一次扫描里算出 `roundEnd[]`（前缀扫描，**system 消息不结算轮次**），并在 `actionsForItem` 调用处传 `isRoundEnd`（plan D2）— 验证：`npm run typecheck`；e2e 场景 A（单轮 2 条回复只有末尾有 Fork）通过

## 阶段 3：store 规范化（S3）

- [x] **T505** [US2] 新增 `roundEndIndex(items, index)`：从 `index` 向后推进到本轮最后一条 assistant，遇 user 停止（plan D3）— 验证：`store.test.ts` 覆盖五种形状——首条即末尾 / 中间 / 末条 / 该轮无 assistant（返回 -1）/ 尾部跟随 system 消息
- [x] **T506** [US2] `forkAtItem` 先用 `roundEndIndex` 规范化，再用规范化后的项计算 `isLast` 与传给 `runForkAtItem`（plan D3）— 验证：单测断言「以中间回复触发」与「以末尾触发」发出的命令序列与 `entryId` 完全一致；文案分支（`.last` / `.middle`）也一致
- [x] **T507** [US2] `runForkAtItem` 的分支点改用规范化后的下标（`userCountUpTo(items, end)`）— 验证：store 单测断言同轮中间触发产出的 `fork {entryId}` 与末尾触发相同；e2e 场景 C 通过

## 阶段 4：测试同步（S4）

- [x] **T508** [US1] `e2e/message-fork.spec.ts` 的 `forkAt()` helper 改为定位**本轮最后一条** pi 回复（当前 `.first()` 在 mock 下是工具调用那条）；受影响的 4 个用例逐条改（plan D7）— 验证：`npx playwright test e2e/message-fork.spec.ts` 全绿，无跳过
- [x] **T509** [US1] 新增 e2e：场景 A（悬停中间回复无 Fork、末尾有 Fork、总入口数）与场景 B（两轮恰好 2 个入口）— 验证：断言具体那一条回复的 `act-fork` 数量为 0 / 1，不用「至少」
- [x] **T510** [US1] 新增 e2e 场景 G：末尾追加系统错误消息后，该轮 Fork 仍在（system 不结算轮次）— 验证：错误消息出现后 `act-fork` 仍为 1
- [x] **T511** [US3] 新增回归断言：中间回复悬停时工具条可见且含复制/引用（plan D5）— 验证：`act-copy` 数量 1、`act-fork` 数量 0、`msg-actions` 可见
- [x] **T512** [US4] 确认末轮 clone 行为未变：既有「forking the last reply keeps every message」用例改定位后仍通过，文案断言仍为 `/whole conversation/i`（plan D6）— 验证：该用例全绿
- [x] **T513** [US1] 同步 `e2e/confirm.spec.ts:172`、`e2e/sessions.spec.ts:52`、`e2e/session-search.spec.ts:134` 三处 `.first()` 定位到本轮末尾 — 验证：三个文件全绿
- [x] **T514** [US2] 探针用例：插话（steer）后再 Fork，记录实际岔到哪一轮（spec「待确认」项）— 验证：用例里打印/断言实际 `entryId`；若错位一位，登记为独立缺陷而不在本 spec 就地扩大改动

## 阶段 5：收尾（S5）

- [x] **T515** 全量校验：`npm run typecheck` → `npx vitest run` → `npx playwright test`（含 020/021/022 已有用例不回归）— 验证：三条命令全绿，失败项逐条记录
- [x] **T516** 真机（WebStorm 2026.2 + 装包）目视：单轮 / 两轮会话的 Fork 入口数、中间回复工具条、末轮 clone — 验证：截图或文字记录写入 0.5.7 run report；同时勾选本文件所有 task

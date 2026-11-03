---
description: "Task list for 005-message-queue"
---

# Tasks: 插件镜像队列（排队 · 排序 · 取回 · 插话 · 暂停）

**Input**: Design documents from `/specs/005-message-queue/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)（2026-11-03 修订版）

**Tests**: 包含。宪法第 II 条要求「没有断言覆盖的改动不得标记完成」，故每个 story 自带测试任务。

**Organization**: 按 user story 分组，每个 story 可独立交付。

## Format: `[ID] [P?] [Story] Description — 验证：...`

- **[P]**: 可并行（不同文件、无依赖）
- **[Story]**: US1=排队可见 / US2=按序执行 / US3=取回编辑 / US4=排序删除 / US5=插话 / US6=提升 / US7=暂停恢复

## Path Conventions

单仓双端：宿主 `src/main/kotlin/dev/pi/agent/`，前端 `web/src/`，测试 `src/test/kotlin` + `web/e2e`。

---

## Phase 1: Foundational（阻塞所有 story）

**Purpose**: 先把跨端契约与镜像骨架立起来。这一层做错，七个 story 会各自发明字段。

- [ ] **T001** 在 `web/src/store/types.ts` 声明 `QueueItem`（id / mode / text / images / status / error /
  createdAt）、`QueueState`（items / paused / pauseReason / drift）、`queue_state` 事件与 8 个 `queue.*`
  命令的参数类型；`web/src/bridge/types.ts` 的 `BridgeMethod` 同步加这 8 个 — 验证：`tsc --noEmit` 通过
- [ ] **T002** 在 `BridgeService` 注册 8 个 `queue.*` 分发分支（先返回 `not_implemented` 占位），
  并在 pi 事件转发处把 `queue_update` 喂给队列服务 — 验证：`./gradlew compileKotlin` 通过，
  前端调用拿到结构化错误而不是 bridge 500
- [ ] **T003** [P] `mock.ts`：把 `queue_update` 从"计数假事件"改为**真实契约仿真**
  （`{steering: string[], followUp: string[]}` 完整队列）；实现 8 个 `queue.*`；加 `?queuefail=<cmd>`
  让任一命令可失败、`?queuedrift=1` 让 pi 侧与镜像对不上 — 验证：Vitest 里可断言失败态与漂移态
- [ ] **T004** [P] 新增 `src/main/kotlin/dev/pi/agent/queue/PiMessageQueue.kt` 骨架：project 级服务、
  单线程执行器、镜像 `MutableList<QueueItem>`、`queue_update` 入口、`snapshot()` — 验证：
  `PiMessageQueueTest` 能构造实例并读回空快照
- [ ] **T005** [P] `PiMessageQueueTest` 骨架 + 文本对齐用例（条数相等且逐条文本相等 → 镜像可信；
  否则重建为无图条目并置 drift）— 验证：单测覆盖一致 / 数量不符 / 文本不符三种

**Checkpoint**: 契约就位，7 个 story 可并行开工。

---

## Phase 2: US1 — 排队即可见（P1）

**Goal**: 流式中发送的消息进队列并在输入框上方显示，替代永不更新的假计数。

- [ ] **T006** [US1] `store.ts`：删除假 `queue_update` 计数分支，改为处理 `queue_state`
  （全量替换 items + paused/drift）；`queue` 字段从 `{steering, followUp}` 改为 `QueueItem[]` —
  验证：单测断言收到 `queue_state` 后 store 的 items 与事件一致
- [ ] **T007** [US1] 新增 `components/QueueBar.tsx`：条目显示序号、模式标签（插话 / 追加）、
  120 字预览、图片计数；空队列不渲染 — 验证：Playwright 断言两条消息 → 两个条目、序号 1/2、
  预览超长截断
- [ ] **T008** [US1] `Composer.tsx`：流式中发送改走 `queue.enqueue`（按 `mode` 决定条目模式），
  空闲时保持直发 `prompt`；发送后清空输入框 — 验证：e2e 断言流式中发送后输入框清空且队列条出现条目
- [ ] **T009** [US1] e2e：`queue.spec.ts` 覆盖 US1 四个场景（追加入队、第二条序号 2、空闲不入队、
  含图片条目带图片标记）— 验证：用例通过

**Checkpoint**: US1 可交付——用户第一次能看见自己排了什么。

---

## Phase 3: US2 — 按序执行与镜像对齐（P1）

**Goal**: pi 自己按序执行，插件只保证显示与真源一致；漂移可见。**不实现调度器。**

- [ ] **T010** [US2] `PiMessageQueue` 接收 `queue_update`：按文本逐条对齐镜像（相等则保留 id 与图片，
  不等则按 pi 重建），并推送 `queue_state` — 验证：单测断言外部改写队列后 mirrors 跟随且 drift 置位
- [ ] **T011** [US2] `QueueBar` 顶部漂移提示：「队列已被外部修改，已按 pi 重建」+ 关闭按钮 —
  验证：`?queuedrift=1` 下断言提示可见
- [ ] **T012** [US2] e2e：连续两条追加 → 第一条被 pi 消费后队列只剩 1 条且序号重排为 1；
  断言插件**没有**额外发起 `prompt`（mock 记录命令序列）— 验证：用例通过，命令序列里无重复 prompt

**Checkpoint**: US2 可交付——顺序正确性由 pi 保证，插件只负责不撒谎。

---

## Phase 4: US3 — 回退到编辑（P1）

- [ ] **T013** [US3] `queue.restore`：`clear_queue` 取出 → 从镜像定位该条 → 其余按原序重新入队 →
  返回该条的 text + images — 验证：单测断言「取出后队列少一条、其余顺序不变、返回值含图片」
- [ ] **T014** [US3] `Composer` 接收回填：草稿为空直接填入（文本 + 图片 chip）；
  草稿非空则追加并在两者之间插空行（与 005-copy-actions 的 quote 一致）— 验证：Playwright 断言两种草稿状态下的结果
- [ ] **T015** [US3] e2e：含图片条目点「编辑」→ 队列少一条、composer 出现原文与图片 chip、
  可再次发送；队列只剩 1 条时取回 → 队列条收起 — 验证：用例通过

**Checkpoint**: US3 可交付。

---

## Phase 5: US4 — 排序与删除（P2）

- [ ] **T016** [US4] `queue.move`：相邻交换并重新入队；首条上移 / 末条下移返回
  `ok:false, error:"at edge"` 且**不改动 pi 队列** — 验证：单测断言边界调用没有触发 `clear_queue`
- [ ] **T017** [US4] `queue.remove` + `QueueBar` 的 inline 二次确认（点删除 → 该行变「确认删除 / 取消」，
  2.5s 自动还原）— 验证：Playwright 断言首点不删除、再点才删除、超时后按钮还原
- [ ] **T018** [US4] e2e：3 条队列上移第 2 条 → 顺序交换且序号刷新；首条上移按钮禁用；
  删除后剩余序号重排 — 验证：用例通过

**Checkpoint**: US4 可交付。

---

## Phase 6: US5 — 插话（P2）

- [ ] **T019** [US5] `queue.enqueue(mode=steer)`：调 `steer` RPC（原生支持 images），
  成功后条目留在镜像并进入 `steering` 段；失败则条目回原位、`status:"failed"` 带原始错误 —
  验证：单测断言失败时条目仍在镜像且带 error 文本（不静默丢失）
- [ ] **T020** [US5] fire 后立刻插入 `ephemeral: true` 的 user item（带「插话」标记）；
  `replayMessages` 时丢弃所有 ephemeral 项 — 验证：单测断言 replay 后 ephemeral 项不再存在
- [ ] **T021** [US5] e2e：流式中点插话 → 消息流出现带「插话」标记的用户消息、`queue_update.steering`
  逐条减少；空闲时插话退化为直发、不入队；`?queuefail=steer` 时条目标红并显示原始错误 —
  验证：用例通过

**Checkpoint**: US5 可交付。

---

## Phase 7: US6 — 追加提升为插话（P2）

- [ ] **T022** [US6] `queue.promote`：重建时该条走 `steer`、其余保持 `follow_up`，位置与其余顺序不变 —
  验证：单测断言重新入队的命令序列为「steer 目标条 → follow_up 其余（原序）」
- [ ] **T023** [US6] e2e：3 条追加中提升第 2 条 → 它离开追加段、第 1、3 条保持原序 —
  验证：用例通过

**Checkpoint**: US6 可交付。

---

## Phase 8: US7 — 暂停与恢复（P3）

- [ ] **T024** [US7] `queue.pause` / `queue.resume`：暂停 = `clear_queue` 取出并留在镜像
  （pi 侧真的空了）；恢复 = 按原序重新入队。**不用 abort 的行为做判定** —
  验证：单测断言暂停后 pi 收到的队列为空、恢复后顺序与原镜像一致
- [ ] **T025** [US7] abort 与 pi 进程重启 → 自动调用 pause 并置 `pauseReason`；
  `QueueBar` 显示横幅与「继续 / 清空」— 验证：e2e 断言 abort 后无新 prompt 发出、横幅可见
- [ ] **T026** [US7] 切换 / 新建会话前若队列非空 → 确认框列出将被丢弃的条数；取消则不清空 —
  验证：Playwright 断言取消后队列条数目不变
- [ ] **T027** [US7] `queue.get`：webview 重载后从 Kotlin 恢复条目、顺序与暂停态 —
  验证：e2e 重载页面后断言队列条内容与重载前一致

**Checkpoint**: US7 可交付。

---

## Phase 9: Polish

- [ ] **T028** [P] `layout-regressions.spec.ts` 新增队列条几何：360 / 680 / 900px × 有/无队列，
  条目 rect ⊆ 队列条、`.message-list` 无横向溢出、队列条底边在 composer 顶边之上 —
  验证：断言通过
- [ ] **T029** [P] 全量回归：`npm test` + `npx playwright test` + `./gradlew test`，
  既有 87 条 e2e 与 Kotlin 单测不得回归 — 验证：三条命令全绿
- [ ] **T030** CHANGELOG「未发布」段补队列能力（新增），说明「执行顺序由 pi 负责、
  暂停期间消息不会自动补发」 — 验证：人工核对条目与实现一致
- [ ] **T031** `MANUAL_TEST.md` 新增「消息队列」段：真机验证 `queue_update` 真的会到、
  插话注入时机、pi 重启后队列状态 — 验证：人工打勾

## 依赖关系

```
T001 ─┬─ T006..T009 (US1)
      ├─ T010..T012 (US2)  ← 需 T004 镜像骨架
      ├─ T013..T015 (US3)
      ├─ T016..T018 (US4)
      ├─ T019..T021 (US5)
      ├─ T022..T023 (US6)
      └─ T024..T027 (US7)
US3/US4/US6 ──→ 共用「取出 → 重建 → 入队」原语，建议一并实现
```

US1 是其余故事的前提（没有队列条就无处操作）；US2 与 US1 同批可交付。

## 总计

31 个 task：Foundational 5 + US1 4 + US2 3 + US3 3 + US4 3 + US5 3 + US6 2 + US7 4 + Polish 4。

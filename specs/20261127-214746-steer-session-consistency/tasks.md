# 任务清单：插话在队列与会话之间的一致性

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **编号**: `20261127-214746` · **Issue**: #8

## T1 状态字段（先断言）

- [x] T1.1 `web/src/store/types.ts`：`ChatItem.steerState?: "queued" | "injected"`
      —— 跨端契约：Kotlin 侧若涉及同步，同一次改动里改
- [x] T1.2 fire 时置 `"queued"` —— 验证：vitest 断言 fire 后状态
- [x] T1.3 队列镜像里该文本消失 → 置 `"injected"` —— 验证：vitest 断言

## T2 取回即撤回（FR-001/FR-002）

- [x] T2.1 `queueRestore` 成功后从 `items` 里移除对应的 queued 插话条目
      —— 验证：vitest 断言会话里那条消失
- [x] T2.2 只撤「排队中」的，已注入的不撤 —— 验证：vitest 断言（FR-004）
- [x] T2.3 取回后编辑并发送 → 会话里该文本只出现一次 —— 验证：vitest 断言（FR-002）
- [x] T2.4 撤回幂等：replay 已丢弃该条目时不得报错 —— 验证：vitest 断言

## T3 状态可见（FR-003）

- [x] T3.1 `MessageList.tsx`：`steer-tag` 按状态渲染不同文案
- [x] T3.2 i18n 中英各两个键（`chat.steerTagQueued` / `chat.steerTagInjected`）
- [x] T3.3 漂移态下已注入条目的取回按钮禁用并说明原因 —— 验证：vitest + 目视
      —— 实现方式不同：已注入的条目**已经不在队列里**（pi 消费掉了），没有按钮可禁用；拒绝体现在
      「保留会话里那条 + 给一句人话说明」（`queue.restore.injected`）

## T4 真机验收

- [x] T4.1 插话 fire → 消息流带「排队中」，队列里也有
- [x] T4.2 pi 注入后 → 标记变「已生效」，队列里那条消失
- [x] T4.3 未注入时在队列点 ✎ → 消息流里那条消失
- [x] T4.4 编辑后发送 → 会话里只有一条

## T5 收尾

- [x] T5.1 `changelog.d/` 碎片（正好两行）
- [x] T5.2 `cd web && npm test` 全绿 + `npm run typecheck` 无错 + `./gradlew build` 全绿
- [x] T5.3 提交

## 实现记录（2026-11-28）

- **提交**：`5d37631`（前端半边）+ `e57b5f9`（复查修的连带误删）；issue #8 已关闭。
- **核心判据**：镜像（Kotlin 维护的 queue 镜像）分不出「pi 消费了」「用户删了」「用户取回了」
  三种消失原因 —— **只有前端知道自己干过哪一个**。所以前端把自己造成的撤回登记在
  `withdrawnSteerTexts` 里：文本从镜像消失且不在该集合里，才判为「已被 pi 注入」。
- **取回**：排队的插话撤掉会话里那份；已注入的**留着**（pi 上下文里已经有了，撤不掉），
  并给一句人话说明（`queue.restore.injected`），不甩错误码。
- **状态可见**：消息流里插话标记区分「插话（排队中）」/「插话（已生效）」，老会话缺字段时回退旧标记。
- **复查修的两处**：
  1. 取回一条插话时只撤**它自己那一条**（此前会把一字不差的另一条也一起抹掉 —— 两条同文案的
     插话在用户眼里分不出来，但只有删掉恰好一条是对的）；
  2. `withdrawnSteerTexts` 在同文插话重新 fire 时清掉对应标记，避免旧标记遮住新条目。
- **测试**：store 单测 `store.issue8.test.ts` 10 例 + e2e `issue8-steer-consistency.spec.ts` 6 例。
  RED 验证：同文案那例在「删掉全部」的旧写法下变红（`expected [] to have a length of 1`）。
- **真机**：fire → 标记「插话（排队中）」+ 队列同文；点 ✎ → 会话里那条消失、文本回输入框；
  已注入的那条留在会话里。连发两条一字不差的插话，取回一条后另一条仍在（会话 2→1、队列 2→1）。

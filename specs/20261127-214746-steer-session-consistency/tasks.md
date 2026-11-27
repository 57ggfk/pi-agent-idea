# 任务清单：插话在队列与会话之间的一致性

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **编号**: `20261127-214746` · **Issue**: #8

## T1 状态字段（先断言）

- [ ] T1.1 `web/src/store/types.ts`：`ChatItem.steerState?: "queued" | "injected"`
      —— 跨端契约：Kotlin 侧若涉及同步，同一次改动里改
- [ ] T1.2 fire 时置 `"queued"` —— 验证：vitest 断言 fire 后状态
- [ ] T1.3 队列镜像里该文本消失 → 置 `"injected"` —— 验证：vitest 断言

## T2 取回即撤回（FR-001/FR-002）

- [ ] T2.1 `queueRestore` 成功后从 `items` 里移除对应的 queued 插话条目
      —— 验证：vitest 断言会话里那条消失
- [ ] T2.2 只撤「排队中」的，已注入的不撤 —— 验证：vitest 断言（FR-004）
- [ ] T2.3 取回后编辑并发送 → 会话里该文本只出现一次 —— 验证：vitest 断言（FR-002）
- [ ] T2.4 撤回幂等：replay 已丢弃该条目时不得报错 —— 验证：vitest 断言

## T3 状态可见（FR-003）

- [ ] T3.1 `MessageList.tsx`：`steer-tag` 按状态渲染不同文案
- [ ] T3.2 i18n 中英各两个键（`chat.steerTagQueued` / `chat.steerTagInjected`）
- [ ] T3.3 漂移态下已注入条目的取回按钮禁用并说明原因 —— 验证：vitest + 目视

## T4 真机验收

- [ ] T4.1 插话 fire → 消息流带「排队中」，队列里也有
- [ ] T4.2 pi 注入后 → 标记变「已生效」，队列里那条消失
- [ ] T4.3 未注入时在队列点 ✎ → 消息流里那条消失
- [ ] T4.4 编辑后发送 → 会话里只有一条

## T5 收尾

- [ ] T5.1 `changelog.d/` 碎片（正好两行）
- [ ] T5.2 `cd web && npm test` 全绿 + `npm run typecheck` 无错 + `./gradlew build` 全绿
- [ ] T5.3 提交

# Implementation Plan: 023 Fork 以「整轮」为单位

**Spec**: [spec.md](./spec.md)　**Branch**: `release/0.5.7`　**Created**: 2026-11-10

## 1. Technical Context

| 项 | 内容 |
|---|---|
| 语言/框架 | TypeScript + React（web 侧）；Kotlin 侧零改动 |
| 存储 | 无（纯内存判据；不涉及 localStorage / Preferences） |
| 测试 | `npx vitest run`（纯函数与判据）、`npx playwright test`（真前端 + mock bridge）、`npm run typecheck` |
| 平台 | JCEF / 浏览器双跑；判定与平台无关 |
| 性能目标 | 每轮扫描 O(n)，与消息数同阶；不进渲染热路径以外的地方 |
| 约束 | 不改 pi 协议、不改 `get_fork_messages` / `fork` / `clone` 调用序列、不新增 i18n key |
| 规模 | 3 个源文件 + 1 个测试文件 + 4 个 e2e 文件 |

## 2. Constitution Check

| 条款 | 判定 |
|---|---|
| I. 规格先行 | ✅ spec（What/Why/验收）与本 plan 分离；技术选型只出现在本文 |
| II. 无断言不算完成 | ✅ 每条 task 带验证；判据变更必须有单测，e2e 必须定位到具体那一条回复 |
| III. 不留双源 | ✅ 「哪条回复能 Fork」只由 `actionsForItem` 决定；`MessageActions` 不做二次判断（沿用 007 的矩阵单点原则） |
| IV. 遵守 pi 协议事实 | ✅ 直接引用 `specs/007-message-fork/fork-semantics.json`（fork 以用户 entry 为切点） |
| V. 向后兼容 | ✅ 不改确认框文案、不改 `clone` 退化条件；仅收窄 UI 入口 |

无违反项，Complexity Tracking 不适用。

## 3. 确切代码定位（改动前）

| 位置 | 现状 | 与本次的关系 |
|---|---|---|
| `web/src/store/types.ts:616-630` | `ActionContext`：`isLastUser` / `isLastAssistant` / `hasPrecedingUser` / `sessionBusy` / `editing` | **加一个 `isRoundEnd`** |
| `web/src/store/types.ts:698-726` | `actionsForItem()`，`:707` `const canFork = item.role === "assistant" && idle && ctx.hasPrecedingUser` | Fork 判据在此，单点改造 |
| `web/src/components/MessageList.tsx:153-159` | 一次遍历算 `lastUser` / `lastAssistant` | 同处再算出「本轮末尾」数组 |
| `web/src/components/MessageList.tsx:161-166` | `userAbove: boolean[]`（前缀扫描） | 同风格，新增 `roundEnd: boolean[]` |
| `web/src/components/MessageList.tsx:187-195` | `<ItemView actions={actionsForItem(item, {...})}/>` | 把 `isRoundEnd` 传进去 |
| `web/src/store/store.ts:134-141` | `userCountUpTo()` 统计用户条目 | 不变（分支点算法正确） |
| `web/src/store/store.ts:143-151` | `branchTargetFor()`：`userCount < forkableCount ? entry : clone` | 不变 |
| `web/src/store/store.ts:758-815` | `runForkAtItem()`：按点击项算分支点 | **先把索引规范化到本轮末尾** |
| `web/src/store/store.ts:1924-1948` | `forkAtItem()`：算 `isLast` 选 `.last` / `.middle` 文案 | 用规范化后的项算 `isLast` |
| `web/src/components/MessageActions.tsx:77` | `forkAtItem(item.id)` | 不变（不做二次过滤） |
| `web/src/i18n/locales/{zh,en}.ts` `confirm.forkAt.*` | `.last` / `.middle` 两套文案 | **不改**。改动后 `.middle` 的「其后的内容不会带入」才第一次成为真话 |

## 4. 决策

### D1 判据落在动作矩阵，不落在组件

`canFork = role === "assistant" && idle && ctx.hasPrecedingUser && ctx.isRoundEnd`。
`MessageActions` 继续只负责「长什么样、点了做什么」，禁止在组件里加 `if` —— 否则又出现第二个真相源（007 明确反对）。

### D2 `isRoundEnd` 的算法（纯函数，可单测）

在 `MessageList` 里与 `lastUser` / `lastAssistant` 同一次前缀扫描完成，保持一次遍历：

```ts
// 一轮的末尾 = 该轮最后一条 assistant；遇到下一条 user 就结算上一轮
const roundEnd: boolean[] = items.map(() => false);
let pending = -1;                       // 本轮最后一条 assistant 的下标
for (let i = 0; i < items.length; i++) {
  const role = items[i].role;
  if (role === "user") {
    if (pending >= 0) roundEnd[pending] = true;
    pending = -1;                       // 新的一轮开始
  } else if (role === "assistant") {
    pending = i;
  }                                   // system 消息不结算轮次：错误提示不该顶掉 Fork
}
if (pending >= 0) roundEnd[pending] = true;   // 末轮没有后继提问
```

要点：

- **system 消息不重置** —— 否则「重试提示」「上下文压缩通知」插在末尾会把该轮 Fork 挤掉（spec US1 场景 4）。
- **临时插话（ephemeral steer）条目算作用户消息** —— 它在 pi 侧就是一个真实 user entry，界面上也渲染成用户气泡，切轮次是对的。
- 复杂度和 `userAbove` 同阶，`items` 变化时随组件一起重算，无需 memo（与现有写法一致）。

### D3 store 侧规范化：结构性保证「整轮」

`forkAtItem(itemId)` 与 `runForkAtItem(itemId)` 都先把点击到的下标推到**本轮末尾**：

```ts
/** The last assistant item of the round that `index` belongs to. */
export function roundEndIndex(items: ChatItem[], index: number): number {
  let end = items[index]?.role === "assistant" ? index : -1;
  for (let i = index + 1; i < items.length; i++) {
    if (items[i].role === "user") break;
    if (items[i].role === "assistant") end = i;
  }
  return end;
}
```

规范化后：

- 分支点仍用 `userCountUpTo(items, end)` 计算 —— 与点击末尾那条完全一致，因此 spec US2 场景 2（两条入口结果一致）自动成立；
- `isLast`（选 `.last` / `.middle` 文案）也用 `end` 判定 —— 否则从中间那条触发会显示「其后的内容不会带入」却走 clone，等于把刚修好的错位又造一遍；
- 若 `end === -1`（点到的不是 assistant），沿用现有 `error.fork.notReply`。

**为什么不在 store 里直接报错拒绝**：拒绝要新增文案与失败路径，而「推到本轮末尾」本身就是用户要的语义，
且对将来任何新入口都自动正确。UI 隐藏是第一道，这个是第二道。

### D4 分支点算法与协议调用一律不动

`forkEntries` / `branchTargetFor` / `fork` / `clone` 的调用序列保持原样。
本次只改「允许点哪里」和「点了算哪一条」，**不碰协议**。这样 `fork-semantics.json` 的结论继续有效，回归面最小。

### D5 中间回复「完全不渲染」

`actionsForItem` 不产出 `"fork"`，不是产出后再禁用。因此：

- 工具条仍会渲染（复制/引用在），不出现空壳；
- 纯图片的中间回复本来就 `actions = []`（无文字可复制），工具条整条不渲染 —— 与现状一致，不需要额外处理（spec US3 场景 2）。

### D6 文案不动

`confirm.forkAt.middle`「新会话将以这条回复结尾，其后的内容不会带入」在改动后才对所有可点位置成立；
`confirm.forkAt.last`「之前的完整对话都会复制过去」本来就描述 clone，仍然成立。
用户明确「不管怎么复制，反正就是 fork 功能」，所以不改标题、不改按钮名（spec US4）。

### D7 测试必须指向具体那一条，不许放宽

现有 e2e 里有多处以 `item-assistant` 的 `.first()` 或 `nth(0)` 取 Fork —— 那些位置在 mock 下都是**本轮中间那条**
（mock 一次提问固定 2 条 pi 回复），改动后会直接失败。必须改成「本轮末尾」，不许改成 `toHaveCount(1)` 之类的模糊断言。

## 5. 场景剧本（供 e2e / 手工验收）

| # | 造数据 | 动作 | 期望 |
|---|---|---|---|
| A | 单轮：1 提问 → mock 2 条回复（A1 工具调用 / A2 总结） | 依次悬停 A1、A2 | A1 无 Fork（有复制+引用）；A2 有 Fork；总入口数 1 |
| B | 两轮：q1、q2 各 2 条回复 | 数 Fork 入口 | 恰好 2 个：第 1 轮最后一条、第 2 轮最后一条 |
| C | 同 A，程序以 A1 触发 Fork（不经 UI 的测试钩子或直接调 store） | 与以 A2 触发对比 | 两次新会话逐条一致；同轮 A1 之后的回复未被截掉 |
| D | 单轮，点末尾 A2 Fork | 确认 | 新会话 = 旧会话逐条一致（clone），旧会话不变，文案含「whole conversation」 |
| E | 两轮，点第 1 轮末尾 Fork | 确认 | 新会话止于该轮末尾；第 2 轮全部不带入；文案为 `.middle` 那套 |
| F | 会话忙（流式中） | 悬停任意 pi 回复 | 无 Fork（007 FR-002 不回归） |
| G | 末尾追加一条系统错误消息 | 悬停该轮最后一条 pi 回复 | 仍有 Fork（system 不结算轮次） |

## 6. 触及文件

| 文件 | 改动 |
|---|---|
| `web/src/store/types.ts` | `ActionContext` 加 `isRoundEnd`；`actionsForItem` 的 `canFork` 加该条件 |
| `web/src/components/MessageList.tsx` | 前缀扫描算 `roundEnd[]`；调用处传 `isRoundEnd` |
| `web/src/store/store.ts` | 新增 `roundEndIndex()`；`forkAtItem` / `runForkAtItem` 先规范化下标，`isLast` 用规范化后的项 |
| `web/src/store/types.test.ts` | `IDLE` 加 `isRoundEnd: true`；改 1 条用例语义 + 新增「同轮中间回复无 Fork」 |
| `web/src/store/store.test.ts` | 新增 `roundEndIndex` 单测（首条/中间/末条/无 assistant/尾随 system） |
| `web/e2e/message-fork.spec.ts` | `forkAt()` 改取本轮末尾；新增 US1/US2 场景 A–C、G |
| `web/e2e/confirm.spec.ts:172` | `.first()` → 本轮末尾（该用例只为验证不弹原生框） |
| `web/e2e/sessions.spec.ts:52` | 同上 |
| `web/e2e/session-search.spec.ts:134` | 同上 |

## 7. 阶段与顺序

1. **S1 判据**：`types.ts` 加字段与条件 + 单测（纯函数层，先红后绿）。
2. **S2 组件**：`MessageList` 算 `roundEnd[]` 并传参 —— 此时 UI 行为已符合 spec，e2e 开始大面积失败（预期）。
3. **S3 store 规范化**：`roundEndIndex` + 两处调用点；补 store 单测。
4. **S4 测试同步**：4 个 e2e 文件的定位改到本轮末尾；补 A–C、G 场景。
5. **S5 收尾**：`npm run typecheck` → `npx vitest run` → `npx playwright test`；run report 记录实际入口数。

**与其它规格的顺序**：020 → 021 → 022 → **023**。
023 与 022 都改 `MessageList.tsx`（022 改吸底判定与 `ItemView` memo），022 的结构改动更大，先落 022 再落 023 冲突最小。

## 8. 风险与降级

| 风险 | 影响 | 处置 |
|---|---|---|
| 用户其实想要「每条回复都能点，只是文案说清整轮」 | 入口变少，被当成功能倒退 | 用户已明确「完全不渲染」；若要反过来，只需把 `canFork` 里的 `isRoundEnd` 去掉（一行），文案已在 spec 里备好 |
| 插话（steer）导致用户条目数与 pi 的 entry 数错位 | 岔到相邻轮次或提前退化为 clone | 现存风险，本 spec 不扩大范围；S4 里加一条「插话后 Fork」的探针用例记录实际行为，确有问题是另立项的依据（spec「待确认」已写） |
| e2e 改动面比预期大 | 交付时间 | 4 个文件都是「把定位换成本轮末尾」，不涉及断言逻辑；`forkAt()` 已有 helper，改一处即可 |
| 「本轮末尾」判定与真实 pi 的 `turn_end` 不一致 | 极端会话形状下 Fork 位置略偏 | 纯 UI 判定基于与分支点同源的「用户消息边界」，两者天然一致；不做 `turn_end` 依赖（重放时拿不到事件） |

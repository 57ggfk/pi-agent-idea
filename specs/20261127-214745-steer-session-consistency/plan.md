# 技术方案：插话在队列与会话之间的一致性

**Spec**: [spec.md](./spec.md) · **编号**: `20261127-214745` · **Issue**: #8

## 落点

- 分支：`release/0.5.11`（工作树 `D:\code\github\pi-agent-idea-wt\release-0.5.11`，
  远端 `origin/release/0.5.11`，HEAD `7fa419f`）

## 一、根因（读代码得到）

### 1.1 同一条插话在两处

fire 时（`web/src/store/store.ts` 的 `sendImages`）：

```ts
if (queueMode === "steer") {
  // Fire-and-trace：立刻渲染，pi 记下真实消息后由下一次 replay 丢弃这条
  const item = emptyItem("user", [{ kind: "text", text, done: true }, ...]);
  item.done = true;
  item.ephemeral = true;      // ← 会话里的临时条目
  item.steer = true;         // ← 渲染「插话」标记
  set({ items: [...get().items, item] });
}
```

同时 `queue.enqueue` 让它留在队列里（QueueBar 一行，带 id / 图片 / 模式）。

### 1.2 取回不动会话

`web/src/store/store.ts` 的 `queueRestore`：

```ts
const res = await bridge.request<{ ok: boolean; text?: string; images?: QueueImage[] }>(
  "queue.restore", { id });
...
set({
  pendingPrompt: { text: res.text ?? "", id: ++promptSeq, mode: "restore", images: res.images ?? [] },
});
```

**只动了 `pendingPrompt`（输入框），没有碰 `items`（会话）** → 会话里那条 ephemeral
item 带着旧文本继续留着。用户编辑完发送 → 新消息进会话 → 两条并存（FR-002 的成因）。

### 1.3 状态不可见

`web/src/components/MessageList.tsx`：

```tsx
{item.steer ? (
  <div className="steer-tag" data-testid="steer-tag">
    {t("chat.steerTag")}      // ← 只有一个标记，不区分「排队中 / 已注入」
  </div>
) : null}
```

而「是否已被 pi 注入」这个事实，**插件是知道的**：pi 的 `queue_update` 持续推送
steering 数组，文本从数组里消失 = 已被消费（spec 005 实测基线 1）。插件的镜像里
这条还带着 id 和 status。

### 1.4 撤回为什么不能一刀切

| 时刻 | 会话里那条是什么 | 能不能撤 |
|---|---|---|
| fire 后、注入前 | 插件造的 ephemeral item（pi 还不认识） | **能撤** —— 它只是本地反馈 |
| 注入后（replay 后） | pi 记的真实 user message | **撤不掉** —— pi 上下文里已经有了 |

所以 FR-001 与 FR-004 必须按状态分别处理。

## 二、方案

### 2.1 给插话条目加状态

`ChatItem` 增加一个字段（`web/src/store/types.ts`）：

```ts
/** 插话条目的注入状态：还在 pi 队列里（可撤回）/ 已被 pi 消费（不可撤回）。 */
steerState?: "queued" | "injected";
```

- fire 时：`steerState = "queued"`
- 镜像里这条被 `queue_update` 对齐掉（文本从 steering 数组消失）→ 前端把对应
  ephemeral item 标成 `"injected"`

**判定依据**：队列镜像（`queue.items`）里还有没有这条文本。有 → 还在排队；
没有 → 已注入。

### 2.2 取回即撤回（FR-001）

`queueRestore` 成功后，**从会话里移除对应的 ephemeral item**：

```ts
set({
  pendingPrompt: { ... },
  items: get().items.filter((i) => !(i.steer && i.steerState === "queued" && i.text === res.text)),
});
```

匹配条件三个都要：带 steer 标记、状态是「排队中」、文本相同。**只撤「排队中」的**——
已注入的那条是真消息，撤不掉（FR-004）。

### 2.3 已注入时的取回（FR-004）

在队列里点 ✎ 时，若该条目已经是「已注入」，按钮应当**禁用**或给出明确提示，
而不是让用户取回一条已经生效的消息。

**取法**：QueueBar 的行数据来自 `queue.items`。已注入的条目**不在**队列里了
（被 `queue_update` 对齐掉了）→ **行自然消失**，用户点不到。
但如果镜像与 pi 漂移（`queue.drift`），可能仍显示 → 这时按钮禁用并说明原因。

### 2.4 状态可见（FR-003）

`MessageList.tsx` 的 `steer-tag` 按状态给不同文案 / 样式：

- `queued` → 「插话（排队中）」
- `injected` → 「插话（已生效）」

i18n：`chat.steerTag` 拆成 `chat.steerTagQueued` / `chat.steerTagInjected`（中英各一份）。

### 2.5 改动点

| 文件 | 改什么 |
|---|---|
| `web/src/store/types.ts` | `ChatItem.steerState` |
| `web/src/store/store.ts` | fire 时置 `"queued"`；队列对齐时把对应 item 置 `"injected"`；`queueRestore` 里撤回 |
| `web/src/components/MessageList.tsx` | 按状态渲染标记 |
| `web/src/i18n/locales/{zh,en}.ts` | 两个新键 |

**零 Kotlin 改动**：判定「是否已注入」用前端已有的队列镜像就够，
不需要 pi 之外的信源（Kotlin 侧的 `PiMessageQueue` 已经在推 `queue_state`）。

## 三、测试计划

先补断言（红）→ 再改实现（绿）。

**前端（vitest）**
- `store.test.ts`：
  - fire 一条插话 → 会话里有 `steerState === "queued"` 的条目
  - 队列镜像里该文本消失 → 该条目变 `"injected"`
  - `queueRestore` 一条 queued 的插话 → 会话里那条消失（FR-001）
  - `queueRestore` 一条 injected 的 → 不该被撤（FR-004）
  - 取回后发送 → 会话里该文本只出现一次（FR-002）
- 组件层：`steer-tag` 在两种状态下文案不同（用现有的 testid 断言）

## 四、真机验收

1. pi 跑着 → 发一条插话 → 消息流里带「排队中」标记，队列里也有它
2. 等 pi 注入 → 消息流标记变「已生效」，队列里那条消失
3. 再发一条插话（趁还没注入）→ 队列点 ✎ 取回 → **消息流里那条消失**
4. 编辑后发送 → 会话里只有一条（编辑后的），没有重复

## 五、风险

- **靠文本匹配撤回**：pi 的队列只有文本（没有 id），所以「同一条」只能靠文本认。
  用户改了文本 → 认不出对应关系 → 撤回失败（退化成今天的行为，不崩）。
- **replay 与撤回的竞态**：取回后若恰好 replay，临时条目已被丢弃 →
  撤回要幂等（filter 不到就当无事发生）。
- **漂移态**：镜像与 pi 不一致时（`queue.drift`），已注入的条目可能还在队列里显示 →
  取回按钮要禁用并说明，而不是让用户撤回一条已生效的消息。

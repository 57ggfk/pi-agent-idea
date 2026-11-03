# Implementation Plan: 插件镜像队列（排队 · 排序 · 取回 · 插话 · 暂停）

**Branch**: `005-message-queue` | **Date**: 2026-11-03 | **Spec**: [spec.md](./spec.md)

**Input**: `/specs/005-message-queue/spec.md`（2026-11-03 修订版：推翻「pi 不暴露队列」的初版前提）

## Summary

让队列在 IDE 里可见、可操作。核心结论来自实测：**pi 的队列本来就能读**——
`queue_update` 事件携带完整的 `steering` / `followUp` 文本数组，`clear_queue` 能全量取出。
初版规格「插件完全自持队列 + 自己按序 fire」的方案因此作废，改为：

**pi 是队列真源，插件维护带图片的镜像，并用 `clear_queue` + 重新入队实现本地操作。**

这样做的收益是砍掉整块最危险的代码：不再需要「`agent_settled` 后发下一条」的调度器，
也就没有 compaction / retry 时序门闩、fire 竞争、双重调度这些问题——那些由 pi 自己负责。

还剩三件只有插件能做的事：**图片**（pi 队列只存文本）、**顺序操作**（pi 无单条命令）、
**暂停**（abort 的行为文档与实测矛盾，不可依赖）。

## Technical Context

**Language/Version**: Kotlin（JDK 21 编译）、TypeScript 5 / React 18

**Primary Dependencies**: 现有 `PiRpcClient`（JSONL over stdin/stdout）、`BridgeService` 的项目级事件转发、
`web/src/store/store.ts` 的 zustand store

**Storage**: 仅内存。队列本体在 pi 进程，镜像与暂停态在 Kotlin project 服务；不落盘（见 spec Assumptions）

**Testing**: Kotlin JUnit（`src/test/kotlin`）、Vitest（`web/src/**/*.test.ts`）、Playwright + MockBridge（`web/e2e`）

**Target Platform**: IntelliJ 平台 233–263.*，JCEF webview

**Constraints**: 不引入新依赖；所有队列操作走既有 `POST /bridge`；一次重排必须原子（取出→重建→入队不可被打断）

**Scale/Scope**: 单人维护；队列典型长度 < 10 条

## Constitution Check

| 原则 | 落实方式 | 结论 |
|---|---|---|
| **I. 双端契约同步** | `QueueItem` / `queue_state` / `queue.*` 三处同批落地：`web/src/bridge/types.ts`、`BridgeService` 分发、`mock.ts` | PASS |
| **II. 断言含几何与行为** | 队列条在 composer 与消息流之间：360 / 680 / 900px 下不横向溢出、条目 rect ⊆ 容器、与 composer 间距稳定 | PASS（e2e 必测） |
| **III. 不依赖环境假设** | 不假设 pi 进程的工作目录、不假设模型可用（mock 驱动全部用例） | PASS |
| **IV. 写操作可回滚可解释** | 重排失败 → 队列以 pi 为准重建并提示；`clear_queue` 取出的内容先入镜像再重新入队，中断可恢复 | PASS |
| **V. JCEF 单向 / 走 bridge** | 新增 8 个 `queue.*` 方法走 `/bridge`，不做 JS 注入 | PASS |
| **VI. 凭据零托管** | 队列条目只有用户自己输入的文本与图片，无凭据 | PASS |

## 实测基线（决定架构的六条）

完整表格见 [spec.md](./spec.md#背景pi-队列的真实能力2026-11-03-实测修订初版断言)，此处只列影响实现的结论：

1. `queue_update` 是真实事件，两个字段是**完整队列**（非增量、非计数）。→ 不需要自己维护计数。
2. `clear_queue` 返回 `{steering, followUp}` 文本数组。→ 重排与暂停有了基础原语。
3. 无单条增删改 / 移动命令。→ 任何"改一条"都要全量取出再重建。
4. `queue_update` / `clear_queue` **只有文本**，没有图片、没有 id。→ 图片与 id 必须插件侧镜像。
5. `abort` 与队列的关系：文档说「continues queued messages」，实测 abort 后 6 秒内无新 turn。→ **不可依赖**，暂停用 `clear_queue` 显式实现。
6. `steer` / `follow_up` 的响应只有 `{disposition:"queued"}`，不是注入确认。→ UI 渲染发起的动作，不声称注入时刻。

## 数据模型与契约

### QueueItem（`web/src/store/types.ts` 为先，Kotlin 同名数据类对齐）

| 字段 | 说明 |
|---|---|
| `id` | 插件生成（`q-<n>`），pi 队列没有 id，靠它做镜像对齐 |
| `mode` | `steer`（插话）\| `followUp`（追加） |
| `text` | 原文 |
| `images` | base64 + mimeType，可为空。**只有插件有** |
| `status` | `queued` \| `failed`（+ `error` 原文） |
| `createdAt` | 用于稳定的次级排序 |

### 事件

`queue_state`（Kotlin → web，全量推送，每次变更一条）：

```json
{ "type": "queue_state", "items": [...], "paused": false, "pauseReason": null, "drift": false }
```

`drift: true` 表示镜像与 pi 队列对不上（有人在终端里改了队列），UI 显示一行提示并允许「以 pi 为准重建」。
条目数 < 10，全量推送比增量 diff 简单且不会漏更新。

### 命令（8 个）

| 命令 | 参数 | 语义 |
|---|---|---|
| `queue.get` | — | 返回镜像 + 暂停态（webview 重载后恢复用） |
| `queue.enqueue` | `mode, text, images` | 流式中入队。空闲时**不走这里**，由 web 直接 `prompt` |
| `queue.move` | `id, delta` | 上移 / 下移相邻；边界返回 `ok:false, error:"at edge"` |
| `queue.remove` | `id` | 删除一条 |
| `queue.restore` | `id` | 取出并返回条目内容（供 composer 回填），同时从 pi 队列移除 |
| `queue.promote` | `id` | 追加条目改为插话：重建时它走 `steer`，其余保持 `follow_up` |
| `queue.pause` / `queue.resume` | `reason?` | 暂停 = `clear_queue` 取出并留存；恢复 = 按序重新入队 |
| `queue.clear` | — | 清空（含暂停态） |

`queue.enqueue` 不负责判空闲：由 web 看 `isStreaming` 决定直发还是入队。少一处跨端状态判断，
少一种竞态（两边对"空闲"的判断不一致时会把消息塞进队列却不显示）。

## 关键技术决策

### 1. 不自持调度器

初版 plan（未落地）打算由插件在 `agent_settled` 后逐条发 `prompt`。实测证明 pi 自己就会按序执行
`follow_up` 队列，且已经在处理 compaction / retry 期间的推迟。自己再发一遍等于双重调度，
必然出现重复执行或漏执行。

**插件 MUST NOT 在 settled 后发起新一轮**（已写进 spec FR-005）。US2 的验收从"插件按序发出"
改为"队列条与 pi 队列一致、重排不造成重复或漏执行"。

### 2. 重排 = 取出 → 重建 → 入队（必须原子）

`clear_queue` 是唯一能改顺序的原语。一次重排三步：

```
clear_queue                       → 得到 {steering[], followUp[]}
按镜像顺序重建（扣掉/移动目标条）    → 本地计算，不碰 pi
逐条 steer / follow_up 重新入队    → 顺序由发送顺序保证
```

三条保护：

- **串行**：Kotlin 服务内用单线程执行器，两次重排不会交错。
- **先对齐再操作**：`clear_queue` 返回的文本与镜像逐条比对，不一致就丢弃镜像、以 pi 为准重排，
  并把 `drift` 置位（有人在终端里改了队列）。
- **取出的内容先入镜像再入队**：中途失败时队列不丢（宪法 IV），用户能看到并重试。

### 3. 图片靠镜像，对齐靠文本

`queue_update` 只有字符串，所以镜像条目带 `images`，与 pi 队列按**文本逐条相等**对齐：

- 条数与文本都相等 → 镜像可信，图片保留；
- 否则 → 以 pi 重建成无图条目，`drift: true`。

不做模糊匹配：文本相同的两条队列项无法区分，硬猜会把图片挂到错的条目上。

### 4. 暂停用 `clear_queue`，不用 abort

`abort` 与队列的关系文档和实测矛盾（见实测基线第 5 条）。暂停必须是确定性操作：
`clear_queue` 取出 → 留在镜像里 → pi 侧真的空了。恢复 = 按原序重新入队。

副作用要如实说：暂停期间 pi 侧确实没有待执行消息，所以「恢复」是重新排队，**已经错过的时间不会补**。

### 5. 插话 fire 后本地插入 ephemeral 消息

`steer` 的响应只代表入队。若等 transcript 回放，用户点了「插话」之后会有 1–2 秒没有任何反馈。
所以 fire 时立刻插入一条 `ephemeral: true` 的 user item（带「插话」标记），
在下一次 `replayMessages`（settled 后 / 切会话）时丢弃所有 ephemeral 项——以 pi 历史为准。

不这样做就会重复渲染：pi 会在下一轮把这条 steering 消息记为真正的 user 消息。

### 6. 删除的二次确认用 inline 两段式，不用 `window.confirm`

既有 `New session` / `Delete session` 用的是 `window.confirm`。队列条目不同：位置在输入框上方，
删除是高频轻操作，`window.confirm` 在 JCEF 里阻塞主线程、样式不可控，且自动化断言要拦截 dialog。

改为：点「删除」→ 该行按钮变成「确认删除 / 取消」，2.5 秒无操作自动还原。
同样是二次确认（spec US4-2 的实质要求），代价是与另外两处确认样式不一致——**这是有意的偏差**。

### 7. 收起 / 展开与几何

队列条固定在 `.composer` 上方、`.message-list` 下方，`max-height: 34vh` 超出滚动。
条目 `min-width: 0` + `text-overflow: ellipsis`，保证 360px 下不产生横向滚动
（宪法 II；`layout-regressions` 已有同款断言可复用）。

### 8. 预览与图片上限

预览截断 120 字符（spec Edge Case）。图片沿用 Composer 的既有上限（4 张/条），
不额外设队列总量上限——超量由用户删条目解决（spec Edge Case 明确）。

## 项目结构

```text
src/main/kotlin/dev/pi/agent/
├── queue/
│   └── PiMessageQueue.kt            # 新增：镜像、对齐、重排、暂停；单线程执行器
└── bridge/
    └── BridgeService.kt             # 注册 8 个 queue.*；转发 pi 事件时喂 queue_update

src/test/kotlin/dev/pi/agent/queue/
└── PiMessageQueueTest.kt            # 新增：对齐、重排、暂停、冲突

web/src/
├── store/
│   ├── types.ts                     # +QueueItem / queue_state / queue.* 命令（真源）
│   └── store.ts                     # queue_state 处理；删掉假 queue_update 计数
├── components/
│   ├── QueueBar.tsx                 # 新增：队列条（条目、排序、编辑、删除、插话、暂停横幅）
│   └── Composer.tsx                 # 流式中改走 queue.enqueue；与队列条的高度协同
└── bridge/
    ├── types.ts                     # +BridgeMethod 8 个
    └── mock.ts                      # queue_update 改为真实契约仿真；queue.* 实现

web/e2e/
└── queue.spec.ts                    # 新增：US1–US7 行为用例
web/e2e/layout-regressions.spec.ts   # +队列条几何（3 宽度 × 有/无队列）
```

## 分阶段实施

| 阶段 | 内容 | 可独立交付 |
|---|---|---|
| P1 契约 | `types.ts` / `BridgeService` 占位 / `mock.ts` / `PiMessageQueue` 骨架 + 单测 | 否（地基） |
| P2 US1 | 队列条渲染、入队、序号与预览 | 是：能看见排队 |
| P3 US2 | 与 pi 队列对齐、`drift` 提示（不实现调度） | 是 |
| P4 US3 | 取回编辑（文本 + 图片回 composer，草稿追加不覆盖） | 是 |
| P5 US4 | 上移 / 下移 / 删除（inline 二次确认） | 是 |
| P6 US5 | 插话 fire + ephemeral 消息 | 是 |
| P7 US6 | 追加提升为插话 | 是 |
| P8 US7 | 暂停 / 恢复 / 切会话确认 / webview 重载恢复 | 是 |
| P9 收尾 | 几何断言、全量回归、CHANGELOG、MANUAL_TEST | — |

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 重排期间 pi 消费了队列 | 重新入队后与用户预期不符 | 操作前记录 `isStreaming`；取出后比对本数与文本，不一致即中止并提示；串行执行避免自相竞争 |
| 终端里同时改了队列 | 镜像与 pi 漂移 | 每次 `queue_update` 重新对齐；漂移时 `drift: true` + 「以 pi 为准重建」 |
| 两条队列项文本相同 | 图片可能挂错 | 不猜：文本不一致即重建为无图条目并提示（同文案条目本就无法区分） |
| `steer` 入队后注入前被 abort | 条目既不在队列也不在 transcript | fire 后即在消息流留痕（ephemeral），replay 以 pi 为准；不复刻注入逻辑 |
| 队列条挤压消息区 | 小窗口读不到内容 | `max-height: 34vh` + 超出滚动；几何断言覆盖 360px |
| `clean_queue` 后重新入队触发新一轮 | 队列语义变成"立即执行" | 仅在流式中做重排；空闲时队列本就该执行，语义一致 |

## 与 spec 的偏差（实施时确认）

1. **US3-2「取回内容追加到草稿末尾」**：从队列取回的是用户自己的未发送文本，若 composer 已有草稿，
   追加会造成两条无关指令粘连。落实为：草稿为空则直接回填；草稿非空则**追加并插入一个换行**，
   与 005-copy-actions 的 quote 行为保持一致（同一 composer，两种行为会让人意外）。
2. **US5-2「见到轮次活动才 fire 下一条」**：由 pi 的 steeringMode 保证，插件不实现节流
   （重复实现会用错 pi 的注入时机）。UI 断言改为「多条插话在 `queue_update.steering` 中逐条减少」。
3. **FR-002 新增 `queue.get`**：spec 的 Key Entities 只列了 7 个命令，但 FR-001 要求 webview 重载后
   完整恢复，没有拉取命令就无法恢复。补第 8 个。

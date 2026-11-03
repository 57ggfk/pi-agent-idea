# Feature Specification: 插件自持消息队列（排队 · 排序 · 取回编辑 · 插话）

**Feature Branch**: `005-message-queue`

**Created**: 2026-11-03

**Status**: Draft

**Input**: 用户需求：「发送消息入队列，队列上面还可以做一些操作，比如说排序，回退到编辑，插话 steer」。
探索后决策：**队列由插件自持**，不依赖 pi 上游未暴露的队列 RPC（实测 pi 1.4.0 的 RPC 面
没有队列内容读写，见下）。

## 背景：pi 队列的真实能力（2026-11-03 实测，修订初版断言）

初版规格断言「pi 的 RPC 面只暴露入队与计数，无内容读取、无队列事件」，据此决定由插件**完全自持**队列。
**该断言经实测证伪**。本段记录实测结果与随之修订的方案。

实测方法：`pi --mode rpc --no-session`（1.4.0），依次发
`prompt` → `steer` → `follow_up` → `clear_queue`，读 stdout 的 JSONL；
另用一次 `abort` 观察队列是否继续执行。

| 能力 | 初版断言 | 实测结果 |
|---|---|---|
| 队列变化事件 | 不存在（全源码 grep 无 `queue_update`） | **存在**。`queue_update` 带 `steering` / `followUp` 两个**完整文本数组**，每次入队与消费都推送 |
| 队列内容读取 | 只有 `get_state.queuedMessageCount` | **可读**。`queue_update` 即内容 |
| 全量取出（Alt+Up） | RPC 下不可达 | **可达**。`clear_queue` 返回 `{steering, followUp}` 文本数组 |
| 单条增删 / 移动 | 无 | **确实无**。只能全量取出后重新入队 |
| 队列中的图片 | — | **取不回**。两个接口都只给字符串 |
| abort 与队列 | — | 文档称 “abort continues queued messages”，实测 abort 后 6 秒内**无**新 turn。**两者矛盾，行为不可依赖** |

（`docs/json.md` 的 “RPC mode emits the same session-event shapes” 说明了为什么源码里 grep 不到：
事件类型定义在会话事件层，不在 `rpc-types.ts` 的命令表里。）

**修订后的方案：pi 是队列真源，插件只做镜像与重排。**

- **显示与调度**：订阅 `queue_update`，由 pi 自己按序执行。插件**不再**驱动
  「`agent_settled` 后发下一条」——compaction / retry 的时序门闩与 fire 竞争正是最容易做错的部分，
  交给 pi 更准。
- **插件侧镜像**：条目要带 id、模式与**图片**（`queue_update` 没有图片），故 Kotlin 保留影子列表，
  作为「图片补全 + 顺序操作」的依据；文本与条数以 `queue_update` 为准，冲突时以 pi 为准。
- **排序 / 删除 / 单条取回**：`clear_queue` 取出 → 按影子顺序重建（扣掉目标条）→ 重新入队。
  这是唯一可行路径，代价是这一瞬间必须原子完成。
- **暂停（US7）**：`clear_queue` 取出并暂存到插件，pi 侧队列真的空了；恢复时按原序重新入队。
  不依赖 abort 的可疑行为。
- **插话（US5 / US6）**：`steer` RPC。响应 `{disposition:"queued"}` 只表示「已入队」，
  不表示已注入，因此 UI 渲染发起的动作，不声称注入时刻。
- 关键触发器 `agent_settled` 已端到端接通（pi → Kotlin `BridgeService` → web `store.ts`），
  暂停态与「空闲直发」判定仍复用它。


## User Scenarios & Testing *(mandatory)*

### User Story 1 - 排队即可见 (Priority: P1)

用户在 agent 流式输出时继续输入并发送。消息不丢失、不打断当前轮次，而是立刻出现在
输入框上方的队列条里：显示序号、模式标签（插话 / 追加）与内容预览。队列条随增删实时更新。

**Why this priority**: 现状是 mock 假事件导致真实环境只有一行永不更新的计数，连「发了没有」都不可知。
可见性是一切队列操作的前提，也是本规格唯一的「修复静默失效」项。

**Independent Test**: 流式期间连续发送两条消息 → 队列条出现两个条目、序号与预览正确；空闲时发送不入队（直接成为新一轮）。

**Acceptance Scenarios**:

1. **Given** agent 流式输出中，**When** 用户以「追加」模式发送文本，**Then** 输入框清空，
   队列条新增一个条目，显示「追加」标签、序号 1 与文本预览（超长截断）。
2. **Given** 队列已有 1 条，**When** 再发送一条，**Then** 新条目排在末尾，序号为 2。
3. **Given** agent 空闲（settled），**When** 用户以任何模式发送，**Then** 消息直接发送、成为新一轮，队列条不出现。
4. **Given** 消息含图片，**When** 用户在流式中发送，**Then** 条目入队且预览含图片标记，图片数据随条目保留。

---

### User Story 2 - 队列自动按序执行 (Priority: P1)

用户排了 3 条追加消息，然后去做别的事。agent 每结束一轮，下一条自动作为新一轮发出，
顺序与队列一致，直到队列清空。auto-compaction / auto-retry 进行中不打断、不提前发。

**Why this priority**: 「排队」的价值就是无人值守地依次执行；没有自动执行，队列只是便签。

**Independent Test**: 按序执行由 pi 保证（`follow_up` 语义），插件侧断言队列条与 pi 队列一致、
且重排操作既不造成重复执行也不漏执行。

**Acceptance Scenarios**:

1. **Given** 队列有 2 条追加，**When** 当前轮次 settled，**Then** 第 1 条作为新 prompt 发出；
   它再次 settled 后第 2 条发出，顺序与队列一致。
2. **Given** auto-compaction 或 auto-retry 进行中，**When** settled 类事件到达，**Then** 不 fire，等活动结束后再按序执行。
3. **Given** 队列等待 fire 且 agent 空闲，**When** 用户手动发送新消息，**Then** 手动消息优先执行，队列顺延到下一轮 settled。
4. **Given** 最后一条执行完毕，**When** 队列清空，**Then** 队列条收起，无空面板残留。

---

### User Story 3 - 回退到编辑 (Priority: P1)

用户排队后发现第 1 条写错了，想改。点击条目上的「编辑」，该条从队列移除、完整回到输入框
（文本 + 图片），改完再发。其余条目不受影响。

**Why this priority**: 「队列上做操作」的核心诉求之一。pi TUI 的 Alt+Up 全量取回依赖进程内
`clearQueue()`，RPC 下不可达；自持队列让逐条取回成为纯本地操作，且比 TUI 的全量合并更精细。

**Independent Test**: 队列含文本+图片条目 → 点编辑 → 队列少一条、composer 出现原文与图片 chip、可再次发送。

**Acceptance Scenarios**:

1. **Given** 队列有含图片的条目，**When** 用户点该条目的「编辑」，**Then** 条目从队列移除，文本与图片完整回到 composer。
2. **Given** composer 已有未发送草稿，**When** 用户执行取回，**Then** 取回内容追加到草稿末尾（换行分隔），不覆盖已有内容。
3. **Given** 队列只剩 1 条，**When** 取回，**Then** 队列条收起。

---

### User Story 4 - 排序与删除 (Priority: P2)

用户想让某条追加消息先执行，用上移/下移调整顺序；写废的条目直接删除。

**Why this priority**: 顺序决定执行次序，是「排序」诉求本体；删除是编辑的替代出口。
均为纯本地操作，但依赖 US1 的队列条先行。

**Independent Test**: 队列 3 条 → 上移第 2 条 → 顺序交换且序号刷新；删除需确认，确认后消失。

**Acceptance Scenarios**:

1. **Given** 队列 ≥ 2 条，**When** 点某条「上移」，**Then** 与前一条交换，序号即时刷新；首条无上移、末条无下移（按钮禁用）。
2. **Given** 任意条目，**When** 点「删除」，**Then** 弹二次确认（删除不可恢复）；确认后条目消失，剩余序号重排。
3. **Given** 队列执行中（上一条已 fire，下一条待发），**When** 用户重排剩余条目，**Then** 重排体现在后续执行顺序中，已发条目不受影响。

---

### User Story 5 - 插话 (Priority: P2)

用户看到 agent 正在跑偏，以「插话」模式发送（输入框直接发送，或对队列里已有的追加条目点
「插话」提升）。插件立刻调用 pi 的 steer 注入当前轮次；该条目以用户消息样式渲染进消息流并带
「插话」标记。多条插话逐条注入，注入前的剩余插话条目仍在队列里、仍可编辑。

**Why this priority**: 插话是唯一必须借 pi 的动作（注入运行中轮次），但排队与节奏自持。
默认逐条注入（对齐 pi steeringMode 默认 one-at-a-time 语义），保住「注入前还能编辑下一条」。

**Independent Test**: 流式中点插话 → 该条立刻以「插话」用户消息出现在消息流、从队列移除；
第二条插话在前一条见到轮次活动前保持可编辑。

**Acceptance Scenarios**:

1. **Given** agent 流式中，**When** 用户以「插话」发送文本，**Then** 插件立即调用 steer RPC，
   条目从队列移除，消息流出现带「插话」标记的用户消息（渲染的是 fire 动作，不声称注入时刻）。
2. **Given** 已有一条插话 fire 后未见任何轮次活动，**When** 用户查看队列，**Then** 后续插话条目仍在队列中可编辑；见到轮次活动后才逐条 fire。
3. **Given** agent 空闲，**When** 用户以「插话」发送，**Then** 退化为普通发送（steer 对空闲进程无意义），不入队。
4. **Given** steer RPC 调用失败，**When** fire 失败，**Then** 条目回到队列原位、标红并显示原始错误，不得静默丢失。

---

### User Story 6 - 追加提升为插话 (Priority: P2)

队列里排了 3 条追加，用户发现第 1 条其实想现在就插进去。点该条目的「插话」，它立即按 US5 的
方式 fire，其余条目顺序不变。

**Why this priority**: 排队时的意图会随运行情况变化；提升 = 本地改 mode + fire，成本极低，价值在灵活性。

**Independent Test**: 队列 3 条追加 → 提升第 2 条 → 它立刻 fire，第 1、3 条保持原序。

**Acceptance Scenarios**:

1. **Given** 流式中队列有 ≥1 条追加，**When** 点其「插话」按钮，**Then** 该条立即 fire（同 US5-1），其余条目顺序不变。
2. **Given** agent 空闲且队列处于等待态，**When** 点「插话」，**Then** 该条作为普通消息直接发送（空闲退化为直发）。

---

### User Story 7 - 中断后的暂挂与恢复 (Priority: P3)

用户 abort 了当前运行，或 pi 进程崩溃重启，或想切换会话。队列不被静默丢弃、也不被静默执行：
abort / pi 重启后队列保留并暂停，横幅说明原因，用户点「继续」恢复或「清空」放弃；
切换/新建会话前若队列非空，先确认。

**Why this priority**: 兜底安全性。静默丢弃（丢用户输入）与静默执行（打断新会话）都比暂停更伤信任；
但触发频率低于前面所有故事。

**Independent Test**: abort 后队列保持且无新 fire；点「继续」后恢复按序执行；pi 重启后队列条带「pi 已重启」横幅。

**Acceptance Scenarios**:

1. **Given** 队列非空，**When** 用户 abort，**Then** fire 暂停，队列条显示「运行已中断，队列暂挂」与「继续 / 清空」操作。
2. **Given** 暂挂中，**When** 用户点「继续」，**Then** 在下一次 settled 后恢复按序执行（agent 已空闲则立即发下一条）。
3. **Given** pi 进程重启，**When** 队列非空，**Then** 队列保留并暂停，显示「pi 已重启，队列暂挂」，不自动 fire。
4. **Given** 队列非空，**When** 用户切换/新建会话，**Then** 弹确认列出将丢弃的条数；确认后才清空。
5. **Given** webview 重载，**When** 页面重新就绪，**Then** 队列条从 Kotlin 侧完整恢复（条目、顺序、暂停状态）。

---

### Edge Cases

- **settled 时序**：pi 的 `agent_settled` 相对 auto-compaction / auto-retry 的先后需实测标定；
  门闩 MUST 同时检查 compaction/retry 活动事件，不得只依赖单一信号。
- **fire 竞争**：手动发送与队列 fire 在同一空闲窗口竞争时，手动优先，队列顺延（US2-3）。
- **已 fire 未注入**：插话 fire 与注入之间无确认事件；UI 不提供对已 fire 条目的编辑/撤回
  （pi 无 dequeue RPC；注入前剩余条目仍在插件队列可编辑，已覆盖主要诉求）。
- **与 pi 内部队列的双轨**：async job 结果、advisor 卡片仍走 pi 自身 followUp 队列，不经插件队列；
  队列条标注「插件队列」，transcript 是唯一真源。
- **空闲插话**：steer 对空闲进程无意义，一律退化为直接发送（US5-3）。
- **空文本 + 纯图片条目**：允许入队与 fire（RPC 原生支持 images）。
- **队列条目超长**：预览截断展示；完整内容仅在取回后可见。
- **图片内存**：条目图片以内存态保留直至 fire，不设上限；过多时由用户删除条目解决。
- **多窗口**：每个项目窗口独立队列（事件缓冲已按项目隔离），零串台。
- **IDE 关闭**：队列随进程结束丢弃（内存态），不落盘（见 Assumptions）。

## Requirements *(mandatory)*

### Functional Requirements

**架构与契约**

- **FR-001**: 队列内容 MUST 以 pi 为真源（`queue_update`）；Kotlin MUST 持有带 id、模式与图片的镜像
  以及暂停态（per-project 服务），webview 重载后 MUST 完整恢复；web 仅作为视图与命令发送方
  （宪法 V：通信走 HTTP bridge）。
- **FR-002**: 队列的类型与命令 MUST 先落 `web/src/store/types.ts`（QueueItem、queue_state 事件、
  queue.* 命令），Kotlin 数据类与 mock 在同一次变更内对齐（宪法 I）。
- **FR-003**: mock 的 `queue_update` MUST 改为真实契约的仿真（pi 确实发该事件，两个字段是完整队列，
  不是增量或计数）；`SendMode` 语义下沉为队列条目属性：空闲直发；流式中 steer→插话条目，
  followUp/auto→追加条目。
- **FR-004**: 队列条 UI MUST 位于 composer 与消息流之间，不引入横向滚动，条目 rect 落在容器内；
  验收断言按宪法 II（几何 + 行为）。

**入队与执行**

- **FR-005**: 追加条目的按序执行 MUST 由 pi 负责（`follow_up` 语义：一次一条、顺序 = 队列顺序）；
  插件 MUST NOT 在 `agent_settled` 后自行发起新一轮——双重调度正是重复执行的来源。
- **FR-006**: 空闲时发送 MUST 直接发送，任何模式都不入队。
- **FR-007**: 插话条目 MUST 逐条 fire；仅当上一条 fire 后观察到轮次活动（pi 事件流的 turn/message 事件）
  才 fire 下一条；fire 后条目立即从队列移除并带「插话」标记渲染进消息流。
- **FR-008**: fire 失败 MUST 将条目回到原位、标红并原样呈现错误（宪法 IV 精神：可解释、不谎报）。

**队列操作**

- **FR-009**: 用户 MUST 能对任意待执行条目执行：取回编辑（文本+图片完整回 composer，草稿非空时
  追加不覆盖）、上移/下移（相邻交换、边界禁用）、删除（二次确认）、提升为插话。
- **FR-010**: 重排 MUST 只影响未 fire 条目的后续执行顺序。

**中断与恢复**

- **FR-011**: abort 与 pi 进程重启 MUST 使队列进入暂停态：保留条目、停止 fire、显示原因与
  「继续 / 清空」操作；不自动恢复。
- **FR-012**: 切换 / 新建会话时若队列非空，MUST 先确认（列出条数）再清空。
- **FR-013**: 「继续」MUST 在下一次 settled 后恢复按序执行（agent 已空闲则立即发下一条）。

### Key Entities

- **队列条目（QueueItem）**：id、模式（插话 / 追加）、文本、图片（base64）、创建时间、
  状态（待执行 / 已插话 / 失败 + 原始错误）。
- **队列状态（queue_state 事件）**：有序条目列表、暂停标志、暂停原因（运行中断 / pi 重启）。
- **bridge 命令**：`queue.enqueue` / `queue.move` / `queue.remove` / `queue.restore` /
  `queue.promote` / `queue.resume` / `queue.clear`。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 真实 pi 环境中，队列条内容与实际排队完全一致（增删实时、多窗口零串台）——
  替代永不更新的假计数。
- **SC-002**: 追加条目的执行顺序与队列顺序 100% 一致（自动化断言发送序列）。
- **SC-003**: compaction / retry 活动期间 fire 次数为 0（自动化断言）。
- **SC-004**: 取回编辑 ≤ 2 步（点编辑 → composer 出现内容），文本与图片完整、原草稿保留。
- **SC-005**: abort / pi 重启后队列零丢失、零自动执行；「继续」后按序恢复。
- **SC-006**: webview 重载后队列条状态完整恢复。
- **SC-007**: 全部失败路径（fire 失败、命令失败）100% 在界面可见原始错误。
- **SC-008**: 队列条几何验收全绿（宪法 II：容器内、无横向滚动、与 composer 相对位置正确）。

## Assumptions

- 队列本体在 **pi 进程内存**里（`queue_update` 是真源），插件镜像与暂停态在 Kotlin 服务内存里：
  IDE 关闭 / pi 进程退出即丢，不落盘。跨 IDE 会话持久化属后续版本（若做，结构带版本号，宪法 I）。
- 插话的注入时机与节奏由 pi 保证（steeringMode 默认 one-at-a-time 语义）；插件不复刻注入逻辑，
  也**不改用户 pi 的全局 steeringMode 偏好**。
- pi 版本基准：本机 1.4.0（上游最新 18.16.0）。升级 pi 是独立事项，不阻塞本规格。
  若后续 pi 提供单条队列命令（move / remove / 带 id 的读取），`clear_queue` + 重新入队的重排路径
  可整体替换——契约收敛在 `queue.* 命令` 一层，UI 不动。
- 队列中的图片只能由插件镜像提供：pi 的 `queue_update` / `clear_queue` 都只回文本。
  因此镜像与 pi 队列的文本一致性 MUST 可校验，冲突时以 pi 为准并提示。
- 已排队的「插话」与「追加」条目均以用户身份发送；不实现系统级/匿部队列条目。

## Non-goals

- 不做拖拽排序（v1 用相邻上移/下移，几何断言更可靠）。
- 不做跨项目全局队列、定时/延迟发送、队列条目持久化到磁盘。
- 不实现「撤回已 fire 未注入的插话」（pi 无 dequeue RPC；注入前剩余条目仍在插件队列可编辑，
  已覆盖主要诉求）。
- 不管理 pi 自身队列中的 async job 结果与 advisor 卡片（不在「插件队列」范围内）。

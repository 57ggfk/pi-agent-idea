# Feature Specification: 状态面板——运行状态 / 后台任务 / 处理清单 / 待处理 / 产出

**Feature Branch**: `[20261128-092912-status-panel]`
**Created**: 2026-11-28
**Status**: Final（2026-11-28 定稿；D-1/D-2 与分区构成经用户四轮反馈拍板，D-3/D-4/D-5 为推荐值）

**GitHub Issue**: [#15](https://github.com/57ggfk/pi-agent-idea/issues/15)

**Input**: 用户需求——「新增状态面版，运行状态、任务、待处理、产出」。

## 背景

pi 的运行状态今天散在三处，且没有聚合视图：

- **运行状态**：StatusBar 一行摘要（pi 版本、上下文占用、成本、消息数），
  退出/横幅是兄弟节点；生成中的动静只有状态点。
- **任务**：插话/后续队列只有 chat 底部的 QueueBar——切到 sessions/manage
  tab 就看不见了。
- **待处理**：审批卡（ApprovalCard）埋在消息流里；pi 挂起等确认时，
  用户不一定知道卡在哪条上。
- **产出**：完全没有聚合——pi 改了哪些文件只能翻消息流里的工具卡。

调研底账（23 条 findings，`D:/code/research-20261128-status-panel/findings.md`）要点：

- 五分区的数据**全部已在 store 或事件流里**，v1 零新增 Kotlin 桥接（F-01/02/10/16/20）。
- pi core 没有 todo/后台任务概念（F-08/17）；任务语义由 pi-subagents（后台作业）
  与 todo 类工具调用快照承担（F-20/22）。
- **本机已装 pi-subagents@0.89.2**：后台子代理作业 + missions/schedules，
  宿主集成面明确（事件→读 status，250ms 合并）——后台作业展示进 v1（F-20/21）。
- 竞品教训：Cursor 评审列表的三病（不与 git 同步、提交后不清空、全会话编辑都算
  pending）；Claude Code 官方至今没有改动评审面板——做对就是差异化（F-13/14）。
- 竞品基准：Claude Code 有完整后台任务（Ctrl+B / run_in_background / 超时自动
  转后台，/tasks 面板，任务 ID 可轮询，F-24）；Cursor 处理清单三态（○ 未开始 /
  ◌ 进行中 / ✓ 已完成 / ⊗ 已取消，F-25）；持久任务面板在竞品都还是开放需求
  （CC #8723）——本插件的限宽弹层清单是差异化位。
- 扩展可经 `setStatus` 推状态条目，事件已透传前端、只是被 store 丢弃（F-09/16）。

## 用户场景与验收

### User Story 1 — 一眼看清 pi 在干嘛（Priority: P1）

打开面板，三秒内知道：pi 活着吗、在生成吗、用的什么模型、上下文还剩多少。
扩展推送的状态条目（`setStatus`）同区可见。

**为什么优先**：这是面板的地基——数据现成（F-01），且是其余分区的容器。

**独立可测**：打开面板看运行状态区；对流式/退出/扩展状态各自断言。

**验收场景**：
1. **Given** pi 运行中且空闲，**When** 打开面板，**Then** 显示「空闲」+ 模型名 + 上下文占用
2. **Given** 一轮回复正在流式生成，**When** 看面板，**Then** 状态在 2s 内变为「生成中」
3. **Given** pi 进程退出，**When** 看面板，**Then** 显示「已退出」与重启入口指引（跳转 StatusBar，不复制重启按钮）
4. **Given** 某扩展调用了 `setStatus`，**When** 面板打开，**Then** 状态条目按 statusKey 展示，清除后消失

### User Story 2 — 挂起时知道卡在哪（Priority: P1）

pi 等用户作答时，面板待处理区给出计数与列表；点击跳到消息流里对应的审批卡。

**验收场景**：
1. **Given** 一条 confirm 请求挂起，**When** 看面板，**Then** 待处理区显示「1 个待处理」并附标题摘要
2. **Given** 待处理 ≥1，**When** 点击条目，**Then** 切回聊天 tab 并滚动定位到对应 ApprovalCard
3. **Given** 用户在审批卡作答完毕，**When** 回看面板，**Then** 待处理计数归零
4. **Given** 挂起的是 input/select/editor 类，**When** 看列表，**Then** 类型可区分（图标或文案）

### User Story 3 — 处理清单一眼读到进度（Priority: P2）

agent 的待办清单在面板呈现为勾选列表：已完成打勾、未完成空圈、正在处理的
虚线圈且置顶高亮（对齐 Cursor 三态，F-25）。

**为什么 P2**：长任务「进行到哪一步」是竞品验证过的核心诉求——Claude Code 的
持久任务面板至今还是开放 issue（#8723），本插件做对即差异化。

**独立可测**：打开面板看处理清单分区，对三态各自断言。

**验收场景**：
1. **Given** 清单 5 项（2 完成、1 进行中、2 未开始），**When** 看面板，**Then** 三种状态图形可区分（✓ / ◌ / ○），进行中条目排最前
2. **Given** agent 更新了清单（某项完成），**When** 下一帧，**Then** 勾选状态随之更新
3. **Given** 会话没有任何 todo 类工具调用，**When** 看面板，**Then** 处理清单分区隐藏（不是空壳）

### User Story 4 — 会话产出一目了然（Priority: P2）

本会话 pi 的写操作（write/edit 类工具调用）按文件聚合；点击打开 diff 或文件。

**验收场景**：
1. **Given** pi 本会话用 write/edit 改了 3 个文件（其一改了两次），**When** 看面板，**Then** 产出区按路径去重显示 3 个文件并标注改动类型
2. **Given** 产出区某个文件，**When** 点击，**Then** 打开该文件的 IDE diff（`ide.showFileDiff`）
3. **Given** 切换到另一个会话，**When** 看面板，**Then** 产出区随会话重算（按会话隔离，天然避免 Cursor 式「永远不清空」）
4. **Given** 会话没有任何写操作，**When** 看面板，**Then** 产出区显示明确的空态文案，不是空白

### User Story 5 — 后台任务看得到、看得懂（Priority: P2）

pi-subagents 的后台作业逐行列出：作业名 + 四态（运行中/等待你/已完成/失败）+
chain 步骤流（哪些步骤已完成、正在跑第几步、还有几步）（F-24/25）。

**独立可测**：装扩展后触发一个后台 chain 作业，看面板后台任务分区。

**验收场景**：
1. **Given** 1 个后台作业运行中（chain 步骤 2/3），**When** 看面板，**Then** 显示作业名、运行中状态与「步骤 2/3」进度
2. **Given** 作业完成，**When** 事件触发刷新（≤250ms 合并），**Then** 状态变为「已完成」
3. **Given** pi-subagents 未安装，**When** 看面板，**Then** 后台任务分区隐藏

## 需求（Functional Requirements）

- **FR-001**：入口 = chat tab 栏的「状态」工具按钮（与大纲/搜索同款 tab-tool-btn，
  **不做角标**——用户拍板）；点击在大纲弹层的锚点（top 40px / right 8px）弹出
  **限宽弹层**：`width: min(320px, 100cqw - 24px)`，与大纲/搜索互斥（同一时刻
  只开一个）。面板分区：运行状态 / 后台任务 / **子代理** / 处理清单 / 待处理 / 产出。
- **FR-002**：运行状态区展示：piStatus 四态 + isStreaming 合成的运行态、当前模型、
  上下文占用、成本；与 StatusBar **同源**（同一 store 字段），不另起数据通道。
- **FR-003**：store 不再丢弃 `setStatus` 类 extension_ui_request：按 statusKey
  维护扩展状态条目并送入运行状态区；`setWidget` / `notify` 本期仍丢弃（取舍 D-4）。
- **FR-004**：待处理区实时反映 `approvals` 数组；条目可点击，跳转聊天 tab 并滚动到
  对应审批卡。
- **FR-005**：**消息队列不进面板**（用户拍板：竞品无一展示输入队列，QueueBar
  独占其展示与操作）。任务语义拆成两个分区：**后台任务**（进程级，FR-011）与
  **处理清单**（步骤级勾选，FR-012）。扩展 `setStatus` 条目并入运行状态区
  （FR-003）。面板对全部分区只读，操作留在原位（FR-008）。
- **FR-006**：产出区由 transcript 的 write/edit 类工具调用推导：按路径去重、
  标注改动类型、点击调用 `ide.showFileDiff`（不可 diff 时退 `ide.openFile`）。
- **FR-007**：产出区随活动会话切换重算；新会话从零开始，不做跨会话累计。
- **FR-008**：面板只读 + 跳转：重启 pi、队列取回/删除/暂停、审批作答一律留在
  原有入口（StatusBar / QueueBar / ApprovalCard），面板不复制任何操作按钮。
- **FR-009**：i18n 双语完整（en/zh），验收时切语言检查。
- **FR-010**：窄面板（360px 判据）不横向溢出；e2e 断言含几何与行为
  （`toBeVisible()` 不算数——仓库规则）。
- **FR-011**：**后台任务**分区展示 pi-subagents 的作业（本机已装，F-20/21）：
  每行 = 作业名 + 四态（运行中 / 等待你 / 已完成 / 失败，对齐其 OSC 7501 语义）
  + chain 步骤流（`done scout → running worker` 式，标出已完成、正在执行与
  将要执行的步骤）。**数据通道 = 通道 A（`setWidget` 快照）**：
  pi-subagents 经 `extension_ui_request` 发 `method:"setWidget"`、
  `widgetKey:"subagent-async"`、`widgetLines[0]` 形如
  `PI_SUBAGENT_ASYNC_JSON:<AsyncStatusSnapshot JSON>`（无 `widgetLines` = 空态注册帧）；
  宿主按 250ms 合并后整帧替换旧快照（快照是全量替换不是补丁）。
  佐证：probe.md §3/§4/§5（静态 + 首次 RPC 实测）与 **2026-11-28 真机复测**
  （真实 pi 1.6.1 + pi-subagents 0.89.2：抓到 12 个真实快照帧，面板渲染出
  `worker | 步骤 1/1 | 运行中 | ● worker`）。
  降级路径（会话重载后从 transcript 重建）：subagent 工具结果 `details.results[]`、
  `subagent-notify` 消息 `details.runs[]`（通道 D，尚未真机确认回吐，见 tasks T9.2）；
  前台子代理进度随父会话工具卡（`tool_execution_update` 的 `details.progress[]`）。
  扩展未装时该分区隐藏，不显示空壳（F-24 之戒：状态不得残留过期）。
  **注**：`subagent:*` 五个宿主事件是 pi 的进程内总线事件，RPC 模式下不上线
  （probe.md §3），因此不作为数据源。
- **FR-013**：**子代理**分区（2026-11-28 真机新增，用户拍板「子代理应该单独归类
  去展示」）：逐行列出**本会话用过的子代理**——代理名 + 状态徽标。数据来自
  **通道 D**（会话记录重建，pi-subagents extension-api.md:157 / :666）：
  - 后台：`subagent-notify` 自定义消息的 `details.runs[]`（每个 entry 有
    `agent` + `status`，可能带 `runId` / `childRuns[]`——workflow 的子运行
    也逐条列出，不折叠进父级）；
  - 前台：`subagent` 工具结果的 `details.results[]`。
  两条路径都**事件驱动**（`message_end` 带 `role:"custom"` 的自定义消息 /
  `tool_execution_end`），**会话重载后**再从 `get_messages` 重建；同一 run
  以 runId 去重。分区在无记录时隐藏。
  与「后台任务」的分工：后台任务 = **此刻在跑**的作业（通道 A 快照，带 chain
  步骤流）；子代理 = **本会话用过**的子代理（跑完的也在）。
- **FR-012**：**处理清单**分区：三态勾选对齐 Cursor（F-25）——○ 未开始 /
  ◌ 进行中 / ✓ 已完成（⊗ 已取消备用）；进行中的条目置顶高亮。v1 数据源 =
  transcript 中 todo 类工具调用的最近一次快照（装了 todo 类扩展才有内容），
  pi-subagents chain 步骤态可作为该分区的补充来源。勾选只读：状态由 agent
  驱动，用户不在面板里改。无清单数据时分区隐藏。

## 关键设计取舍（D-1/D-2 已拍板；D-3/D-4/D-5 为推荐值，可改）

- **D-1 面板形态**：**已拍板**（用户）：不做角标，就是**大纲同款弹层**——
  tab-tool 按钮 + 锚点 top 40px / right 8px + 限宽 `min(320px, 100cqw-24px)`；
  右侧折叠栏、第四 tab、StatusBar 抽屉均已排除。
- **D-2 任务定义**：**已拍板**（用户）：队列不进面板（竞品无一展示输入队列，
  QueueBar 独占）；任务 = **后台任务**（pi-subagents 作业，FR-011）+
  **处理清单**（三态勾选，FR-012，以 Cursor 三态为基准）。扩展 `setStatus`
  归入运行状态区；todo 管理操作不做。
- **D-3 产出数据源**：推荐 **transcript 推导**（零 Kotlin、语义是「pi 的写操作」）；
  git 级全仓清单进 roadmap（需新桥接方法，且要解决「pi 改 vs 人改」区分）。
- **D-4 扩展状态透传范围**：推荐只透 `setStatus`（单行文本，映射自然）；
  `setWidget` 是多行文本块，展示形态另议。
- **D-5 可操作性**：推荐**只读 + 跳转**（同一操作不做两个入口，回归面最小）。

## 非目标

- 不在面板展示消息队列（插话/后续）——QueueBar 独占，用户拍板。
- 不做真 todo / 任务清单扩展、不做子代理扩展本体（生态扩展的事，另行立项；
  面板只消费其产出的数据）。
- 不做 todo 的增删改管理操作（pi-todo 等扩展自身管理；面板 v1 只读展示）。
- 不做 pi-subagents 的 missions / schedules 管理界面（数据同源，另行立项）。
- 不做 pi-background-tasks 类第三方后台 shell 包的接入（本机未装，不进依赖）。
- 不做 git 级产出清单（roadmap，另立 spec）。
- 不做跨会话汇总、历史会话的产出回看。
- 不做面板内直接操作（作答/取回/重启）。
- 不实现 roadmap P3-4 的原生 IDE 状态栏 Widget——本面板是工具窗内 UI，两者互不替代。

## 边界与风险

- **FR-011 的线上形状已由真机坐实**（2026-11-28）：`setWidget(subagent-async)` +
  `PI_SUBAGENT_ASYNC_JSON:` 前缀的快照帧确实上线，面板据此渲染作业行。
  仍存两处未闭环（不阻塞）：inspect 成功变体（probe.md §8 caveat 2）、后台作业的
  「等待你」态实拍。通道 D（transcript 重建）的 `get_messages` 回吐未线测，
  缺口时按 tasks T4.3 降级为「重载后历史行仅由通道 A 快照承担」。
- **产出 ≠ 磁盘真实 diff**：推导自工具调用，bash 里改文件看不到；文案要说清
  「pi 的写操作清单」，不冒充 git status。
- **产出区语义与 Cursor 病的对应**：按会话隔离（FR-007）天然规避「不清空」；
  「pi 改 vs 人改」在 v1 天然成立（只统计 pi 的工具调用）。
- **弹层与既有弹层（outline/search）互斥**：同一时刻只开一个，复用现有互斥逻辑。
- **宽表中文名目**：分区命名「运行状态/后台任务/处理清单/待处理/产出」以用户
  原话为基准，实现时按 i18n 双语核（大写/译法循竞品证据，见 memory 规约）。

## 假设与依赖

- pi 1.6.1 事件面：`extension_ui_request` 全量透传前端（Kotlin 不筛，现状保持）。
- 本机已装 pi-subagents@0.89.2（settings `npm:pi-subagents`）；其宿主事件仅在
  带 UI 的会话发出（RPC 模式含）；pi 未装该扩展时 FR-011 分组隐藏。
- FR-012 的清单内容依赖 todo 类扩展（pi-todo 等）经工具调用落进 transcript；
  未装扩展时分区隐藏——分区本身不依赖任何特定扩展。
- `ide.showFileDiff` / `ide.openFile` 桥接方法已存在且可用。
- 队列镜像（spec 005）与审批流（approvals）已稳定，本 spec 只消费不改动其语义。

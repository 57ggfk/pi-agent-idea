# Feature Specification: 消息级 Fork、底部 Fork 隐藏与确认框

**Feature Branch**: `release/0.5.2`

**Created**: 2026-11-04

**Status**: Draft

**Input**: 用户需求「fork 按钮的位置」「任务 pi 消息 fork 出新会话」，以及缺陷「新增和 fork 弹确认框」。
经澄清：**fork 加在每条 pi 消息的悬停工具条上（就是复制/引用那一排），支持基于该条 pi 消息 fork**；
**底部控制栏的 Fork 先隐藏**（不是删除，后续可能要放回来）。

**难度定位**：中等。UI 改动小，但 fork 的边界语义依赖 pi 协议的真实行为，必须先真机验证再定实现。

## 问题陈述

现在 Fork 只有一个入口，且语义固定为「在最后一条用户消息处分支」。用户真正想做的事是：
「这段回答我有别的问法，从这儿岔开试试」——这需要**以某条回复为界**分支，而不是只能在会话末尾分支。
同时，现有交互没有任何确认：点一下 New 或 Fork，当前视图就被切走，用户常常不知道发生了什么、
旧会话去哪了（虽然能在 Sessions 里找回，但当下是懵的）。

| 场景 | 现状 |
|---|---|
| 想从第 3 条回答岔开重问 | 只能先 fork 到最后一条，再想办法 |
| 点 Fork 之后发生了什么 | 没有任何说明，视图直接换掉 |
| 点 New 之后旧会话还在吗 | 没有任何说明 |
| 误触 Fork | 直接切走，只能去 Sessions 找回来 |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 从任意一条 pi 回复 fork 出新会话 (Priority: P1)

用户在浏览一段长对话，看到第 3 条回答时想换个问法。把鼠标悬停到那条 pi 消息上，
工具条里除了复制/引用还有一个 Fork 按钮；点击后弹出确认框说明「将以这条回复为界新建会话，
当前会话保留」；确认后切到新会话，新会话保留该回复及之前的全部上下文，该回复之后的内容不进入新会话。

**Why this priority**: 这是本次「fork 按钮位置」需求的真实目的。底部 Fork 隐藏后，这是唯一的 Fork 入口。

**Independent Test**: 造 4 轮对话（U1/A1/U2/A2），悬停 A1 点 Fork → 确认 → 断言切到新会话、
新会话最后一条是 A1 的内容、U2 与 A2 不在新会话中、旧会话仍在 Sessions 列表里且内容不变。

**Acceptance Scenarios**:

1. **Given** 会话有 U1/A1/U2/A2 四轮，**When** 悬停 A1 点 Fork 并确认，**Then** 新会话的消息序列为 U1/A1
   （末尾是 A1），不包含 U2/A2。
2. **Given** 悬停在最后一条 pi 回复 A2，**When** 点 Fork 并确认，**Then** 新会话包含 U1/A1/U2/A2 全部内容
   （等价于「复制整个会话继续」），旧会话不变。
3. **Given** 悬停在任意 pi 消息，**Then** 工具条上的 Fork 按钮只在会话空闲时可用；流式进行中不出现或禁用
   （与「重新生成」同一条约束）。
4. **Given** 悬停在 user 消息 / 系统消息，**Then** 不出现 Fork 按钮（本轮只对 pi 回复提供）。
5. **Given** 确认框弹出，**When** 点取消或按 Esc，**Then** 不发生任何会话变更（旧会话内容、当前视图都不变）。
6. **Given** fork 完成，**Then** 旧会话仍可从 Sessions 列表切回，且内容与 fork 前逐条一致。
7. **Given** pi 的 fork 被扩展取消（协议内 `cancelled`），**Then** 显示一条可见的错误系统消息，
   不静默停在一个空视图上。

---

### User Story 2 - 底部 Fork 隐藏 (Priority: P1)

底部控制栏（Compact / Fork / New 那一排）不再显示 Fork。功能本身通过消息级 Fork 保留，
代码不删除，便于后续按需恢复。

**Why this priority**: 入口重复会让人不知道该用哪个；隐藏是一次一行改动，属于必须与 US1 同批交付的收尾。

**Independent Test**: Chat 页断言底部控制栏无 `data-testid="fork-btn"`，且 Compact / New 仍在原位、
控制栏不出现空洞（间距均匀）。

**Acceptance Scenarios**:

1. **Given** Chat 页，**Then** 底部控制栏依次为：附件、模型、思考等级、Options、[Stop]、Compact、New、发送。
2. **Given** 底部 Fork 隐藏，**Then** 控制栏的密度分级（`data-density`）与折叠逻辑仍按实际按钮数计算，
   360px 下不换行、不溢出。
3. **Given** 只剩一条用户消息的会话，**Then** 悬停该条 pi 回复仍可见 Fork（不因为「等价于底部行为」被隐藏）。

---

### User Story 3 - 新增 / Fork / 删除都先确认 (Priority: P2)

凡是会切换或丢弃当前视图的动作，都先弹一个应用内确认框：标题说清「会发生什么」，
正文说清「旧会话是否保留」，主按钮文案是动词（`Fork session` / `Start new` / `Delete`），
危险动作用警示色。Esc 取消、Enter 确认、点遮罩取消。

**Why this priority**: 交互安全网，价值明确但不如 US1/US2 直接产出能力；统一组件顺带把
Sessions 的 `window.confirm` 也换掉（原生弹窗在 JCEF 里样式与 i18n 都不可控）。

**Independent Test**: 三种入口各触发一次 → 断言弹窗文案含关键信息、Esc 取消无副作用、
Enter 确认执行；`window.confirm` 在 Chat 与 Sessions 页都不再出现（用 dialog 事件计数为 0 断言）。

**Acceptance Scenarios**:

1. **Given** 会话有内容，**When** 点 New，**Then** 弹框说明「当前会话将在 Sessions 中保留，视图切换到新会话」。
2. **Given** 会话为空（无消息、无运行），**When** 点 New，**Then** 不弹框，直接新建（避免纯噪音）。
3. **Given** 正在流式输出，**When** 点 New，**Then** 弹框额外警示「当前回答会被丢弃」，文案与空闲态不同。
4. **Given** 点任意 Fork，**Then** 弹框说明新会话包含到该回复为止、旧会话保留。
5. **Given** 弹框打开，**Then** 焦点落在主按钮，Tab 只在弹框内循环，Esc 取消，Enter 确认。
6. **Given** 弹框打开，**Then** 弹窗完整落在 `.app` 内，背景消息区不可点（遮罩拦截），滚动不穿透。
7. **Given** Sessions 页删除会话，**Then** 走同一组件（文案「Delete session」+ 不可撤销说明）。

### Edge Cases

- **没有任何用户消息**（只有系统提示或刚打开的空会话）：Fork 不可用，悬停不出现该按钮。
- **fork 进行中再点一次**：按钮禁用 + 弹框不再可触发（同一时刻只有一个 fork 在途）。
- **fork 后立即发送**：新会话的 composer 可用，草稿清空，队列状态清空（队列属于旧会话）。
- **fork 失败（pi 重启 / 进程退出）**：显示可见错误消息，视图保持原样，不出现「半切换」。
- **确认框与流式同时存在**：弹框不打断流式渲染；取消后流式继续。
- **弹窗与消息操作条叠层**：操作条 z-index 不得盖住弹窗遮罩。
- **窄窗 360px**：弹窗宽度不超过 `calc(100% - 24px)`，按钮不换行成两行。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: ~~每条 pi（assistant）消息的悬停工具条 MUST 提供 Fork 动作~~；user / system 消息 MUST NOT 提供。
  **（2026-11-10 由 [023](../023-fork-round-end/spec.md) 修订）**：只在该轮**最后一条** pi 回复上提供 ——
  一轮 = 一次提问 + 该轮全部 pi 回复，同轮其余回复点 Fork 与末尾那条结果完全相同（pi 只认用户消息为切点），
  且中间那条会把同轮后续回复也带入，与本条下方的 FR-003 冲突。实现以 023 为准。
- **FR-002**: Fork 动作 MUST 仅在会话空闲时可用（流式中不可触发），且 MUST NOT 影响该消息的复制/引用可用性。
- **FR-003**: 基于某条 pi 回复 Fork 产生的新会话 MUST 包含该回复及其之前的全部上下文，
  MUST NOT 包含该回复之后的消息。
- **FR-004**: 对最后一条 pi 回复 Fork MUST 等价于「复制当前完整会话到新会话」，旧会话内容不变。
- **FR-005**: Fork MUST 保留旧会话，且用户 MUST 能从 Sessions 列表切回并看到与 Fork 前一致的内容。
- **FR-006**: 底部控制栏 MUST NOT 再渲染 Fork 入口；实现 MUST 保留可一行恢复的开关（常量或配置），
  且该开关不影响控制栏密度测量。
- **FR-007**: New / Fork（两处）/ 删除会话 MUST 走统一的应用内确认组件，MUST NOT 使用 `window.confirm`。
- **FR-008**: 确认框 MUST 说明「会发生什么」与「旧会话是否保留」；流式中 New MUST 额外说明当前回答会被丢弃。
- **FR-009**: 确认框 MUST 支持 Esc 取消、Enter 确认、点遮罩取消、焦点圈定（Tab 循环）、
  主按钮自动聚焦，并 MUST 带 `role="dialog"` / `aria-modal="true"` / 可访问标题。
- **FR-010**: 确认框 MUST 完整落在 `.app` 内，遮罩拦截点击与滚动穿透。
- **FR-011**: 空会话点 New MUST NOT 弹框（记录为有意为之）。
- **FR-012**: Fork 失败或被执行扩展取消时 MUST 显示可见错误消息，视图 MUST 保持原状。
- **FR-013**: Fork 完成后 MUST 清理上一会话的草稿、图片与队列状态（不得把旧会话的待发内容带进新会话）。

### Key Entities

- **Fork 目标**：`{itemId, role: "assistant", precedingUserEntryId, nextUserEntryId|null}` —
  分支点由这两个 entryId 决定（最终取哪个，取决于 plan 中协议验证的结论）。
- **确认请求**：`{titleKey, messageKey, params, confirmLabelKey, danger, onConfirm}` — 进 store，
  由 App 层渲染唯一的弹窗实例。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 「从第 k 条回答岔开重问」从「无法直接做到」变为 2 步（悬停 Fork → 确认），
  e2e 可断言新会话的消息序列。
- **SC-002**: 一次误触 Fork / New 造成的视图切换，从「必须去 Sessions 找回」变为 0 次（Esc 即可）。
- **SC-003**: Chat 与 Sessions 页的 `window.confirm` 调用次数为 0（e2e 用 dialog 事件计数）。
- **SC-004**: 确认框在 360 / 430 / 900px 三档下都完整可见、按钮不换行、焦点不逃出弹窗。

## Assumptions

- **新会话的定位方式**：pi 1.4.0 的 `fork` 只回 `{text, cancelled}`，不返回新会话路径（0.5.1 已按此适配），
  因此 fork 后仍走「从 pi 重新读取消息 + 刷新 Sessions」的既有路径，不引入新协议。
- **「最后一条回复 Fork = 复制整段会话」**：优先用 `clone`；如果 `clone` 与 `fork` 在队列/统计上的副作用不同，
  以 plan 的验证结果为准，行为约束仍是「新会话包含全部内容」。
- **空会话 New 不弹框**：用户要求「新增弹确认框」的动机是「别丢掉我做了一半的事」，空会话无此风险；
  如果希望「永远弹」，改一个常量即可，不属于本版分歧点。
- **不在消息上提供 user 消息 fork**：本轮范围只到 pi 回复；user 消息 fork 与「编辑重发」语义重叠，留待后续。

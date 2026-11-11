# Feature Specification: 「回到底部」悬浮按钮

**Feature Branch**: `release/0.5.8`

**Created**: 2026-11-12

**Status**: Draft

**Input**: 用户需求（2026-11-12）
> 滑动到底部按钮，常见的效果就是底部悬浮一个向下的箭头图标，点击滑动到底部，到底部之后则图标消失。

**难度定位**：小。状态已经有（022 的 `pin` 状态机），本条只是把它**暴露给 UI** 并加一个按钮；
风险在于**不能因为按钮插入而改变滚动几何**（`content-visibility` 陷阱的前车之鉴）。

## 问题陈述

### 现状：有「是否跟随」，但没有「回到最新」的入口

`lib/pin.ts`（022 D4）已经把「视图是否跟随新内容」做成了显式状态 `PinState.pinned`，
`MessageList.tsx:161` 用 `pinRef` 持有，`onScroll`（`:217-223`）每次滚动更新它，
`shouldStick()` 决定新内容到来时是否贴底（`:208-215`）。

但它是 **ref，不是 state**——不触发渲染，所以界面上没有任何东西能反映它；
用户向上翻了几屏后，想回到最新只能自己一路滚到底（长会话里上千像素），或者等新消息把自己拽下去（现在不会拽了，这是 022 的正确行为）。

**缺失的正是这一条**：`pinned === false` 时给出一个「回到底部」入口，点了立刻回到最新并恢复跟随。

### 关键约束（来自 022 的教训，必须写进实现）

- 按钮 MUST 是滚动容器的**兄弟节点**（`absolute`/`fixed` 定位在列表外层），
  **不能**放进滚动容器内部——放进去会改变 `scrollHeight`，进而被 `content-visibility` 的重测量放大成滚动抖动。
- 按钮的显隐 MUST 由 `pinned` 派生，**不得**再用「距底 < N px」这类距离阈值（022 已证明它与单格滚轮同量级，会误判）。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 向上翻后出现，点一下回到最新 (Priority: P1)

用户在长会话里向上滚了两屏，消息列表右下角浮出一个向下的箭头；点它，列表平滑滚到最底部，
按钮随即消失，之后的流式新内容继续自动跟随（`pinned` 恢复为 true）。

**Why this priority**: 需求本体，且它让 022 的「向上滚就脱离」变得可用——脱离之后有路可回。

**Independent Test**: 造 100 条消息 → `scrollTop = 0` → 断言按钮出现 → 点击 → 断言
`scrollHeight - scrollTop - clientHeight ≤ 4` 且按钮消失、`showWidget` 后新内容仍贴底。

### User Story 2 - 在底部时从不打扰 (Priority: P1)

正常聊天（一直在底部）时按钮全程不可见，包括流式输出过程中；它不能遮挡最后一条消息、
不能出现在 Composer 之上造成误点。

**Independent Test**: 默认贴底状态下逐帧采样 1s（含流式），断言按钮 `toHaveCount(0)` 或不可见且不占位。

### User Story 3 - 新内容到达时给出「有更新」的暗示（可选，P3）(Priority: P3)

未贴底期间若来了新消息，按钮可以有轻微强调（例如仍只是一个箭头，不加数字角标）。
本轮**只做箭头**，但状态机要留出「未读期间有新内容」的布尔，便于后续加角标。

**Independent Test**: 未贴底时追加一条消息 → 断言按钮仍在（不自动滚动）；不要求角标。

### User Story 4 - 键盘与无障碍可用 (Priority: P2)

按钮可 Tab 聚焦，Enter/Space 触发，`aria-label` 已 i18n（「回到底部」/「Scroll to bottom」），
不抢走输入框焦点（点击后焦点回到 composer 是可接受的，但不是必须）。

**Independent Test**: `focus()` 按钮 → `Enter` → 断言滚到底；断言 `aria-label` 命中字典键。

### User Story 5 - 平滑滚动不破坏 pin 状态机 (Priority: P2)

点击后的程序化滚动会被 `onScroll` 观察到；它**不得**被判定为「用户向上滚」而重新 unpin（否则按钮永远不消失）。
滚到底后 `pinned` 必须为 true。

**Independent Test**: 点击 → 等动画结束 → 连续两次断言 `pinned === true`；随后追加消息，断言自动贴底。

## Requirements *(mandatory)*

- **FR-001** `MessageList` MUST 把 `pinRef.current.pinned` 镜像成 React state（`useState`），
  更新时机在 `onScroll` 之后（同一帧内），并做**值变化才 setState**（避免每格滚动都渲染）。
- **FR-002** 按钮 MUST 渲染在滚动容器之外（列表外层定位容器内、`position:absolute; right:12px; bottom:12px`），
  不进入滚动流；不得改变 `scrollHeight`（用一条 e2e 断言点击前后 `scrollHeight` 不变）。
- **FR-003** 显隐 MUST 完全由 `pinned` 派生：`pinned === false` 显示，`pinned === true` 不渲染（不是 `visibility:hidden` 占位）。
- **FR-004** 点击 MUST：`el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })`（`prefers-reduced-motion` 时用 `auto`），
  并在滚动开始前把 `pinned` 置 true、`lastTop/lastHeight` 同步，避免 `onScroll` 把它读成向上滚。
- **FR-005** 按钮 MUST 支持键盘（`<button>` 原生即可）与 `aria-label` 双语文案。
- **FR-006** 按钮 MUST NOT 遮挡内容：不覆盖最后一条消息的可操作区（有 Composer 时 `bottom` 以列表容器为基准，不含 composer 高度）。
- **FR-007** 图标复用既有 `chev-down`（`Icon.tsx` 已有），不新增图标资源。
- **FR-008** 未贴底期间有新内容到达时 MUST 记录一个 `unseen` 布尔（本轮只用于内部状态，不加角标）。

## 验收口径

| 项 | 判据 |
|---|---|
| 出现条件 | `scrollTop=0`（100 条消息）→ 按钮存在且可点；回到底部 → 按钮 `toHaveCount(0)` |
| 点击效果 | 点击后 `scrollHeight - scrollTop - clientHeight ≤ 4`，且按钮消失 |
| 几何不变 | 点击前后 `scrollHeight` 与 `items.length` 不变（按钮不在滚动流内） |
| 不误判 | 点击引发的程序化滚动之后 `pinned === true`，追加消息自动贴底 |
| 流式不打扰 | 贴底时流式 1s，按钮全程不渲染 |
| 无障碍 | `aria-label` 命中 `chat.jumpToBottom`（中/英），`Enter` 可触发 |

## 非目标

- 不做「新消息 N 条」角标（留接口，不做 UI）。
- 不做「跳到上一条用户消息」（那是 006 的目录/搜索职责）。
- 不改 022 的 pin 判定规则（方向优先、4px 容差）。

## 待确认 / 已知风险

- JCEF 的 `scroll-behavior: smooth` 在 OSR 下的实际帧率约 16–33ms/帧，动画会看起来偏「顿」；若真机观感差，
  降级为瞬时定位（`behavior: "auto"`）并在 CHANGELOG 不单独提。**默认先做 smooth，真机目验后定**。
- 按钮位置与队列条（`QueueBar`）在窄高度下可能重叠；实现时以「不重叠队列条」为优先（队列条出现时按钮上移）。

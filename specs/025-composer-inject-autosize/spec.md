# Feature Specification: 注入内容到输入框后必须自适应高度并滚到末尾

**Feature Branch**: `release/0.5.8`

**Created**: 2026-11-12

**Status**: Draft

**Input**: 用户反馈（2026-11-12）
> 添加右键菜单内容到会话应该自适应输入框高度，引用内容添加到会话输入框等情况，有时候还是无法自适应高度并滚动到最后，
> 你能不能优化好，无论什么情况添加内容到输入框则自适应高度并滚动到最后。

**难度定位**：小。一个工具函数 + 一处 effect 收口，但**必须逐条覆盖 7 条注入通路**，漏一条就等于没修。

## 问题陈述

### 现状：只有「长高」，没有「滚到末尾」，且测量时机的假设不成立

所有外部注入最终都汇到一个 effect：`Composer.tsx:319-378`（`pendingPrompt` → `setText` → `requestAnimationFrame`）。
里面第 370-377 行在 rAF 里做了三件事：`focus()`、把光标放到末尾、`autosize()`。
`lib/autosize.ts:52-62` 的 `autosize` 只设 `ta.style.height`，**从不设 `ta.scrollTop`**。

于是有两个独立的坏结果：

1. **超过上限时不滚到最后**。输入框上限是 `min(320px, 45% × app 高度)`（`autosize.ts:13,26-30`）。
   注入一段 20 行以上的引用/文件内容后，高度被夹到上限，**可见窗口停在文本开头**，用户看不到刚注入的尾巴，
   主观感受就是「没自适应」。光标虽然在末尾（`setSelectionRange`），但浏览器不会因为光标在末尾就滚动——
   焦点在 rAF 里已设置，滚动位置仍为 0。
2. **测量时机会给出 0 或过期值**。`autosize` 读 `ta.scrollHeight` 与 `app.clientHeight`。
   注入发生在**别的页签**或工具窗刚被唤醒时（右键菜单「加入会话」正是这种：IDE 侧发起，webview 可能刚被 `show()`），
   此时布局未完成 → `clientHeight` 为 0 → 走 `MAX_COMPOSER_CAP` 兜底（尚可），但 `scrollHeight` 也可能是旧值/0 →
   高度被压到 `MIN_COMPOSER_HEIGHT = 34`。之后没有任何时机重测：`ResizeObserver`（`Composer.tsx:274-312`）
   只在**容器尺寸变化**时触发，从「0 高度」变成「正常高度」确实会触发一次，但**文本内容的变化不会**，
   所以如果这次测量错过了，就一直错着，直到用户手动敲一个字。

### 受影响的注入通路（全部经 `pushPendingPrompt`，一个 effect 收口）

| 通路 | 入口 | mode |
|---|---|---|
| IDE 右键「Explain with Pi」等编辑器动作 | `ide` 事件 | `replace` |
| 消息工具条「引用」 | `store.ts:2195 quoteToComposer` | `quote` |
| 消息工具条「编辑并重发」 | `store.ts:2253 beginEditMessage` | `edit` |
| 队列条目取回 | 005 US3 | `restore` |
| 拖拽文件/目录进输入框 | 016 `files.takeDrop` → `refs` | `replace`/`quote` + refs |
| 右键「添加目录/文件到 pi」 | 015/016 `refs` | + refs |
| 剪贴板粘贴图片 | 018 粘贴识别 | + images |

`refs` 与 `images` 走的是同一个 effect 的尾部（`Composer.tsx:345-366`），因此一处修好即全通路生效——
**前提是修在收口处，而不是在某个按钮的回调里补一次 `scrollTop`**（0.5.4 的教训：`ide.repaint` 只接在页签点击上）。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 长内容注入后看到尾部并立即可输入 (Priority: P1)

用户在编辑器里选中 30 行代码，右键「加入会话」。输入框立刻长到上限高度，**显示的是被注入内容的结尾**，
光标停在最后一行末尾，可以直接接着打字。滚动条位置在底部，不是顶部。

**Why this priority**: 这是反馈原话的主场景，「高但看不到尾巴」比「不高」更让人迷惑。

**Independent Test**: 注入 30 行文本（超过上限），断言 `ta.scrollTop + ta.clientHeight >= ta.scrollHeight - 1`
且 `ta.style.height === cap + "px"`；再断言 caret 在 `value.length`。

### User Story 2 - 在别的页签/工具窗未激活时注入，切回来高度依然正确 (Priority: P1)

用户在 IDE 里触发右键动作，此时插件工具窗停在「会话列表」页签或整个工具窗是隐藏的。切到聊天页签时，
输入框已经按内容长好、并且停在末尾——不需要用户先敲一个字触发重算。

**Why this priority**: 「有时候还是无法自适应」这句反馈的分布特征就是「时好时坏」，对应测量时机，而不是逻辑缺失。

**Independent Test**: 让 `.app` 处于 `display:none` 时注入 20 行，再恢复显示；等一帧后断言高度 ≥ 内容应有高度
（不是 34px），且滚到底。

### User Story 3 - 短内容与用户自己的草稿不被破坏 (Priority: P2)

注入 3 行文本，输入框高度正好等于内容高度（不多留空白）；草稿已存在时按各 mode 的既有拼接规则处理，
注入后草稿内容逐字不变、只在尾部追加，且同样滚到末尾。

**Why this priority**: 修高度容易顺手把「不覆盖草稿」的既有契约（010 FR-006）弄坏。

**Independent Test**: 预置 2 行草稿 → 引用注入 → 断言文本 === 期望拼接结果；高度 === 实测内容高度；滚到底。

### User Story 4 - 用户主动上滚后不被拽回 (Priority: P2)

用户注入后向上滚了两行看开头，此时不该被任何「自动滚到尾」重新拽下去——只有**注入那一刻**滚到尾，
不是持续跟随。

**Why this priority**: 与 022 的 pin 状态机不冲突，但容易在实现里做成「每次 render 都滚」。

**Independent Test**: 注入 → 手动把 `scrollTop` 设为 0 → 触发一次无关的 state 变更（如模型名变化）→ 断言 `scrollTop` 仍为 0。

## Requirements *(mandatory)*

- **FR-001** `lib/autosize.ts` MUST 新增 `autosizeAndReveal(ta, appEl?)`：先 `autosize`，再
  `ta.scrollTop = ta.scrollHeight`（赋值在高度生效后，同一帧内）。
- **FR-002** `pendingPrompt` 的收口 effect MUST 改用 `autosizeAndReveal`，并保留现有的 focus + caret-to-end 顺序（caret 在 autosize 之前设，scroll 在之后）。
- **FR-003** 为「测量时布局未完成」补一次**延迟重测**：注入后若测得 `clientHeight === 0` 或高度 == `MIN_COMPOSER_HEIGHT`
  而文本非空，MUST 在可见性恢复时重测一次（监听 `.app` 的 `ResizeObserver` 由 0→非0，或页签切到 chat），
  重测同样走 `autosizeAndReveal`（此时才滚）。
- **FR-004** 重测 MUST 只针对「最近一次注入」生效一次（用一个自增序号，避免过期的重测把用户后来的手动调整覆盖）。
- **FR-005** 用户主动改变滚动位置后，MUST NOT 再有任何自动滚动（不订阅 `scroll` 做跟随）。
- **FR-006** 其余 6 条通路 MUST NOT 各自补 `scrollTop` —— 一律经 FR-002 的收口，避免下一个通路又漏。

## 验收口径

| 项 | 判据 |
|---|---|
| 长内容滚到尾 | 30 行注入后 `scrollHeight - scrollTop - clientHeight ≤ 1`，`height === composerMaxHeight(appH) + "px"` |
| 隐藏态注入 | `display:none` → 注入 → 恢复 → 2 帧后高度 > 34px 且滚到底 |
| 短内容 | 3 行注入后高度 == `clampComposerHeight(实测 scrollHeight, appH)`，无多余空白 |
| 草稿保留 | 既有 `ui-polish` / `composer` 相关 e2e 零回归 |
| 不拽回 | 手动上滚后无关 state 变更，`scrollTop` 不变 |

## 非目标

- 不改上限公式（`min(320px, 45%)`）与 CSS `--composer-max-h` 的单源约定。
- 不改 `pendingPrompt` 的四种 mode 拼接语义（010 FR-006 / 018 US1 已定）。
- 不做「注入后自动发送」。

## 待确认 / 已知风险

- JCEF OSR 下 `rAF` 节奏约 16–33ms，一帧内设 `scrollTop` 是否立即反映在绘制上需要真机确认（T 任务里留一条目视项）；
  若出现「高度对了但滚动位置滞后一帧」，允许在 `autosizeAndReveal` 内补一次 `requestAnimationFrame` 二次赋值（幂等）。
- 若某条通路的 `.app` 从未被 `show()`（工具窗整个隐藏期间注入），`ResizeObserver` 首次回调即可覆盖；
  但若用户从不切到聊天页签，此时不需要视觉正确，可接受。

# 025 注入内容后输入框自适应并滚到末尾 — 技术方案

> 依据 spec.md（2026-11-12）与 2026-11-12 代码复核（`lib/autosize.ts`、`Composer.tsx:319-378`）。

## 0. 复核结论

| spec 断言 | 复核结果 |
|---|---|
| `autosize` 只设 height、从不设 scrollTop | ✅（`autosize.ts:52-62` 末段） |
| 收口 effect 在 rAF 里 focus → caret → autosize | ✅（`Composer.tsx` pendingPrompt effect 尾部） |
| 容器 ResizeObserver 只对 app 尺寸变化重测、文本变化不触发 | ✅（`Composer.tsx:302-312`，remeasure 走裸 autosize） |
| 7 条通路全部汇到该 effect | ✅（ide 事件/quote/edit/restore/refs/images 见 `store.ts:1425-1466` 与 effect 内部） |
| e2e 注入通道 | ✅ `window.__piMockIde({kind:"prompt",text})`（mock.ts:502 → store ide 处理器，replace 模式） |

**关键结构事实（FR-003 的依据）**：Composer 只在 `tab==="chat"` 时挂载——切页签场景下
`pendingPrompt` 留在 store 里，Composer 重新挂载时 effect 带着完整布局重新执行，天然正确；
真正会测错的是「Composer 已挂载但 `.app` 未布局/隐藏」（工具窗刚唤醒、display:none）——
rAF 在 OSR 下仍会跑，读到 0 高度，之后没有任何重测时机。所以重测挂在 `.app` 的
ResizeObserver（0→非0 必触发）+ 一个一次性的待重测标记。

## 1. `lib/autosize.ts`（FR-001）

```ts
export function autosizeAndReveal(ta: HTMLTextAreaElement, appEl?: HTMLElement | null): void {
  autosize(ta, appEl);
  // 光标在末尾不会自动滚动（spec 问题陈述 #1）：高度落定后同帧把视口推到尾部。
  ta.scrollTop = ta.scrollHeight;
}
```

幂等；内容不超高时 `scrollTop` 赋值被浏览器夹为 0，天然无害（US3）。

## 2. `Composer.tsx` 收口 effect（FR-002/003/004）

rAF 回调顺序改为：`focus()` → `setSelectionRange(end,end)`（caret 在 autosize 前，FR-002）→
`autosizeAndReveal(ta, app)`。随后做一次**可疑测量判定**：

```ts
const suspect =
  !app || app.clientHeight === 0 ||
  (ta.value.trim().length > 0 &&
    parseFloat(ta.style.height) <= MIN_COMPOSER_HEIGHT &&
    ta.scrollHeight > MIN_COMPOSER_HEIGHT);
revealPendingRef.current = suspect ? pendingPromptId : null;
```

- `pendingPrompt.id` 就是 store 里已有的自增序号（`promptSeq`），直接复用为 FR-004 的「最近一次注入」
  标记：新注入覆盖旧标记；测得正常时清空标记（过期重测不会覆盖用户后来的手动调整）。
- 挂载 effect 的 `.app` ResizeObserver（既有的 `remeasure`）扩展：`revealPendingRef.current != null`
  且 `app.clientHeight > 0` → 改走 `autosizeAndReveal`（此时才滚）并**清空标记**（只重测一次）；
  否则保持裸 `autosize`（字体加载、窗口拖拽等普通重测绝不滚动，FR-005）。
- 不订阅 `scroll`，不做持续跟随（FR-005）；切页签场景由重新挂载天然覆盖（§0），不加第二机制。

## 3. 测试设计

| 层 | 用例 | 断言 |
|---|---|---|
| vitest（autosize.test.ts，plain-object textarea） | autosizeAndReveal 先长高后滚 | `style.height === "320px"`（scrollHeight 480、appHeight 0 → 绝对 cap）且 `scrollTop === 480`；内容不超高时 `scrollTop === scrollHeight`（赋值契约） |
| e2e（新 composer-inject-autosize.spec.ts） | US1 长内容 | 30 行注入 → `height === min(320, 0.45×appH) + "px"`、`scrollTop+clientHeight >= scrollHeight-1`、`selectionStart === value.length` |
| e2e | US2 隐藏态注入 | `.app` display:none → 注入 20 行 → 恢复显示 → 2 帧后 `height > 34px` 且滚到底 |
| e2e | US3 短内容 + 草稿 | 3 行注入 → `height === clamp(scrollHeight, appH)`（页内重算公式）；预置草稿 + 消息工具条引用 → value 以草稿开头、以换行结尾、滚到底 |
| e2e | US4 不拽回 | 注入 → `scrollTop=0` → viewport 改尺寸（RO 普通重测，走裸 autosize）→ `scrollTop` 仍 0 |
| e2e 零回归 | ui-polish / composer-refs 既有高度与拼接断言 | 全绿 |

## 4. 触及文件

```
web/src/lib/autosize.ts          autosizeAndReveal
web/src/lib/autosize.test.ts     2 条
web/src/components/Composer.tsx  收口 effect + revealPendingRef + RO 扩展
web/e2e/composer-inject-autosize.spec.ts  新文件 4 条
```

不改：cap 公式、CSS `--composer-max-h`、四种 mode 拼接语义、其余 6 条通路（FR-006：全走收口）。

## 5. 风险与边界

- JCEF OSR 帧滞后一帧的「高度对、滚动滞后」：`autosizeAndReveal` 内可幂等补一次 rAF 二次赋值——
  **先不加**（e2e 无此现象；真机目验条目 T707 记录在 MANUAL_TEST，出现再加）。
- `parseFloat(ta.style.height)` 在 style 未设置时为 NaN → `NaN <= 34` 为 false → 不误判可疑。
- US2 的 e2e 用 `display:none`/恢复模拟工具窗唤醒；RO 在 display:none 下不触发、恢复时触发一次，
  与真机 `show()` 的形态一致。

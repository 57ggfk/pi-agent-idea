# 025 注入内容后输入框自适应并滚到末尾 — Tasks

> 025 拥有 T7xx 编号段。

- [x] **T701** `lib/autosize.ts` 增 `autosizeAndReveal(ta, appEl?)`：autosize 后同帧
  `ta.scrollTop = ta.scrollHeight`（FR-001）。
  — 验证：`autosize.test.ts` 增 2 条（plain-object textarea：长内容先长到 cap 再 `scrollTop ===
  scrollHeight`；内容不超高时的赋值契约），`npx vitest run autosize.test.ts` 绿。

- [x] **T702** `Composer.tsx` 收口 effect 改用 `autosizeAndReveal`（caret 在前、scroll 在后）+ 可疑测量
  判定（app clientHeight===0 或 高度==34 而文本非空）→ `revealPendingRef` 记 `pendingPrompt.id`（FR-002/
  003/004）；`.app` ResizeObserver 扩展：标记存在且布局恢复 → `autosizeAndReveal` 一次并清标记；
  其余重测路径保持裸 autosize（FR-005/006，不加任何 scroll 跟随）。
  — 验证：typecheck 0 错；`npx vitest run` 全绿（store 层无回归）；行为由 T703 e2e 锁。

- [x] **T703** e2e：新增 `web/e2e/composer-inject-autosize.spec.ts` 四条——US1 30 行注入滚到尾且
  caret 在末尾；US2 display:none 注入→恢复→2 帧后高度>34 且滚到底；US3 3 行高度恰等于内容高度 + 草稿
  引用拼接保留且滚到底；US4 手动上滚后 viewport 变化不拽回。
  — 验证：`npx playwright test composer-inject-autosize` 4 条绿；`npx playwright test ui-polish
  composer-refs` 零回归。

- [x] **T704** 收尾：全量三件套；`changelog.d/025-composer-reveal.fixed.md`（两行）；run-report 更新。
  — 验证：三件套全绿；run-report 025 全 ✅。

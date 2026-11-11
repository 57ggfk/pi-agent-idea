# 029 「回到底部」悬浮按钮 — Tasks

> 029 拥有 T11xx 编号段（027=9xx、028=10xx，按规格号分配、与本执行顺序无关）。

- [x] **T1101** `MessageList.tsx`：`.message-list` 外套定位容器 `.message-list-wrap`（占位属性上移）+
  `uiPinnedRef`/`jumpVisible` 状态镜像（值变化才 setState，FR-001）+ `unseenRef`（FR-008，本轮不渲染）；
  onScroll / stick effect 两处接线 `syncPinUi`。
  — 验证：typecheck 0 错；`npx vitest run` 全绿（pin 纯函数无改动）；`npx playwright test scroll
  layout-regressions` 零回归（wrap 几何同框的证据）。

- [x] **T1102** 按钮 + `jumpToBottom`：条件渲染（FR-003）、`chev-down` 图标（FR-007）、aria-label 双语
  （FR-005）、点击先置 pinned/lastTop/lastHeight 再 smooth scrollTo（FR-004，reduced-motion 用 auto）。
  — 验证：i18n 两字典 `chat.jumpToBottom` 键存在且 typecheck 通过；行为由 T1103 e2e 锁。

- [ ] **T1103** e2e：新增 `web/e2e/jump-bottom.spec.ts` 五条（E1 出现/点击/消失 + scrollHeight 几何不变、
  E2 贴底流式全程不渲染、E3 键盘 Enter + aria-label、E4 程序化滚动后 pinned 保持 + 自动贴底、
  E5 未贴底来新消息按钮仍在）。
  — 验证：`npx playwright test jump-bottom` 5 条绿；`npx playwright test scroll` 零回归。

- [ ] **T1104** 收尾：全量三件套；`changelog.d/029-jump-to-bottom.added.md`（两行）；run-report 更新。
  — 验证：三件套全绿；run-report 029 全 ✅。

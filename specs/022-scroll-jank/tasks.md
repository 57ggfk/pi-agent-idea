# 022 tasks

> 状态：**已实现并验收**（2026-11-11）。T414 真机实测三个容器各 10 格上滑 -1200px 精确命中、逐步单调
> 不回头（见 [0.5.7-run-report](../0.5.7-run-report.md)）。
> 按实现调整两处：① T412 没有新开关——mock 已有「发一条 prompt 就长出消息」的能力，吸底用例直接复用；
> ② T413 无需修订既有断言：仓库里没有把 `data-active` 断言成「跟随 hover」的用例，
>   新增的「悬停 ✕ 键盘」语义由 `e2e/scroll.spec.ts` 两条新用例固定。
> 另：`nextPin` 增加 `lastHeight`，因为 `content-visibility` 重测量会缩短 `scrollHeight` 并夹紧
> `scrollTop`，只看「位置变小」会把几何变化误判成用户向上滚（详情见 plan D4 的实现注记）。
> 顺序即编号，串行执行。web 单测 `npx vitest run`，e2e `npx playwright test`，类型 `npm run typecheck`。
> 技术方案、状态机规则、比较器契约一律以 [plan.md](./plan.md) 为准；本文只排顺序与验证方式。
> 每条 task 自带「— 验证：…」；无断言覆盖的实现不得标记完成（宪法第 II 条）。
> **实施顺序约束**：以 `specs/README.md`「0.5.7 将来的实现顺序」为准（020 → 021 → **022** → 023）。020 会改 `PickerModelData` 与分组渲染，本文件所有 picker 相关 task 必须按 020 之后的形状写。

## A. 下拉列表：悬停不再抢滚轮

- [x] **T401** [US1] `data-active` 语义收窄为「键盘当前项」：删除 `ModelPicker.tsx:270` 与 `ProviderPicker.tsx:180,214` 的 `onMouseEnter={() => setHighlight(...)}`，新增容器级 `hoverIndexRef`（`onMouseEnter` 只写 ref、`onMouseLeave` 清空）；`pick()` 与 `Enter` 取 `hoverIndexRef.current ?? highlight` — 验证：e2e 悬停第 5 行后第 5 行 `data-active="false"`、原键盘行仍 `data-active="true"`；悬停后按 Enter 选中的是第 5 行
- [x] **T402** [US1] 补 CSS 悬停视觉：`styles.css` 增 `.model-option:hover`、provider 选项的 hover 规则，颜色复用 `--user-bubble`（与 `.model-option-active` 同源，Q2：不用延迟）— 验证：e2e 悬停行背景色与 `:hover` 前不同（`getComputedStyle` 断言 `background-color` 变化），且键盘项高亮仍可见
- [x] **T403** [US1] `ensureVisible` 只在键盘导航时执行：新增 `scrollOnChangeRef`，`↑/↓` 与打开定位置 `true`，effect 读完置 `false`；悬停不再触发 — 验证：单测/e2e 断言「悬停 5 次后 `list.scrollTop` 不变」（滚动位置只由滚轮与键盘改变）
- [x] **T404** [US3] 抽 `ModelOption` 组件 + `React.memo`（props 为原始值 + `useCallback(onPick)`）；分组渲染把「每组 `filter` 全表」改为一次遍历桶装（O(n)）— 验证：e2e 连续 20 次滚轮断言 `scrollTop` 单调无回弹；渲染次数用 `hover.render` 埋点断言 = 0（T411）
- [x] **T405** [US1] 既有折叠/搜索/当前项定位回归：确认 018 US5 与 011 US1 的用例在改动后仍全绿（不改断言，只跑）— 验证：`npx playwright test e2e/model-picker.spec.ts` 除 T413 明确修订的两条外零改动通过

## B. 消息列表：吸底方向优先 + 渲染成本

- [x] **T406** [US2] 新增 `web/src/lib/pin.ts`：`nextPin(state, scrollTop, scrollHeight, clientHeight)` 与 `BOTTOM_EPS = 4`（规则见 plan D4）— 验证：`pin.test.ts` 覆盖「向上滚一格立即 unpin（即使距底 <60px）」「距底 ≤4px 才 repin」「中间态保持上次」「内容变长但用户没滚 → 保持 pinned」
- [x] **T407** [US2] `MessageList` 接入 `nextPin`：`onScroll` 用 `lastTop` 判方向；`useEffect([items, retryInfo])` 仅在 `pinned` 时吸底 — 验证：e2e 滚到底后收到新消息仍跟随（`scrollTop === max`）；向上滚离后收到新消息 `scrollTop` 不变
- [x] **T408** [US2] e2e 新增「到底回滚」用例：滚到 `scrollHeight` 后 `wheel(0,-120)`，断言 `scrollTop` 在 100ms 内减少 >0，且不需要额外停顿/移动鼠标 — 验证：新用例进 `e2e/scroll.spec.ts`，改造前应能复现「不变」（作为缺陷证据先跑一次红）
- [x] **T409** [US3] `web/src/lib/messageActions.ts` 新增 `sameActionIds`；`ItemView` 改 `React.memo` + 自定义比较器（`item` 引用 + `activeHitBlockIndex` + action ids）— 验证：`messageActions.test.ts` 覆盖空/等长不同项/不同长度；e2e 断言「统计更新不重渲染消息」（用 `hover.render`/profiler 计数或 DOM 引用稳定：同一节点对象 `evaluate` 前后 `===` 不可测，改用计数器）
- [x] **T410** [US3] `content-visibility: auto; contain-intrinsic-size: auto 120px`（plan D6）——落地位置改到 `.item-body`：放在 `.item` 上会连带 paint containment，把悬在消息上边缘之上的动作工具条裁掉一半、按钮点不中（023 的 Fork 点击 e2e 暴露）。语义不变，只在真机滚动与跳转时复验— 验证：真机检查 ① 滚动条长度不来回跳 ② 「大纲/搜索跳转到第 N 条」落点正确（复用 006 既有 e2e + 真机目验）；若偏移则撤掉本 task 并记录原因
  **2026-11-11 真机复验后撤销**：`content-visibility` 是「往上滑不动」的**新根因**，与 US2 相冲突。会话刚加载时视口上方的消息从未被渲染，按 120px 提示高度占位（真实高度 3–6 倍）；向上滚一格它们开始渲染、高度暴涨，滚动锚定为保持画面稳定把 `scrollTop` 推回去 —— 实测 10 格上滑（应上移 1200px）结果**向下移动 3234px**；停下等布局稳定后才能正常滑，即用户说的「滑不动，停一下才能滑动」。已从 `.item-body` 移除（改为 `content-visibility: visible` 并留注释），保留 `React.memo` 那半的收益。回归守卫：`e2e/scroll.spec.ts` 的 `the transcript body is not optimized with content-visibility`。

## C. 度量与收尾

- [x] **T411** [US4] `perf.ts` 增两个事件：`scroll.frame`（wheel → 下一帧的耗时与位移）、`hover.render`（滚 10 格期间的重渲染次数）；埋点只在开发开关或高频采样下启用，不常态刷日志 — 验证：单测断言格式化输出；真机 `grep "\[pi-agent\] perf" idea.log` 能看到两个事件名且 `hover.render` 计数为 0
- [x] **T412** [US2][US3] mock 支持「推送一条新消息」以便断言吸底行为（若已有能力则复用，不新增开关）— 验证：`bridge/mock.test.ts` 通过；e2e 两条吸底用例依赖它
- [x] **T413** [US1] 修订既有 e2e：`data-active` 若被断言为「跟随 hover」，改为「跟随键盘」；新增「悬停 + Enter 选中悬停项」用例 — 验证：`e2e/model-picker.spec.ts` 全绿、用例数不减，逐条记录改了哪两条
- [x] **T414** 全量基线 + 文档 + 真机：`npm run typecheck` / `npx vitest run` / `npx playwright test`；`CHANGELOG.md` 0.5.7「修复」补一条（滚轮跟手、悬停不再卡）；`MANUAL_TEST.md` 增真机两条；记录 `scroll.frame` / `hover.render` 实测值 — 验证：逐条记录结果；真机结论写进 `specs/0.5.7-run-report.md`

## 待真机确认

1. **消息列表到底是 M1 还是 M2 主导**：先只做 T406/T407（吸底方向判定）再测一次；若「到底回滚」仍卡，说明 M2（OSR 光栅化）占大头，需要 T409/T410 一起上。
2. `content-visibility` 在本机 JCEF（JBR 2024.3 的 Chromium）下是否稳定：重点看滚动条抖动与跳转落点。
3. 悬停弱高亮 + 键盘强高亮同屏时的观感（plan 风险第 1 条）——是否要把 CSS hover 的色再调浅。
4. ~~用户提的「还有个性能问题」的具体场景~~ —— 已澄清即本 spec 的滚轮卡顿本身，不另立规格；US3/US4 即其度量口径。

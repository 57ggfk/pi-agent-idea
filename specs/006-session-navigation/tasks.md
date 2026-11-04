---
description: "Task list for 006-session-navigation"
---

# Tasks: 会话导航与检索

**Input**: Design documents from `/specs/006-session-navigation/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)

**Tests**: vitest（命中计算、目录派生）+ JUnit5（JSONL 扫描）+ playwright e2e（跳转、计数、高亮、跨会话）+ JCEF 真机（快捷键、高亮降级）。

**验证命令**：`cd web && npm test` / `npx playwright test e2e/session-navigation.spec.ts e2e/session-search.spec.ts`；
`./gradlew test`。

## Format: `[ID] [P?] [Story] Description — 验证：...`

- **US1** = 用户消息目录 / **US2** = 会话内搜索 / **US3** = 全会话搜索
- **[P]** = 可并行（不共享文件）

---

## Phase 1: 地基

- [ ] **T001** [地基] `web/src/lib/scrollToItem.ts`：按容器 `scrollTop` 计算目标位置、平滑滚动、
  `prefers-reduced-motion` 降级、2s 闪高亮类 — 验证：e2e 断言滚动后目标 `.item` 的
  `top - list.top` 在 0–24px 之间（顶部偏移生效），且 2.2s 后 `.flash-target` 类消失
- [ ] **T002** [地基] `MessageList.tsx` 给 `.item` 加 `data-item-id={item.id}` — 验证：e2e 能按
  `[data-item-id]` 定位到具体消息，既有用例不受影响（全量 e2e 绿）
- [ ] **T003** [P][地基] `web/src/lib/search.ts`：`hitsFromItems(items, query)` 纯函数 —
  验证：**先写** `search.test.ts`（同块多处命中、跨块、CJK、含 `(`/`*` 等正则字符按字面量、
  空查询返回空、大小写不敏感），红 → 绿

**Checkpoint**: 定位与命中计算可用，后续三个 US 共用。

---

## Phase 2: US1 用户消息目录

- [ ] **T004** [US1] `SessionOutline.tsx`：浮层列出 user 消息（`#n` + 单行摘要），
  `role=listbox/option`，点击 → `scrollToItem`；空会话不渲染入口 — 验证：e2e 30 条用户消息 →
  条目数 = 30、首条为最早、点第 3 条后目标在视口内；空会话 `outline-btn` 计数为 0
- [ ] **T005** [US1] 增量更新与当前项标记 — 验证：e2e 发送一条新消息后目录条数 +1（无需重开）；
  滚动到中部后当前项标记落在对应条目
- [ ] **T006** [US1] 几何：360/430/900 三档浮层 rect 在 `.app` 内、无横向溢出、不遮住输入框
  — 验证：e2e 四边界断言 + `composer` 顶部不被覆盖
- [ ] **T007** [US1] 图片消息与纯 system 会话的边界 — 验证：e2e 断言图片消息条目显示占位文案且可跳转

---

## Phase 3: US2 会话内搜索

- [ ] **T008** [US2] `SessionSearch.tsx` + store `search` 切片：🔍 按钮与 `Ctrl/Cmd+F` 打开同一实例，
  `preventDefault` 拦截默认查找 — 验证：e2e 两路打开后 `search-bar` 可见且输入框聚焦；
  断言页面未触发浏览器查找（无 `window.find` 调用痕迹则以输入焦点在搜索框为准）
- [ ] **T009** [US2] 计数与导航：`1/N` 显示、`Enter` 下一个、`Shift+Enter` 上一个、循环 — 验证：
  e2e 造 3 处 `timeout` → 连续 Enter 三次回到 `1/3`；`Esc` 后计数与高亮消失
- [ ] **T010** [US2] 高亮：`CSS.highlights` 主路径 + `getClientRects` 降级 — 验证：e2e 断言
  `CSS.highlights` 存在时 `size>0`；强制降级（mock `CSS.highlights` 为 undefined）后断言高亮层元素数 = 命中数
- [ ] **T011** [US2] 工具输出命中：命中的命令卡片自动展开 — 验证：e2e 搜索一段只在命令输出里的文本 →
  断言对应 `tool-card` 的 `aria-expanded=true` 且高亮可见
- [ ] **T012** [US2] 流式过程中搜索 — 验证：e2e 在流式未结束时搜新到达的词，计数随内容增长
- [ ] **T013** [US2] 搜索不破坏 markdown — 验证：e2e 断言代码块 `pre` 的 `scrollWidth === clientWidth`、
  列表项数不变、`doc.scrollWidth === doc.clientWidth`

---

## Phase 4: US3 全会话搜索（后端 + 桥接 + 页面）

- [ ] **T014** [P][US3] `session/SessionSearch.kt`：JSONL 扫描 + 片段 + `hitIndex` + 上限与超时 —
  验证：**先写** `SessionSearchTest`（`@TempDir` 造 3 个 jsonl）：① 命中 2 个会话；② 同会话 3 处 →
  `hitCount=3`、`hits` ≤2；③ 半行损坏 → 跳过不抛；④ 关键词含正则字符按字面量；⑤ 超时会话数 > 上限 → `truncated=true`
- [ ] **T015** [US3] `BridgeService.dispatch` 注册 `sessions.search`；`BridgeMethod` 加类型
  — 验证：`./gradlew test` 绿；`web/src/bridge/types.ts` 与 dispatch 白名单一一对应
- [ ] **T016** [US3] `mock.ts` 实现 `sessions.search`（在 mock 会话正文里搜）— 验证：
  `mock.test.ts` 新增用例，`npm test` 绿
- [ ] **T017** [US3] `SessionsView` 搜索框：≥2 字符防抖 250ms、结果排序与片段、`N hits`、
  请求竞态守卫 — 验证：e2e 输入 `uniq-token` → 命中会话排首位并显示片段；快速改词只呈现最后一次结果
- [ ] **T018** [US3] 点击命中 → 切会话 + 打开搜索并跳到第 `hitIndex` 个 — 验证：e2e 断言切到 Chat、
  `search-bar` 值为该关键词、计数为 `{hitIndex+1}/N`、目标消息滚入视口
- [ ] **T019** [US3] 空结果与超限提示 — 验证：e2e 断言 `0/0` 与「已扫描 N 个会话」文案（mock 返回 `truncated:true`）
- [ ] **T020** [US3] 会话切换重置 — 验证：vitest 断言 `switchSession` 后 `search.open === false` 且 `hits` 清空；
  e2e 断言切会话后无残留高亮

---

## Phase 5: 集成与收尾

- [ ] **T021** [集成] 全量回归 — 验证：`npm run typecheck && npm test && npx playwright test` 全绿；`./gradlew test` 全绿
- [ ] **T022** [集成] JCEF 真机：`Ctrl+F` 是否被 IDE 抢走、高亮在 JCEF 里可见、目录浮层不越界
  — 验证：结论写入 `specs/0.5.2-run-report.md`；若快捷键冲突则按 plan 风险项改用备用键并更新文案
- [ ] **T023** [收尾] `MANUAL_TEST.md` 新增「会话导航与搜索（v0.5.2）」段 6 条 — 验证：可勾选、判据明确

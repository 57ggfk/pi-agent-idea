---
description: "Task list for 010-ui-polish"
---

# Tasks: 界面细节打磨（气泡紧凑 / 空态居中 / 输入框自适应）

**Input**: Design documents from `/specs/010-ui-polish/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)

**Tests**: vitest（高度计算纯函数）+ playwright e2e（几何断言）+ JCEF 真机目视。

**验证命令**：单测 `cd web && npm test`；类型 `cd web && npm run typecheck`；
e2e `cd web && npx playwright test <file>`；真机 `powershell -ExecutionPolicy Bypass -File scripts\e2e-ide.ps1`。

## Format: `[ID] [P?] [Story] Description — 验证：...`

- **US1** = 气泡紧凑 / **US2** = 空态居中 / **US3** = 输入框自适应
- **[P]** = 可与其他任务并行（无共享文件）

---

## Phase 1: 基线与地基

- [x] **T001** [基线] 记录改动前实测值并写回 `plan.md` 表格：单行消息气泡高度、20 条消息首屏可见条数、
  空态图标中心与消息区中心的偏差、输入框注入 20 行后的高度 — 验证：`plan.md` 表格「现状」列填上实测数字与测量脚本名
- [x] **T002** [地基] 新增 `web/src/lib/autosize.ts`：导出 `composerMaxHeight(appEl)` 与 `autosize(ta, appEl)`；
  上限 `min(320, 0.45 * appHeight)`，下限取单行高度 — 验证：**先写** `web/src/lib/autosize.test.ts`
  （appHeight 300/600/1200 → 上限 135/270/320；scrollHeight 小于下限 → 返回下限），红 → 绿
- [x] **T003** [地基] `styles.css`：`.composer-input { max-height: var(--composer-max-h, 160px) }`；
  `--composer-max-h` 由 `Composer` 在挂载与 resize 时写到 `.app` 上 — 验证：e2e 断言
  `getComputedStyle(ta).maxHeight` 随视口高度变化（900px 窗口 ≠ 360px 窗口）

**Checkpoint**: 高度计算只有一处实现，CSS 与 JS 共用同一变量。

---

## Phase 2: US2 空态居中（先做，风险最低，附带修掉 padding 不对称）

- [x] **T004** [US2] `.message-col` 加 `min-height: 100%`；`.message-list` 垂直 padding 改为上下对称
  — 验证：e2e 在 300/600/900 三档断言 `.empty-logo` 中心与 `.message-list` 可见中心
  垂直偏差 ≤ 2px（300px 档 ≤ 4px）、水平偏差 ≤ 0.5px
- [x] **T005** [US2] 回归：有消息时布局不受影响 — 验证：e2e 断言 3 条消息时首条 `.item` 的
  `top - .message-list.top ≤ 24px`（没有被垂直居中顶下去），且 `doc.scrollWidth === doc.clientWidth`
- [ ] **T006** [US2] 真机复核 JCEF 内拉伸窗口 — 验证：`MANUAL_TEST.md` 新增判据
  「把工具窗从 360 拉到 1400px 高矮各一次，空态图标始终在消息区中心」；截图存档

---

## Phase 3: US1 气泡紧凑

- [x] **T007** [US1] `.item-user .item-body` padding `8px 12px` → `6px 10px`，`line-height: 1.45`；
  `.message-col` gap `20px` → `14px`（助手消息段落间距不动）— 验证：e2e 断言单行气泡高度 ≤ 32px，
  且与基线比值 ≤ 0.85（基线值来自 T001）
- [x] **T008** [US1] 长内容回归：5 行文本、含代码块、含图片的消息 — 验证：e2e 断言
  文字未裁切（`scrollHeight === clientHeight`）、代码块 `scrollWidth === clientWidth`、
  气泡右边界 ≤ `.message-col` 右边界
- [x] **T009** [US1] 首屏密度 — 验证：e2e 用 20 条固定消息 fixture，断言首屏可见 `.item` 条数
  比 T001 记录的基线增加 ≥15%
- [x] **T010** [US1] 修正因气泡变紧而失效的既有断言 — 验证：`npx playwright test` 全量绿；
  每条被修改的断言在提交信息里注明「基线变化，非回归」

---

## Phase 4: US3 输入框自适应

- [x] **T011** [US3] `Composer.tsx` 内收口：新增 `applyText(next, {caret})`，替换分散的 `setText`；
  所有写入路径（IDE 注入、引用、队列取回、编辑回填、`@` 补全、目录注入）写完后
  `requestAnimationFrame(() => autosize(ta, appRef))` — 验证：e2e 逐路径断言高度 > 单行高度
  （IDE 注入用 `store.setPendingPrompt` 触发；引用点 `act-quote`；`@` 用键盘选择）
- [x] **T012** [US3] 发送后回落单行；组合输入期间不回弹 — 验证：e2e 断言发送后 `ta.clientHeight`
  ≤ 单行高度 + 2px；组合态用 `dispatchEvent(new CompositionEvent("compositionstart"))` 后
  改高度不应变化
- [x] **T013** [US3] 上限行为：注入 200 行文本 — 验证：e2e 断言 textarea 高度 = 上限值、
  `scrollHeight > clientHeight`（内部滚动），且 `.message-list` 高度 ≥ 200px
- [x] **T014** [US3] 字体加载后重算 — 验证：e2e 里 `document.fonts.ready` 之后注入同一文本，
  两次高度差 ≤ 1px

---

## Phase 5: 集成与收尾

- [x] **T015** [集成] 全量回归 — 验证：`cd web && npm run typecheck && npm test && npx playwright test`
  全绿；`./gradlew test` 全绿；`./gradlew buildPlugin` 成功
- [ ] **T016** [集成] JCEF 真机：`scripts\e2e-ide.ps1`（mock pi）跑通既有用例，人工目视三条改动
  — 验证：`MANUAL_TEST.md` 三条判据勾选 + 截图
- [x] **T017** [收尾] `MANUAL_TEST.md` 新增「界面密度（v0.5.2）」段 3 条；CHANGELOG 由总收尾任务统一写
  — 验证：清单条目可勾选、每条含明确通过判据

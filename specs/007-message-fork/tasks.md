---
description: "Task list for 007-message-fork"
---

# Tasks: 消息级 Fork、底部 Fork 隐藏与确认框

**Input**: Design documents from `/specs/007-message-fork/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)

**Tests**: vitest（分支点解析、动作矩阵）+ playwright e2e（fork 结果序列、确认框交互与几何）+ JCEF 真机。

**验证命令**：`cd web && npm test` / `npm run typecheck` / `npx playwright test e2e/message-fork.spec.ts e2e/confirm.spec.ts`；
真机 `powershell -ExecutionPolicy Bypass -File scripts\e2e-ide.ps1`。

## Format: `[ID] [P?] [Story] Description — 验证：...`

- **US1** = 消息级 Fork / **US2** = 底部 Fork 隐藏 / **US3** = 统一确认框
- **[P]** = 可并行（不共享文件）

---

## Phase 1: 协议验证（阻塞项）

- [ ] **T001** [US1] 验证 `fork(entryId)` 的边界语义：对 `pi --mode rpc` 依序发
  `prompt` ×2 轮 → `get_fork_messages` → `fork{entryId = 第 2 条用户消息}` → `get_messages`，
  记录「新会话是否包含该 entry」；回应原文存 `specs/007-message-fork/fork-semantics.json`
  — 验证：文件里有三次响应的原始 JSON + 结论一句话写回 `plan.md` 的 V1 段落
- [ ] **T002** [US1] 验证 `clone` 是否复制队列与统计（`get_queue` / `get_stats` before/after）
  — 验证：结论写回 `plan.md` 的 V2 段落，并据此确定「末条回复 Fork」的实现路径

**Checkpoint**: V1/V2 有结论；若 V1 为「包含 entry」，则 US1 按 plan 方案 B 降级并在 T004 调整。

---

## Phase 2: 纯逻辑（先断言）

- [ ] **T003** [US1] `store/types.ts`：`MessageAction` 增加 `"fork"`；`actionsForItem` 仅对
  assistant + 会话空闲 + 存在前置用户消息时给出 fork；流式未完成时不给
  — 验证：**先写** `store/types.test.ts` 用例（assistant 中间条 → 含 fork；assistant 流式中 → 不含；
  user 条 → 不含；系统错误条 → 不含），红 → 绿
- [ ] **T004** [US1] `store/store.ts` 导出纯函数 `branchTargetFor(userCount)`（输入：目标 assistant 之前的
  用户消息条数；输出：`{ kind: "entry", index }` 或 `{ kind: "clone" }`），按 V1 结论实现
  — 验证：vitest 覆盖「中间回复 / 末条回复 / 无前置用户消息」三种输入
- [ ] **T005** [US1] `store` 增加 `forkAtItem(itemId)`：解析条目 → `fork`/`clone` → `syncAfterBranch()` →
  清理旧会话状态（`pendingPrompt`、`editing`、`composerResetSeq++`）— 验证：vitest 用 mock 桥驱动，
  断言调用序列（`get_fork_messages` → `fork` → `get_messages` → `sessions.list`）与状态清理

---

## Phase 3: mock 与 US1 UI

- [ ] **T006** [US1] `web/src/bridge/mock.ts`：`fork` 支持任意 entryId（新会话 = 该 entry 之前的消息，
  或按 V1 结论调整）；`clone` 复制完整 transcript 并自增会话计数 — 验证：`web/src/bridge/mock.test.ts`
  新增两条用例（中间分支 / 克隆），`npm test` 绿
- [ ] **T007** [US1] `MessageActions.tsx`：Fork 图标按钮（`icon="fork"`，`aria-label`「Fork from this reply」），
  `data-testid="act-fork"`；点击 → `forkAtItem(item.id)`（US3 落地后改走确认框）
  — 验证：e2e `message-fork.spec.ts`：4 轮对话悬停 A1 → 点 Fork → 新会话消息序列 = U1/A1，U2/A2 不在
- [ ] **T008** [US1] 末条回复 Fork 等价于整段复制 — 验证：e2e 断言 fork 后新会话消息数与条数、
  文本与旧会话逐条一致
- [ ] **T009** [US1] 失败与取消路径 — 验证：mock 返回 `cancelled: true` 时断言出现可见系统错误消息、
  视图未切换（`tab-chat` 仍激活、消息条数不变）
- [ ] **T010** [US1] 旧会话可切回且内容一致 — 验证：e2e fork 后进 Sessions，切回旧会话，
  断言消息条数与文本与 fork 前一致

---

## Phase 4: US2 底部 Fork 隐藏

- [ ] **T011** [US2] `Composer.tsx` 加 `SHOW_COMPOSER_FORK = false` 并按常量渲染（不用 CSS 隐藏）
  — 验证：e2e 断言 Chat 页 `fork-btn` 计数为 0，`compact-btn`/`new-session` 仍存在
- [ ] **T012** [US2] 控制栏密度回归 — 验证：e2e 在 360 / 430 / 900px 断言
  `.composer-controls` 单行（`scrollHeight` 容差 1px）、无横向溢出、`data-density` 与实际子节点宽度一致
- [ ] **T013** [US2] 修正依赖 `fork-btn` 的既有用例（`web/e2e/sessions.spec.ts` 里 fork 用例改走消息工具条）
  — 验证：`npx playwright test` 全量绿

---

## Phase 5: US3 统一确认框

- [ ] **T014** [US3] 新增 `web/src/components/ConfirmDialog.tsx` + store `confirm` 切片
  （`askConfirm` / `closeConfirm`），挂在 `App.tsx` 的 `.app` 内
  — 验证：e2e `confirm.spec.ts`：触发后 `role=dialog` 可见、`aria-modal=true`、标题含关键信息
- [ ] **T015** [US3] 键盘与焦点：Esc 取消、Enter 确认、Tab 在弹窗内循环、打开时焦点在主按钮
  — 验证：e2e 连续 Tab 5 次断言焦点始终在弹窗内（`dialog.contains(document.activeElement)`）
- [ ] **T016** [US3] 几何与拦截：360/430/900 三档弹窗 rect 在 `.app` 内、按钮单行、遮罩拦截点击与滚动
  — 验证：e2e 断言弹窗四边界、`document.body.scrollTop` 不变、点遮罩区域关闭
- [ ] **T017** [US3] 接入四个调用点：New（有内容或流式中）、Fork（消息级）、Fork（底部，保留能力）、
  删除会话；Sessions 与 Chat 均不再出现 `window.confirm` — 验证：e2e 监听 `page.on("dialog")`，
  触发四个动作后计数为 0；New 空会话不弹框（T018 覆盖）
- [ ] **T018** [US3] New 的三态文案：空闲有内容 / 流式中 / 空会话不弹 — 验证：e2e 断言流式态文案含
  「discarded」、空闲态不含、空会话点击后无 dialog

---

## Phase 6: 集成与收尾

- [ ] **T019** [集成] 全量回归 — 验证：`npm run typecheck && npm test && npx playwright test` 全绿；
  `./gradlew test` 全绿
- [ ] **T020** [集成] JCEF 真机：确认框渲染、消息工具条 hover、fork 后切回旧会话、360px 窄窗
  — 验证：`MANUAL_TEST.md`「Fork（v0.5.2）」段 4 条判据勾选
- [ ] **T021** [收尾] `MANUAL_TEST.md` 新增段；fork 已知限制（若走方案 B）写进该段说明
  — 验证：清单可勾选，限制有明确文案

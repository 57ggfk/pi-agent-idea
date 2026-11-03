---
description: "Task list for 005-message-copy-actions"
---

# Tasks: 消息级操作（复制 / 引用 / 重新生成 / 编辑重发）

**Input**: Design documents from `/specs/005-message-copy-actions/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)

**Tests**: vitest 单测（store 纯逻辑与编排）+ playwright e2e（行为与几何）+
真机冒烟（fork 时序）。

**Organization**: 按 user story 分组；US1/US2（P1）先于 US3/US4（P2）；
mock 桥协议作为地基先行（宪法 I：mock 与实现同步演进）。

## Format: `[ID] [P?] [Story] Description — 验证：...`

- **US1**= 一键复制 / **US2**= 引用到输入框 / **US3**= 重新生成 / **US4**= 编辑重发

**验证命令**：单测 `cd web && npm test`；类型 `cd web && npm run typecheck`；
e2e `cd web && npx playwright test <file>`。

---

## Phase 1: Foundational（mock 桥协议 + 共享 util）

- [x] **T001** [基建] `web/src/bridge/mock.ts`：`fork` 改为 pi 1.4.0 语义
  （响应 `{ text, cancelled }`，**不再返回 sessionPath/sessionId**；`text` 取
  最后一条 user 消息）；新增 `get_fork_messages`（返回 `[{entryId, text}]`，
  entryId 用自增字符串模拟）；`clone` 响应同步去掉 sessionPath。会话列表里
  fork 后新增一条分支条目 — 验证：`npm test` 绿；现有 e2e 套件全绿
  （`npx playwright test`，fork 相关的 sessions 用例如依赖旧语义则一并修正）
- [x] **T002** [基建] mock 增加可切换的重生成场景：同一 prompt 第二次发出时
  返回不同回复文本（模拟模型重新作答），供 US3 e2e 断言「新回复 ≠ 旧回复」
  — 验证：在 vitest 里直接驱动 mock 桥，断言两轮回复文本不同
- [x] **T003** [基建] 新增 `web/src/lib/clipboard.ts`：把 `Markdown.tsx` 的
  `copyText()`（含 JCEF `execCommand` 降级）原样抽出；`Markdown.tsx` 改为
  从此处导入 — 验证：`npx playwright test e2e/features.spec.ts` 中
  「code block copy」用例保持绿（行为不变的回归证明）

**Checkpoint**: mock 桥协议与真实 pi 1.4.0 对齐；clipboard util 就位。

---

## Phase 2: US1 + US2（P1，复制与引用）

- [x] **T004** [US1] `store/types.ts` 新增纯函数 `itemToMarkdownSource(item)`：
  text 块按顺序 `join("\n\n")`；忽略 thinking / toolcall / image；纯图片返回
  `null` — 验证：**先写** `store/types.test.ts` 用例（多块拼接 / 单块 / 空 /
  纯图片 → null），红 → 绿
- [x] **T005** [US1/US2] `store/types.ts` 新增适用矩阵纯函数
  `actionsForItem(item, ctx)`，`ctx = { isLastUser, isLastAssistant,
  isStreamingThis, sessionBusy, editing, hasText }`，返回可用动作集；矩阵格逐条
  对应 spec FR-001/002/007/008/009/010（流式中该条无工具条；错误消息可复制；
  纯图片无复制/引用；regenerate 仅最后一条 assistant 且会话空闲；edit 仅
  最后一条 user 且会话空闲；busy 或编辑在途时 regenerate/edit 互斥不可用）
  — 验证：**先写**矩阵全格单测（红 → 绿），用注释标注每格对应的 FR 编号
- [x] **T006** [US1/US2] 新组件 `web/src/components/MessageActions.tsx`：
  hover 消息时浮现按钮组（复制 / 引用），`aria-label` 齐备（FR-012），
  绝对定位于消息容器角部、不占布局流；`MessageList.tsx` 接线，复制成功后
  按钮 ✓ 反馈 ≥1s、失败可区分（FR-003/004）；引用点击 → `quoteToComposer`
  （下一步实现，本任务先接线 UI）— 验证：`npm run typecheck` 绿；
  手动 dev 页面悬停可见（截图脚本可选）
- [x] **T007** [US2] store 新增 `quoteToComposer(item)`：组装引用文本 →
  经 `pendingPrompt` 新模式 `mode: "quote"` 送达 Composer；Composer 消费时
  **追加**到现有草稿之后（不覆盖）、焦点入输入框、光标到末尾（FR-006）；
  `store.test.ts`（新）断言 quote 通路不丢草稿 — 验证：单测红 → 绿
- [x] **T008** [US1/US2] e2e `web/e2e/message-actions.spec.ts`（新）：
  ① 悬停 user/assistant 消息出现工具条、移开消失；② 复制 assistant 消息 →
  剪贴板内容 = Markdown 源逐字符（含代码块围栏）、不含 thinking 文本；
  ③ 复制 user 消息 → 原始文本含换行；④ ✓ 反馈出现且自动恢复；⑤ 错误消息
  可复制；⑥ 引用后输入框值 = 引用前缀 + 消息文本、焦点在输入框；⑦ 有草稿时
  引用追加不覆盖 — 验证：`npx playwright test e2e/message-actions.spec.ts` 绿
- [x] **T009** [US1/US2] 几何断言并入 `e2e/layout-regressions.spec.ts`：
  悬停态下工具条 rect 四边界 ⊆ `.app` rect；消息列表
  `scrollWidth === clientWidth`；hover 前后该消息 rect 无位移；最右/最下
  消息（user 气泡右对齐）的工具条不溢出 — 验证：几何 e2e 绿，且在窄面板
  viewport（复用现有回归用例的宽度档位）下同样绿

**Checkpoint**: P1 两个故事全绿，复制/引用可交付。

---

## Phase 3: US3 + US4（P2，会话分叉动作）

- [x] **T010** [US3] store 新增 `regenerate()`：guard（会话空闲 + 最后一条
  assistant，走 `actionsForItem` 矩阵）→ `get_fork_messages` 取最后 user 的
  entryId → `fork {entryId}` → 响应后**主动** `replayMessages()` +
  `get_state` 同步 sessionId → `prompt(text)` 原样重发；`cancelled: true`
  与 rpc error 各走 003 号规格的错误可见性路径；编排顺序在 `store.test.ts`
  用 mock bridge 断言（调用顺序 + fork 参数 + prompt 文本 = fork 返回文本）
  — 验证：单测红 → 绿
- [x] **T011** [US3] MessageActions 补「重新生成」按钮（仅矩阵允许时渲染，
  busy 时隐藏）+ e2e：点重新生成 → 旧 assistant 回复从列表消失、新回复
  流式出现且文本 ≠ 旧回复（T002 场景）；在途（流式中）时入口不再渲染；
  mock 下会话列表出现分支新条目 — 验证：
  `npx playwright test e2e/message-actions.spec.ts` 绿
- [x] **T012** [US4] store 新增 `beginEditMessage(item)` / `cancelEditMessage()`：
  guard 同矩阵 → fork → 返回 text 经 `pendingPrompt mode: "edit"` 覆盖填入
  Composer 并显示「Editing · Esc 取消」徽标；Esc / 取消后清空输入框且
  items 无任何变更；编辑态发送走既有 `send()`（消息替换由 pi 分支语义天然
  完成，UI 在流式结束后 replay 校准）；`store.test.ts` 断言编辑通路与取消
  无副作用 — 验证：单测红 → 绿
- [x] **T013** [US4] e2e：悬停最后一条 user 消息 → 编辑 → 输入框值 = 原文、
  徽标可见 → 改写后发送 → 该 user 消息显示新文本、其后的旧回复消失、新回复
  流式到达；Esc 取消后输入框清空、列表不变 — 验证：e2e 绿
- [x] **T014** [修复] `forkSession()` 对齐 pi 1.4.0（无 sessionPath/sessionId
  返回）：改为 fork 响应成功后 `replayMessages()` + `get_state` +
  `refreshSessions()`（与 `regenerate` 共用同一私有编排函数）；`switchSession`
  相关断言回归 — 验证：`npx playwright test e2e/sessions.spec.ts` 绿 +
  新增「Fork 后消息列表重建」断言

**Checkpoint**: 四个动作全绿；fork 流程与 pi 1.4.0 一致。

---

## Phase 4: 收尾

- [x] **T015** 全量回归：`cd web && npm test && npm run typecheck &&
  npx playwright test` 全绿；`./gradlew buildPlugin` 不受影响（Kotlin 零改动
  的证明）— 验证：四条命令退出码全 0
- [x] **T016** `MANUAL_TEST.md` 增补真机冒烟项：① 真实 pi 进程下重新生成
  （验证 `session_start` reason=fork 时序、会话列表新条目、旧会话文件仍在）；
  ② JCEF 内一键复制（异步剪贴板不可用时的降级通路）；③ 工具条在 IDE
  窄工具窗口下的观感与溢出；④ 编辑重发后 Sessions 视图分支条目符合预期
  — 验证：每项有「操作 + 通过判据」两列
- [x] **T017** CHANGELOG「未发布」段记录四个动作 + forkSession 兼容修复；
  注明「重新生成/编辑重发会产生新会话文件（pi 分支语义），旧会话保留可切回」
  — 验证：CHANGELOG 段落含上述说明且格式与既有条目一致

**Checkpoint**: 可发版。

---

## 实现记录（2026-11-03，T001–T005）

Phase 1 全部完成 + Phase 2 的纯逻辑部分；**未动任何 UI**。

| 项 | 落地内容 |
|---|---|
| T001 | `bridge/mock.ts` 新增 `history` / `forkEntries`；`fork` 改 pi 1.4.0 语义（响应 `{text, cancelled}`，分支点 = 该 user entry 之前）；`clone` 响应去掉 `sessionPath`；新增 `get_fork_messages` 与 `get_messages`；`new_session` / `switch_session` 清空分支 |
| T002 | 同一 prompt 第二次发送返回 `Regenerated answer, take 2.` 前缀，围栏代码块照旧保留（代码块复制用例仍绿） |
| T003 | 新增 `web/src/lib/clipboard.ts`：`copyText(): Promise<boolean>`（JCEF `execCommand` 降级）；`Markdown.tsx` 改为导入，代码块复制行为不变 |
| T004 | `store/types.ts` `itemToMarkdownSource()`：text 块按序 `\n\n` 拼接、单块原样返回；忽略 thinking / toolcall / image；纯图片返回 `null` |
| T005 | `store/types.ts` `actionsForItem()` + `ActionContext` + `itemHasText()`；矩阵单测逐格对应 FR-001/002/007/008/009/010/013 |

**顺带修复（原属 T014，被 T001 逼出来的）**：`forkSession()` / `cloneSession()` 原本靠响应里的
`sessionPath` / `sessionId` 换会话，pi 1.4.0 两者都不返回——真机上 Fork 是静默失效的。
现统一走 `syncAfterBranch()`：`replayMessages` + `get_state` + `refreshSessions` + `refreshStats`；
`forkSession` 另补「先 `get_fork_messages` 取最后一条 entryId」，此前不带 id 的 `fork` 在真机会被拒。
T014 只剩「Fork 后消息列表重建」的 e2e 断言未补。

**验证**
- `cd web && npm run typecheck` → 0 error
- `cd web && npm test` → 47 passed（`types.test.ts` 44 + `bridge/mock.test.ts` 3）
- `cd web && npx playwright test` → 55 passed（含 sessions 的 clone/fork、features 的代码块复制）

**与 tasks 文字的偏差**：T005 的 ctx 列了 `hasText`，实现改为从 item 派生（`itemHasText`）——
同一事实保留两个来源正是按钮逻辑漂移的起点；矩阵语义不变。

**断言先行说明**：单测与实现同批落地，未逐条留存红灯证据；矩阵用例按 FR 编号分条，
可用「让 `itemHasText` 恒为 true」这类最小改动反向确认用例确实在守行为。

**未做（后续任务）**：`MessageActions.tsx`、`quoteToComposer` / `regenerate` / `beginEditMessage`、
Composer 的 quote / edit 模式、e2e 行为与几何断言、CHANGELOG 与版本号（发版时一并处理，避免写出与实现不符的 What's New）。

---

## 实现记录（2026-11-03，T006–T017）

Phase 2 剩余、Phase 3 全部与收尾。**Kotlin 侧零改动**（`./gradlew buildPlugin` 通过即为证）。

| 项 | 落地内容 |
|---|---|
| T006 | 新增 `components/MessageActions.tsx`：`actions` 由矩阵传入，组件只负责外观与动作，**不再做任何"该不该显示"的判断**；复制成功 `data-state="ok"`（✓ 图标）1.2s 后回 `idle`，失败 `fail`（✗ + `aria-label="Copy failed"`）；每个按钮都有 `aria-label`（FR-012）。`MessageList.tsx` 逐条传 `actionsForItem(item, ctx)` |
| T007 | store 新增 `quoteToComposer()`；`pendingPrompt` 加 `mode: "replace" \| "quote" \| "edit"`；`types.ts` 新增纯函数 `quoteMarkdownSource()`（逐行 `> ` 前缀，空行只留 `>`，围栏不转义）。Composer 按 mode 决定覆盖还是追加，追加前先 `trimEnd()` 再以 `\n\n` 连接 |
| T008 | 新增 `e2e/message-actions.spec.ts`（12 例）：悬停出现/移开消失、Markdown 源复制（含围栏、不含 thinking）、user 原文换行、错误条目可复制、引用预填/追加、重生成、流式中无入口、busy 时入口消失、编辑回填+重发、编辑仅最后一条、Esc 取消无副作用 |
| T009 | `e2e/layout-regressions.spec.ts` 新增 #8（360/680/900px × user+assistant）：工具条四边界 ⊆ `.app`、`.message-list` 无横向溢出、hover 前后该消息 rect 不动 |
| T010 | store 新增 `regenerate()`：guard → `get_fork_messages` 取最后一条 → `fork{entryId}` → `syncAfterBranch()` → 原样重发 fork 返回的 text；`cancelled` 与 rpc error 各走可见错误 |
| T011 | MessageActions 的「重新生成」按矩阵渲染；e2e 断言新回复带 `Regenerated answer, take 2`（T002 场景），流式中入口不存在 |
| T012 | store 新增 `beginEditMessage()` / `cancelEditMessage()` / `sendEdited()`；Composer 显示 `edit-mode-note` 徽标与 Esc 按钮，Esc 清空并不发任何 RPC |
| T013 | e2e 断言：回填原文、徽标可见、改后发送 → 旧 prompt 在全页消失、新回复回显新 prompt；Esc 后列表与消息数不变 |
| T014 | 补 `sessions.spec.ts` 的「Fork 后消息列表重建」：fork 后空态出现、`item-user` 归零、Sessions 出现分支条目 |
| T015 | 见下方验证 |
| T016 | `MANUAL_TEST.md` 新增「消息操作（v0.5.1 新增）」段：9 条，每条「操作 → 通过判据」 |
| T017 | `CHANGELOG.md` 新增 `## 未发布` 段（中英对齐），说明分支语义与旧会话保留 |

**与 tasks 文字的偏差（T012，重要）**：T012 写的是「guard → fork → 返回 text 填 Composer」，
但 spec US4 场景 3 要求「放弃编辑后对消息列表无任何变更」。若在**点编辑时**就 fork，放弃时
pi 侧历史已经被改写，UI 再回放就补不回来了。实现改为：`beginEditMessage()` 只解析 `entryId`
（`get_fork_messages`，零副作用）并把原文填进输入框；**fork 推迟到发送**（`sendEdited()`）。
代价是失败反馈从"点编辑时"延后到"发送时"，换来 cancel 真正无副作用。

**为跑 e2e 新增的 mock 表面**：`?fail=prompt` 让第一次 prompt 失败。此前 UI 里没有任何办法
产生 `item-error`，而 003 号规格的核心正是"失败要可见可复制"。

**踩到的两个坑（写进这里是给下一个人省时间）**
1. `await expect(status-dot).not.toHaveClass(/busy/)` 是**立即成立**的——点击发送后、
   `agent_start` 到达前，dot 本来就不 busy。等待"运行结束"必须先断言 busy 再断言 not busy，
   否则所有后续断言都在和流式赛跑（第一版 9 个 e2e 全挂在这上面）。
2. Windows 剪贴板拿到的是 CRLF，源码是 LF。复制断言必须 `replace(/\r\n/g, "\n")` 归一化，
   否则逐字符断言会以一个不可见字符之差失败。

**验证**
- `cd web && npm run typecheck` → 0 error
- `cd web && npm test` → 60 passed（types 48 + store 9 + mock 3）
- `cd web && npx playwright test` → **70 passed**（含新增 12 例消息操作、3×2 例几何、fork 重建）
- `./gradlew buildPlugin` → 成功（仅 IDE 自身的 Alarm/JCEF headless WARN）

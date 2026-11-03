---
description: "Task list for 003-error-visibility"
---

# Tasks: 静默失败可见化

**Input**: Design documents from `/specs/003-error-visibility/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)

**Tests**: 包含（宪法第 II 条）。状态机是纯函数，Vitest 覆盖率应达 100%。

**Organization**: 按 user story 分组。

## Format: `[ID] [P?] [Story] Description — 验证：...`

- **US1**= 三态可见 / **US2**= 就地重试与自动恢复 / **US3**= 列表失效 / **US4**= 诊断视图

---

## Phase 1: Foundational

- [x] **T001** 新增 `web/src/store/sources.ts`：`SourceStatus` / `SourceState` / `setSource` / `classify` / `truncate`
  （200 字符）/ `maskSecrets` — 验证：`sources.test.ts` 覆盖 classify 的 unsupported 与 failed 分支
- [x] **T002** 新增纯函数 `loadSource(id, fetcher)` 的 reducer 部分（不依赖 store 实例，便于单测）— 验证：
  单测断言 idle→loading→ready、loading→failed、inflight 时二次调用直接返回
- [x] **T003** `store.ts` 接入 `sources` 切片（不改业务逻辑，先并行存在）— 验证：`tsc --noEmit` + 现有 Vitest 全绿
- [x] **T004** [P] `web/src/bridge/mock.ts` 加 `?fail=files|commands|models|policy` 开关 — 验证：Vitest 可触发单源失败

**Checkpoint**: 状态机可用，原有行为未变。

---

## Phase 2: US1 — 三态可见（P1）

- [x] **T005** [US1] `Composer.tsx` 的 `@` 菜单改为按 `sources.files.status` 渲染四态 — 验证：Playwright 断言
  `data-state="failed"` 时文案含「加载失败」且不出现「No matching files」
- [x] **T006** [US1] `/` 菜单同理按 `sources.commands.status` 渲染 — 验证：同上，独立断言
- [x] **T007** [US1] 加载中态：菜单显示「正在加载…」，不与「为空」共用文案 — 验证：断言 `data-state="loading"` 文案
- [x] **T008** [US1] 错误摘要截断 ≤ 200 字符，超长时以省略号结尾 — 验证：单测 `truncate` + e2e 断言长度

---

## Phase 3: US2 — 重试与自动恢复（P1）

- [x] **T009** [US2] 失败态渲染 [重试] 按钮，点击调 `loadSource` 重拉 — 验证：Playwright 断言点击后进入 loading 再变 ready
- [x] **T010** [US2] in-flight 去重：请求进行中按钮 disabled，连点只发一次 — 验证：mock 计数断言只请求 1 次
- [x] **T011** [US2] 二次失败保留错误态、更新文案、不弹窗 — 验证：断言无 dialog，文案更新
- [x] **T012** [US2] `pi-state` 变 `running` 时遍历 `failed` 且 `retries < 5` 的源自动补拉 — 验证：单测断言只补 failed、不碰 ready
- [x] **T013** [US2] 迁移 `store.init()` 的 models / thinkingLevels / policy / prefs / sessions / stats 六处静默 catch 到 `loadSource`
  — 验证：逐源迁移后跑全量 e2e，无回归

---

## Phase 4: US3 — 列表失效（P2）

- [x] **T014** [US3] 前端记 `filesLoadedAt`；打开 `@` 菜单时超 30s 自动重拉 — 验证：单测注入时间戳，断言是否触发
- [x] **T015** [US3] 菜单内提供手动刷新入口，强制重拉并重置时间戳 — 验证：Playwright 断言刷新后新文件出现
- [x] **T016** [US3] 删除文件后重新拉取不再出现该文件 — 验证：mock 改文件列表后刷新，断言旧项消失

---

## Phase 5: US4 — 诊断视图（P2）

- [x] **T017** [US4] 新增 `web/src/components/manage/DiagnosticsPanel.tsx`：逐源状态徽标 + 摘要 + 展开全文 + [重试] — 验证：
  Playwright 断言 8 个源都出现，失败源有 [重试]
- [x] **T018** [US4] `ManageView.tsx` 加第 6 分区「诊断」入口 — 验证：断言导航项存在且可切换
- [x] **T019** [US4] 全部 ready 时显示「全部正常」单行；区分 `idle`（未加载）与 `failed` — 验证：断言三种聚合文案
- [x] **T020** [US4] 展示前对错误文本做掩码（`sk-*`、`Bearer *`、`apiKey":"..."`）— 验证：单测 `maskSecrets` 三类样本

---

## Phase 6: Polish

- [x] **T021** [P] `npx vitest run` + `npx playwright test` 全绿，现有 51 条不回归 — 验证：用例计数
- [x] **T022** [P] `tsc --noEmit` + `./gradlew compileKotlin` — 验证：退出码 0
- [x] **T023** CHANGELOG 补：静默失败可见化（修复）+ 文件列表失效（修复）
- [ ] **T024** 真机验证：断网触发一次失败，确认菜单显示错误与重试，恢复网络后点重试成功 — 验证：截图留档

## 依赖关系

```
T001,T002 ──→ T003 ──┬─ T005..T008 (US1)
                     ├─ T009..T013 (US2)
                     ├─ T014..T016 (US3)   ← 仅依赖 T001 的状态机
                     └─ T017..T020 (US4)
T004 独立（mock 开关）
```

US3 与 US4 可并行；US2 的 T013 建议最后做（迁移面最大）。

## 总计

24 个 task：Foundational 4 + US1 4 + US2 5 + US3 3 + US4 4 + Polish 4。

---

## 实现记录（2026-11-03，T001–T023）

分支 `003-error-visibility`（从 `005-message-copy-actions` 的 tip 上叠，两个 spec 一起进同一个版本）。
**Kotlin 侧零改动**：全部是前端状态管理与文案。

| 项 | 落地内容 |
|---|---|
| T001 | 新增 `web/src/store/sources.ts`：`SourceId`（8 个）/`SourceStatus`/`SourceState`/`classifyFailure`/`truncate`（200）/`maskSecrets`；`SOURCE_IDS` 与 `SOURCE_LABELS` 同时充当诊断视图的顺序来源 |
| T002 | 同文件的纯 reducer：`beginLoad`/`resolveLoad`/`rejectLoad`，外加 `needsRefresh`/`failedForAutoRetry`/`summarize`/`summarizeState`；全部不依赖 store 实例 |
| T003 | `store.ts` 增加 `sources` 切片 + `loadSource(id, fetcher)` + `retrySource(id)` + `retryFailedSources()` + `loadFiles()`；`sourceLoaders` 记住每个源的最后一个 fetcher，重试不必让调用方重写闭包 |
| T004 | `mock.ts` 加 `?fail=<name>[:count]`（失败预算，用完即成功）、`?slow=<name>:ms`、`?unsupported=<name>`、`?files=volatile`、`?pistate=1`、`?longerror=1`；`request()` 统一走 `gate()`，`rpc.request` 按 command 类型映射 |
| T005/T006 | `Composer.tsx` 两个菜单改为四态渲染（list / loading / failed / empty），共用 `MenuNotice`；`unsupported` 时不渲染该菜单 |
| T007 | 加载中单独一态（「Loading files…」），与 empty 文案、testid 均不同 |
| T008 | 菜单只显示 ≤200 字摘要并以 `…` 结尾，全文仅诊断视图可见（`diag-details-*` 的 `<pre>`） |
| T009 | failed 态渲染 Retry，重试用 `retrySource`；按钮在 inflight 时 disabled |
| T010 | in-flight 去重放在 `loadSource` 里（第二次调用直接返回 undefined），单测用挂起 Promise 断言 fetcher 只被调用一次 |
| T011 | 二次失败仍是 failed 态、文案更新、无 `dialog`；e2e 显式断言 `page.locator("dialog")` 为 0 |
| T012 | `refreshMeta()` 改为 `retryFailedSources()` + 「ready 但为空」的元数据源补拉；`failedForAutoRetry` 只挑 failed、非 inflight、`retries < 5` |
| T013 | init() 的 models / thinkingLevels / policy / prefs 与 refreshCommands / refreshStats / refreshSessions 七处静默 catch 全部迁到 `loadSource`；另加 `files`（原本在 Composer 里用模块级变量缓存） |
| T014 | `files` 移入 store，打开 `@` 时按 `needsRefresh(30s TTL)` 决定是否重读 |
| T015 | 菜单底部常驻 `↻ Refresh`（不再只在空态出现），强制重拉并刷新时间戳 |
| T016 | `?files=volatile` 让第二次读少一个文件，e2e 断言刷新后该项消失 |
| T017 | 新增 `components/manage/DiagnosticsPanel.tsx`：8 行状态 + 摘要 + 可展开全文 + 单独 Retry；沿用现有 `.panel-row` 版式 |
| T018 | `ManageView` 新增第 6 个分区 Diagnostics |
| T019 | 聚合文案按最坏状态选：`All good` / `N sources not loaded yet` / `Loading…` / `N sources failing`；idle 与 failed 不共用措辞 |
| T020 | `maskSecrets` 覆盖 `sk-*`、`Bearer *`、`key=value`/`"apiKey":"…"` 三类，单测各一例 + 一条「普通文案不被误伤」 |
| T021 | `npm test` 91 passed（sources 26 + types 48 + store 14 + mock 3）；`npx playwright test` 83 passed |
| T022 | `tsc --noEmit` 0 error；`./gradlew compileKotlin` 通过 |
| T023 | CHANGELOG「未发布」段补 Diagnostics（新增）与两条静默失败修复；MANUAL_TEST 新增「静默失败可见化」10 条 |

### 与 plan 的偏差（两处，都是有意的）

1. **`needsRefresh` 对 `failed` 返回 false**。plan 写的是「never attempted / failed → yes」，但一打开菜单就自动重试会让失败态一闪而过或干脆自愈，
   而 spec US1 的 Independent Test 明确要求「让 files.list 失败一次 → 打开 `@` → **看到**加载失败与重试」。
   失败恢复只留两条路：用户点 Retry，或 FR-005 的 pi 进入 running 自动补拉。单测里专门有一条守这个语义。
2. **`ActionContext` 那类「hasText」的教训沿用**：`Composer` 不再自己维护 files 缓存，四态全部由 `sources.files` 派生，避免两份状态漂移。

### 两个实现上的坑

1. **`file-menu-empty` 的 testid 必须保留**：既有的 `layout-regressions` 有一条「无匹配也要说出来」的用例按这个 id 断言，
   所以四态重构时把 empty 沿用原名，failed/loading 才是新 id。
2. **mock 默认不发 `pi-state`**：否则 `?fail=x` 会被自动恢复在断言前治好。真实桥接会发，mock 用 `?pistate=1` 显式打开，
   这样「自动恢复」（FR-005）与「失败态可见」（US1）两条用例才都稳定。

### 已知未做

- **T024 真机验证**留空：需要断网 / 停 pi 的人手操作，判据已写进 `MANUAL_TEST.md`。
- Diagnostics 没有「一键全部重试」，规格未要求，且 8 个源全红的场景下逐个点更可控。

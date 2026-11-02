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

- [ ] **T001** 新增 `web/src/store/sources.ts`：`SourceStatus` / `SourceState` / `setSource` / `classify` / `truncate`
  （200 字符）/ `maskSecrets` — 验证：`sources.test.ts` 覆盖 classify 的 unsupported 与 failed 分支
- [ ] **T002** 新增纯函数 `loadSource(id, fetcher)` 的 reducer 部分（不依赖 store 实例，便于单测）— 验证：
  单测断言 idle→loading→ready、loading→failed、inflight 时二次调用直接返回
- [ ] **T003** `store.ts` 接入 `sources` 切片（不改业务逻辑，先并行存在）— 验证：`tsc --noEmit` + 现有 Vitest 全绿
- [ ] **T004** [P] `web/src/bridge/mock.ts` 加 `?fail=files|commands|models|policy` 开关 — 验证：Vitest 可触发单源失败

**Checkpoint**: 状态机可用，原有行为未变。

---

## Phase 2: US1 — 三态可见（P1）

- [ ] **T005** [US1] `Composer.tsx` 的 `@` 菜单改为按 `sources.files.status` 渲染四态 — 验证：Playwright 断言
  `data-state="failed"` 时文案含「加载失败」且不出现「No matching files」
- [ ] **T006** [US1] `/` 菜单同理按 `sources.commands.status` 渲染 — 验证：同上，独立断言
- [ ] **T007** [US1] 加载中态：菜单显示「正在加载…」，不与「为空」共用文案 — 验证：断言 `data-state="loading"` 文案
- [ ] **T008** [US1] 错误摘要截断 ≤ 200 字符，超长时以省略号结尾 — 验证：单测 `truncate` + e2e 断言长度

---

## Phase 3: US2 — 重试与自动恢复（P1）

- [ ] **T009** [US2] 失败态渲染 [重试] 按钮，点击调 `loadSource` 重拉 — 验证：Playwright 断言点击后进入 loading 再变 ready
- [ ] **T010** [US2] in-flight 去重：请求进行中按钮 disabled，连点只发一次 — 验证：mock 计数断言只请求 1 次
- [ ] **T011** [US2] 二次失败保留错误态、更新文案、不弹窗 — 验证：断言无 dialog，文案更新
- [ ] **T012** [US2] `pi-state` 变 `running` 时遍历 `failed` 且 `retries < 5` 的源自动补拉 — 验证：单测断言只补 failed、不碰 ready
- [ ] **T013** [US2] 迁移 `store.init()` 的 models / thinkingLevels / policy / prefs / sessions / stats 六处静默 catch 到 `loadSource`
  — 验证：逐源迁移后跑全量 e2e，无回归

---

## Phase 4: US3 — 列表失效（P2）

- [ ] **T014** [US3] 前端记 `filesLoadedAt`；打开 `@` 菜单时超 30s 自动重拉 — 验证：单测注入时间戳，断言是否触发
- [ ] **T015** [US3] 菜单内提供手动刷新入口，强制重拉并重置时间戳 — 验证：Playwright 断言刷新后新文件出现
- [ ] **T016** [US3] 删除文件后重新拉取不再出现该文件 — 验证：mock 改文件列表后刷新，断言旧项消失

---

## Phase 5: US4 — 诊断视图（P2）

- [ ] **T017** [US4] 新增 `web/src/components/manage/DiagnosticsPanel.tsx`：逐源状态徽标 + 摘要 + 展开全文 + [重试] — 验证：
  Playwright 断言 8 个源都出现，失败源有 [重试]
- [ ] **T018** [US4] `ManageView.tsx` 加第 6 分区「诊断」入口 — 验证：断言导航项存在且可切换
- [ ] **T019** [US4] 全部 ready 时显示「全部正常」单行；区分 `idle`（未加载）与 `failed` — 验证：断言三种聚合文案
- [ ] **T020** [US4] 展示前对错误文本做掩码（`sk-*`、`Bearer *`、`apiKey":"..."`）— 验证：单测 `maskSecrets` 三类样本

---

## Phase 6: Polish

- [ ] **T021** [P] `npx vitest run` + `npx playwright test` 全绿，现有 51 条不回归 — 验证：用例计数
- [ ] **T022** [P] `tsc --noEmit` + `./gradlew compileKotlin` — 验证：退出码 0
- [ ] **T023** CHANGELOG 补：静默失败可见化（修复）+ 文件列表失效（修复）
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

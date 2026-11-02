---
description: "Task list for 004-action-coverage"
---

# Tasks: IDE 侧动作的自动化覆盖

**Input**: Design documents from `/specs/004-action-coverage/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)

**Tests**: 本规格的产出物**就是**测试，无额外测试任务。

**Organization**: 按 user story 分组。

## Format: `[ID] [P?] [Story] Description — 验证：...`

- **US1**= 注册覆盖 / **US2**= 可用性覆盖 / **US3**= 内容拼装覆盖 / **US4**= 冒烟清单

---

## Phase 1: Foundational

- [ ] **T001** `build.gradle.kts` 的 `dependencies.intellijPlatform` 加 `testFramework(TestFrameworkType.Platform)`；
  确认 `BasePlatformTestCase` 可解析 — 验证：写一个空 `BasePlatformTestCase` 子类能跑过
- [ ] **T002** 若 T001 后仍不可解析，改用 `LightPlatformTestCase` + 手写 `ApplicationManager` 引导；
  并把结论写进 plan 的「关键技术决策 1」— 验证：`./gradlew test` 能执行平台测试
- [ ] **T003** 测试隔离：统一设置 `PI_CODING_AGENT_DIR` 指向临时目录，避免污染真实 `~/.pi` — 验证：
  跑完测试后 `~/.pi/agent` 无新增文件
- [ ] **T004** 新增 `src/test/kotlin/dev/pi/agent/editor/PiActionsRegistrationTest.kt` 骨架 +
  `declaredActions()` 工具函数（递归遍历描述符 `<actions>`）— 验证：能打印出当前 5 个动作 id

**Checkpoint**: 平台测试可运行。

---

## Phase 2: US1 — 注册覆盖（P1）

- [ ] **T005** [US1] 断言 4 个 action 的 id 都能被 `ActionManager` 查到：
  `PiAgent.SendFile` / `PiAgent.ExplainFile` / `PiAgent.SendSelection` / `PiAgent.GenerateCommitMessage`
  — 验证：把其中一个 id 改错后测试必定失败
- [ ] **T006** [US1] 断言菜单分组：`PiAgent.FilePopup`、`PiAgent.EditorPopup`、`PiAgent.CommitActions` 三个 group
  存在，且 `getChildren(null)` 包含对应动作 — 验证：把 group id 拼错后测试失败
- [ ] **T007** [US1] 清单漂移双向比对：`declaredActions()` 与硬编码 expected 集合 `assertEquals`，
  失败信息打印差集 — 验证：临时加一个未登记动作，断言测试失败且信息含该 id
- [ ] **T008** [US1] 反向回归用例：断言所有 action/group 节点都不在 `<extensions>` 下
  （直接扫 XML，模拟历史上的事故）— 验证：手工把节点移回 `<extensions>`，断言测试失败

---

## Phase 3: US2 — 可用性覆盖（P1）

- [ ] **T009** [US2] 新增 `PiEditorActionsUpdateTest.kt` + `ctx()` 夹具（`SimpleDataContext.builder()`）— 验证：
  一个最小用例能构造 event 并调 `update()`
- [ ] **T010** [US2] 覆盖矩阵第 1–3 行：有 editor / 仅 VIRTUAL_FILE / 仅 VIRTUAL_FILE_ARRAY 时三个动作可用
  — 验证：第 3 行是历史 bug 的回归用例，删掉 `selectedVirtualFile` 的数组分支后必须失败
- [ ] **T011** [US2] 覆盖矩阵第 4–6 行：目录 / 二进制 / > 256KB 时不可用，且 `presentation.description`
  分别含对应原因文案 — 验证：断言 description 非空且匹配关键字
- [ ] **T012** [US2] 覆盖矩阵第 7 行：空 DataContext（无 project）不可用且不抛异常 — 验证：`assertDoesNotThrow`
- [ ] **T013** [US2] `ExplainFileWithPi` 专项：无 editor 时可用（历史 bug 的回归用例）— 验证：只给 VIRTUAL_FILE，
  断言 enabled 为 true

---

## Phase 4: US3 — 内容拼装覆盖（P2）

- [ ] **T014** [US3] 从 `PiEditorActions.kt` 抽出 `PiActionPayload`（`fileMessage` / `selectionMessage` /
  `explainMessage`），action 改为调用它 — 验证：`compileKotlin` 通过，且行为不变（对照一次真机或 e2e）
- [ ] **T015** [US3] `PiActionPayloadTest.kt`：`fileMessage` 含项目相对路径 + 原文 — 验证：断言路径出现在输出中
- [ ] **T016** [US3] `selectionMessage` 含 `路径:行号` 形式 — 验证：断言输出匹配 `:\d+`
- [ ] **T017** [US3] `explainMessage` 在 `line == null` 时**不得**出现任何行号片段 — 验证：正则断言无 `:\d+`

---

## Phase 5: US4 — 冒烟清单（P2）

- [ ] **T018** [US4] 新增 `docs/SMOKE_TEST.md`，8 项，三列（操作 / 通过判据 / 可否自动化）；
  图标渲染项标注「不可自动化：New UI 的 toStrokeIcon 行为无法断言」— 验证：人工核对每项都有判据
- [ ] **T019** [US4] `MANUAL_TEST.md` 顶部加一条指向 `SMOKE_TEST.md`，说明两者分工
  （手工验收清单 vs 发布前最小冒烟）— 验证：链接可达
- [ ] **T020** [US4] 在 CHANGELOG「未发布」记录：首次为 IDE 侧动作补齐注册/可用性/内容三层自动化

---

## Phase 6: Polish

- [ ] **T021** [P] `./gradlew test` 全绿，新增用例 ≥ 25 条 — 验证：测试报告计数
- [ ] **T022** [P] `./gradlew verifyPlugin` 与 `buildPlugin` 不受影响 — 验证：退出码 0
- [ ] **T023** 故意注入两处错误（动作移出 `<actions>`、去掉数组回退）验证测试真的会红 — 验证：
  两次注入后 `./gradlew test` 均失败，恢复后转绿

## 依赖关系

```
T001 → T002 → T003 → T004 ──┬─ T005..T008 (US1)
                            └─ T009..T013 (US2)
T014 ──→ T015..T017 (US3)   ← 独立于平台夹具，可并行
T018..T020 (US4)            ← 独立
T021 依赖全部
```

T014–T017（纯函数）可在 US1/US2 之前先做完，风险最低、收益立现。

## 总计

23 个 task：Foundational 4 + US1 4 + US2 5 + US3 4 + US4 3 + Polish 3。

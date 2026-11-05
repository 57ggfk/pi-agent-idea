---
description: "Task list for 009-ide-integration"
---

# Tasks: IDE 集成修复与增强

**Input**: Design documents from `/specs/009-ide-integration/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)

**Tests**: JUnit5（判定矩阵、目录遍历、事件→路径推导）+ 真机矩阵（右键菜单无自动化手段）。

**验证命令**：`./gradlew test`；`./gradlew buildPlugin`；
真机 `powershell -ExecutionPolicy Bypass -File scripts\e2e-ide.ps1`（装插件后按 `MANUAL_TEST.md` 勾选）。

## Format: `[ID] [P?] [Story] Description — 验证：...`

- **US1** = 分组图标 / **US2** = 子菜单可用性 / **US3** = 添加目录 / **US4** = 文件刷新
- **[P]** = 可并行（不共享文件）

---

## Phase 1: 根因复核（阻塞 US2）

- [x] **T001** [US2] 真机复核「整片灰」：分别在**文件**、**目录**、**项目根**上右键，记录每格可用状态与
  `Help → Show Log` 里的相关输出 — 验证：结论写回 `plan.md`「顺序」第 1 条，并据此确认 D2 矩阵无需改
  （✅ 目录格两项全灰确认 + EDT 数据请求根因；文件/根格随 T009 后的沙箱轮补拍）
- [x] **T002** [US1] 确认分组图标渲染：`plugin.xml` 里两个 group 加 `icon="/icons/piAgent.svg"` 后启动沙箱
  — 验证：浅色/深色主题各截图一张，图标不糊、与相邻分组基线对齐

**Checkpoint**: 根因有结论；图标可用。

---

## Phase 2: 纯逻辑（先断言）

- [x] **T003** [US2] 新增 `editor/ActionAvailability.kt`：`TargetKind` + `availability(action, kind)`
  — 验证：**先写** `ActionAvailabilityTest`，覆盖矩阵 5 类目标 × 3 个动作（15 格），
  断言 `enabled` 与 `reason` 非空规则（禁用必有原因），红 → 绿
- [x] **T004** [P][US3] 新增 `editor/DirectoryListing.kt`：`listDirectory(root, projectRoot, limits)`
  — 验证：**先写** `DirectoryListingTest`（`@TempDir`）：① 12 个文件正常列出；② `build/`、`node_modules/`、
  `.git/` 被排除；③ 300 个文件 → 输出 200 条 + `omitted=100`；④ 15 层深目录 → `truncated=true`；
  ⑤ 无权限子目录被跳过而不抛异常
- [x] **T005** [P][US4] 新增 `bridge/VfsRefresh.kt` 的纯函数部分：
  `pathsForEvent(toolName, argsJson) → List<String>?`（null = 需要整体刷新）与 `shouldRefresh(toolName)`
  — 验证：**先写** `VfsRefreshTest`：`write{path}` → 该路径；`bash{command}` → null；
  `read{path}` → 空（不刷新）；`edit{file_path}` → 该路径

---

## Phase 3: US2 子菜单可用性

- [x] **T006** [US2] `PiEditorActions.kt`：`SendFileToPi` / `ExplainFileWithPi` 的 `update()` 改走
  `availability`，禁用原因写 `presentation.description` — 验证：`./gradlew test` 绿；
  真机矩阵（T010）逐格对照
- [x] **T007** [US2] `ExplainFileWithPi` 扩到目录与二进制：目录 → 「总结这个目录的结构与用途」+ 只送路径；
  二进制 → 只送路径 — 验证：单测覆盖 prompt 生成（抽 `explainPromptFor(kind, path)` 纯函数）；
  真机点一次看输入框文本
- [x] **T008** [US2] 多选与项目根：`selectedVirtualFile` 在多选时取首个；项目根按目录处理
  — 验证：真机多选 3 个文件右键，两项都可点并发出首个文件的 prompt

---

## Phase 4: US3 添加目录到 pi

- [x] **T009** [US3] `AddDirectoryToPi` 动作 + `plugin.xml` 注册（`PiAgent.FilePopup` 内，排在 Send 之前）
  + `Add Directory to Pi` 文案 — 验证：真机右键目录可见该动作
- [x] **T010** [US3] 动作执行：后台遍历 → `BridgeService.pushIdePrompt(...)` → 激活工具窗
  — 验证：对 `web/src/components` 执行，composer 收到目录路径 + 文件清单；对含 3000 文件的目录执行，
  输入框不超过高度上限（与 010 的 autosize 上限一致）、IDE 不卡顿（操作可交互）
- [x] **T011** [US3] 排除与截断在真实仓上抽查 — 验证：对本仓库根执行，输出中不含 `build/`、`web/node_modules/`、
  `.git/`，且末尾有省略说明

---

## Phase 5: US4 文件刷新

- [x] **T012** [US4] `BridgeService.wirePiEvents()` 接入 `VfsRefresh.onPiEvent(project, event)`；
  `Alarm` 400ms 防抖；`agent_settled` 触发整体刷新 — 验证：`./gradlew test` 绿；
  真机：让 pi 写一个文件，项目树 ≤1s 出现
- [x] **T013** [US4] `BridgeService.invalidateFilesCache()`：刷新完成后置空 `filesCache`
  — 验证：真机：pi 新建文件后立刻打开 `@` 菜单，新文件在列表里（不必等 30s TTL）
- [x] **T014** [US4] 只读工具不触发、连续写入合并 — 验证：真机让 pi 连续写 10 个文件，
  观察日志只有 1–2 次刷新记录；`read` 一次不产生刷新日志
- [x] **T015** [US4] 未保存编辑不被覆盖 — 验证：真机在编辑器里改一行不保存，让 pi 改同一文件，
  断言编辑器里仍是用户的未保存内容（改动可被撤销/对比）

---

## Phase 6: 集成与收尾

- [x] **T016** [集成] `./gradlew test` + `./gradlew buildPlugin` + `scripts\e2e-ide.ps1` 全绿
  — 验证：三条命令输出贴进 `specs/0.5.2-run-report.md`
- [x] **T017** [集成] `MANUAL_TEST.md` 新增「IDE 集成（v0.5.2）」段：右键 5 格矩阵、目录注入、
  刷新三条 — 验证：每条含「操作 → 通过判据」，可勾选
- [x] **T018** [收尾] 全系兼容性抽查：至少在 IDEA 2024.3 与一个非 IDEA 系（PyCharm/WebStorm 任一）
  上验证右键分组与图标 — 验证：结论写入 run report（不可用的 IDE 明确列出）

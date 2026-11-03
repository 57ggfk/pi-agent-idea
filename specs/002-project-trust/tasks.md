---
description: "Task list for 002-project-trust"
---

# Tasks: 项目级资源的信任模型

**Input**: Design documents from `/specs/002-project-trust/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)

**Tests**: 包含（宪法第 II 条）。

**Organization**: 按 user story 分组。

## Format: `[ID] [P?] [Story] Description — 验证：...`

- **US1**= 信任态可见 / **US2**= 一键信任 / **US3**= 撤销信任 / **US4**= skills 路径与来源

---

## Phase 1: Foundational

- [x] **T001** 新增 `src/main/kotlin/dev/pi/agent/process/PiTrust.kt`：
  `normalize(path)`（canonical + 仅 Windows 小写化 + 统一分隔符）、`read()`、`isTrusted(projectPath)`、
  `grant(projectPath)`、`revoke(projectPath)` — 验证：`PiTrustTest` 覆盖 `D:\a\b` vs `d:/a/b` 判定相等
- [x] **T002** `PiTrust` 写路径：读 → 备份 `.bak` → 只改目标键 → 校验 → 临时文件 + move 原子写；
  解析失败返回 `null` 且不覆写原文件 — 验证：单测注入损坏 JSON，断言文件字节未变
- [x] **T003** `web/src/bridge/types.ts` 声明 `trust.get` / `trust.grant` / `trust.revoke`，
  响应含 `trusted: boolean`、`path`、`resources: {type, scope, active, reason?}[]` — 验证：`tsc --noEmit`
- [x] **T004** `BridgeService.kt` 注册三个方法，从持有 `Project` 的位置取 `basePath` — 验证：`compileKotlin` 通过
- [x] **T005** [P] `web/src/bridge/mock.ts` 补三个方法 + `?trusted=0/1` 开关 — 验证：Vitest 断言两种信任态

**Checkpoint**: 信任态可读、可写、可 mock 驱动。

---

## Phase 2: US1 — 信任态可见（P1）

- [x] **T006** [US1] `ManageView.tsx` 加信任横幅：未信任时显示「本项目尚未被 pi 信任，项目级配置不会生效」+
  受影响的资源类别列表 — 验证：Playwright 断言 `data-state="untrusted"` 与三类资源名可见
- [x] **T007** [US1] 已信任时横幅不出现；项目级条目正常渲染 — 验证：Playwright 断言 `data-state="trusted"` 且无横幅
- [x] **T008** [US1] 项目级条目统一带「项目级 · 未生效」标记 + 原因 tooltip，与用户级视觉区分 — 验证：
  断言同一列表内 `[data-scope=project]` 与 `[data-scope=user]` 存在且样式类不同
- [x] **T009** [US1] `trust.json` 缺失 → 视为未信任且不报错；损坏 → 横幅显示「无法读取信任配置」+ 解析错误摘要，
  并按未信任处理 — 验证：mock 两种文件状态，断言文案

---

## Phase 3: US2 — 一键信任（P1）

- [x] **T010** [US2] 横幅按钮 → 确认对话框，列出「项目级 skills / MCP / settings / 扩展」四类将生效内容 — 验证：
  Playwright 断言确认框含四类条目
- [x] **T011** [US2] 确认后调 `trust.grant`，成功后横幅消失、条目转为生效态 — 验证：断言 `data-state` 翻转
- [x] **T012** [US2] 写入失败（权限/只读）→ 展示原始错误，状态不变 — 验证：mock 失败，断言错误文本可见且仍为 untrusted
- [x] **T013** [US2] 若存在运行中会话，信任后提示「需新会话生效」；同时 `PiProcessManager` 支持对下一次启动
  追加 `--approve`（仅在本次会话内已授权时）— 验证：单测断言参数拼装分支

---

## Phase 4: US3 — 撤销信任（P2）

- [x] **T014** [US3] 已信任态提供「撤销信任」入口，二次确认 — 验证：Playwright 断言确认框存在
- [x] **T015** [US3] 确认后调 `trust.revoke`，`trust.json` 删除该键（保留其他项目），条目回到未生效态 — 验证：
  单测断言其他项目键仍在
- [x] **T016** [US3] 撤销后提示「当前会话的 pi 进程仍按已信任状态运行，需新会话/重启才彻底失效」 — 验证：断言提示文案

---

## Phase 5: US4 — skills 路径与来源（P2）

- [x] **T017** [US4] `PiManage.skillsList(projectBasePath)`：去掉相对路径 `File(".pi/skills")`，
  改为 `File(projectBasePath, ".pi/skills")` 与 `.agents/skills`；条目补 `scope` 与绝对 `path` — 验证：
  `PiManageTest` 用两个临时项目目录断言各自只列出自己的 skill
- [x] **T018** [US4] `BridgeService` 的 `skills.list` 传入当前项目 basePath — 验证：单测断言传参非空
- [x] **T019** [US4] `SkillsPanel.tsx` 渲染层级标签 + 未生效样式（未信任项目中）— 验证：Playwright 断言标签文案与样式类
- [x] **T020** [US4] 项目级目录不存在时不渲染空分组 — 验证：断言无 `[data-scope=project]` 节点

---

## Phase 6: Polish

- [x] **T021** [P] `./gradlew test compileKotlin` 全绿 — 验证：退出码 0
- [x] **T022** [P] `npx playwright test` + `vitest` 全绿，现有 51 条 e2e 不回归 — 验证：用例计数
- [x] **T023** CHANGELOG 补：项目信任模型（新增）+ skills 相对路径修正（修复）— 验证：人工核对
- [x] **T024** 真机验证：在 `pi-agent-idea`（当前未信任）中确认横幅出现；信任后项目级 skills 出现 — 验证：截图留档

## 依赖关系

```
T001,T002 ──┬─ T006..T009 (US1)
            ├─ T010..T013 (US2)
            └─ T014..T016 (US3)
T017 ── 独立于信任态（路径修正），可并行
T005 依赖 T003
```

**跨规格**：`001-manage-completeness` 的 T011（项目级 MCP 停用）依赖本规格 T001/T004 完成。

## 总计

24 个 task：Foundational 5 + US1 4 + US2 4 + US3 3 + US4 4 + Polish 4。

## 实现记录（2026-11-02）

T001–T023 已完成并验证：

| 验证项 | 结果 |
|---|---|
| `./gradlew test` | BUILD SUCCESSFUL；新增 `PiTrustTest`(13) / `PiManageTest`(5) / `PiStartArgsTest`(4) 全绿 |
| `npx tsc --noEmit` | 退出码 0（顺手删掉 `layout-regressions.spec.ts` 里的未使用变量 `mb`） |
| `npx vitest run` | 23 passed |
| `npx playwright test` | **55 passed**（原 51 + 新增 4 条信任用例；`skills` 用例的行数断言由 1 改为 2，因为 mock 现在同时给出用户级与项目级各一条） |

实现与 plan 的两处偏差（均为收敛，不是放宽）：

1. **`trust.get` 额外返回 `store` / `exists` / 资源 `label` 与 `path`** —— 契约原文没有这三个字段，
   但横幅要说明「哪个文件读不了」、确认框要用可读标签逐项列出，否则 UI 只能靠猜。
2. **`TrustState.error` 与 `trusted` 分开发** —— 契约写「解析失败 → `ok:false`」，实现里另外显式给
   `trusted:false`，避免前端在 `ok:false` 时把 `undefined` 当真值处理。

`T024`（真机验证）**未完成**：需要在 IDE 里打开工具窗口肉眼看横幅。当前仓库 `.pi/` 目录不存在，
所以真实状态会是「未信任 + 资源列表为空」——横幅出现但不列条目，这正是 T020 要的行为，
但只有真机能确认它在 JCEF 里的渲染。

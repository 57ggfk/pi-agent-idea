---
description: "Task list for 001-manage-completeness"
---

# Tasks: Manage 面板功能补全

**Input**: Design documents from `/specs/001-manage-completeness/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)

**Tests**: 包含。宪法第 II 条要求「没有断言覆盖的改动不得标记完成」，故每个 story 自带测试任务。

**Organization**: 按 user story 分组，每个 story 可独立交付。

## Format: `[ID] [P?] [Story] Description — 验证：...`

- **[P]**: 可并行（不同文件、无依赖）
- **[Story]**: US1= MCP 停用 / US2= 扩展包更新 / US3= pi 更新 / US4= Provider 查看

## Path Conventions

单仓双端：宿主 `src/main/kotlin/dev/pi/agent/`，前端 `web/src/`，测试 `src/test/kotlin` + `web/e2e`。

---

## Phase 1: Foundational（阻塞所有 story，必须先完成）

**Purpose**: 先把跨端契约立起来，否则四个 story 会各自发明字段。

- [ ] **T001** 在 `web/src/bridge/types.ts` 声明本规格全部新方法与数据结构：
  `mcp.setEnabled`、`packages.update`、`env.update`、
  `models.readProvider`、`models.openFile`；MCP 条目补 `enabled` / `scope` 字段 — 验证：`tsc --noEmit` 通过
  （**不声明 `env.checkUpdate`**：pi 无 check-update 子命令，见 plan「3. pi 本体更新」）
- [ ] **T002** 在 `src/main/kotlin/dev/pi/agent/bridge/BridgeService.kt` 注册上述 5 个方法的分发分支
  （先返回 `not_implemented` 占位） — 验证：`./gradlew compileKotlin` 通过，且前端调用拿到结构化错误而非 bridge 500
- [ ] **T003** [P] 在 `web/src/bridge/mock.ts` 为 5 个方法补 mock（含失败分支：`?fail=mcp`、`?fail=update`）— 验证：Vitest 里可断言失败态
- [x] **T004** [P] 新增 `src/main/kotlin/dev/pi/agent/manage/PiMcpConfig.kt` 骨架：
  读/写 `mcp.json`（用户级 + 项目级）、备份、原子写入 — 验证：`PiMcpConfigTest` 能读写临时目录

**Checkpoint**: 契约就位，四个 story 可以并行开工。

---

## Phase 2: US1 — MCP 临时停用（P1，唯一有数据损失风险的）

**Goal**: 停用不丢配置，启用不重填。

- ~~[ ]~~ **T005** [US1] **（作废）** `PiMcpConfig` 实现停用仓库 `<IDE config>/pi-agent/mcp-disabled.json`
  （`version` + `user`/`project` 两段，条目含 `entry` 原文与 `_scope`）— 验证：单测覆盖「停用→仓库有该条目且 mcp.json 已无」
- ~~[ ]~~ **T006** [US1] **（作废）** `PiMcpConfig.disable(name, scope)`：写前备份 `mcp.json`、从文件移除条目、存仓库；
  文件不存在或条目不存在时返回结构化错误 — 验证：单测覆盖正常、条目不存在、文件损坏三种
- ~~[ ]~~ **T007** [US1] **（作废）** `PiMcpConfig.enable(name, scope)`：文件已有同名条目时以文件为准并返回 `conflict`，
  否则回填仓库原文并删除仓库条目 — 验证：单测覆盖回填成功、外部手改冲突
- [x] **T008** [US1] `PiManage.mcpSetEnabled(params)` 串联 T006/T007，`mcpList()` 合并显示已停用项
  （标记 `enabled:false` + `scope`）— 验证：单测断言 list 输出同时含启用与停用项
- [x] **T009** [US1] `McpPanel.tsx` 加启停开关：停用项灰显 + 层级徽标（user/project）；
  停用时若当前会话在用该服务器，显示「需新会话生效」提示 — 验证：Playwright 断言开关状态切换后列表文案变化
- [x] **T010** [US1] e2e：`web/e2e/manage.spec.ts` 覆盖「停用→项变灰→启用→配置字段仍在」 — 验证：用例通过，且断言配置字段值不变
- [x] **T011** [US1] 项目级分支：``scope==="project"`` 且项目未信任时，禁用项目级停用并提示原因
  （依赖 002，可先留 TODO 注释）— 验证：mock 下断言提示可见

**Checkpoint**: US1 可独立交付 —— 用户已经能安全停用 MCP。

---

## Phase 3: US2 — 扩展包更新（P2）

- [ ] **T012** [P] [US2] `PiManage.packageUpdate(params)`：转发 `pi update <source>`（或 `--extension <source>`），
  非 0 退出码透传 stdout+stderr；不做「前后 diff 判有无更新」 — 验证：单测用 mock CLI 断言成功/失败两种返回
- [ ] **T013** [US2] `PackagesPanel.tsx` 加「更新」按钮（仅在可识别源时显示）、进行中禁用、失败展示原始 stderr — 验证：Playwright 断言点击后按钮 disabled、失败时有 stderr 文本
- [ ] **T014** [US2] e2e：`manage.spec.ts` 覆盖「更新成功刷新版本」与「更新失败显示原始错误」 — 验证：用例通过

**Checkpoint**: US2 独立可交付。

---

## Phase 4: US3 — pi 本体更新（P3）

- [ ] **T015** [P] [US3] `PiManage.envUpdate()`：`pi update --self`，成功后
  `PiLocator.locate(forceRefresh = true)` 刷新版本 — 验证：单测用 mock CLI 断言命令拼装与刷新调用
- [ ] **T016** [US3] 环境区**只显示当前版本 + 更新按钮**，不实现「有新版本」角标
  （pi 无 check-update 子命令，离线判定不可信；结果由 `pi update` 自己的输出说明）— 验证：面板上不存在「可用版本」占位
- [ ] **T017** [US3] `ManageView.tsx` 环境区展示当前版本 + 更新入口；
  触发前若有活跃会话弹确认（复用 `Composer` 的 confirm 模式）— 验证：Playwright 断言有会话时出确认、取消不执行
- [ ] **T018** [US3] 更新成功后 `PiLocator.locate(forceRefresh=true)` 并重建进程，
  状态栏版本号同步刷新 — 验证：单测断言刷新后 version 变化

**Checkpoint**: US3 独立可交付。

---

## Phase 5: US4 — 自定义 Provider 查看（P4）

- [ ] **T019** [P] [US4] `PiManage.modelsReadProvider(name)`：反向白名单（除敏感键外全量输出），
  敏感键替换为 `configured: bool` — 验证：单测断言 `apiKey` 值绝不出现在返回 JSON 中（**宪法第 VI 条的硬断言**）
- [ ] **T020** [US4] `PiManage.modelsOpenFile(provider)`：走 `FileEditorManager` 打开
  `~/.pi/agent/models.json`，不存在则创建 `{"providers":{}}` 骨架 — 验证：单测断言骨架内容合法
- [ ] **T021** [US4] `AuthPanel.tsx` 每个 provider 可展开看详情（敏感项显示「已配置/未配置」）+「在编辑器中打开」 — 验证：Playwright 断言展开后有字段但无密钥值
- [ ] **T022** [US4] `models.json` 缺失/损坏时面板显示具体原因（含解析错误位置）而非空白 — 验证：mock 损坏文件后断言错误文案可见

**Checkpoint**: 四个 story 全部可独立交付。

---

## Phase 6: Polish

- [ ] **T023** [P] 汇总 `manage.spec.ts` 全量跑通；`npx playwright test` 全绿 — 验证：≥ 现有 51 条不回归
- [ ] **T024** [P] `./gradlew compileKotlin test verifyPlugin` 全绿 — 验证：三条命令退出码 0
- [ ] **T025** CHANGELOG「未发布」补四条变更（MCP 启停 / 包更新 / pi 更新 / Provider 查看），
  标注 MCP 停用为「新增能力，不涉及迁移」 — 验证：人工核对条目与实现一致
- [ ] **T026** 真机冒烟：装插件后确认 4 个入口可见可点（宪法第 4 条：不可连续两版跳过真机）
  — 验证：截图留档或 MANUAL_TEST.md 打勾

## 依赖关系

```
T001 ─┬─ T005..T011 (US1)
      ├─ T012..T014 (US2)
      ├─ T015..T018 (US3)
      └─ T019..T022 (US4)
T011 ──→ 需 002-project-trust 的信任态读取
```

US1–US4 之间**无**相互依赖，可任意顺序或并行。

## 总计

26 个 task：Foundational 4 + US1 7 + US2 3 + US3 4 + US4 4 + Polish 4。

---

## 实现记录（2026-11-03，US1 / T004–T011）

分支 `001-manage-completeness`（从 `003-error-visibility` 的 tip 上叠，三个 spec 进同一个版本）。
本批**只做 US1（MCP 启停）**，US2/US3/US4 未动，故 T001–T003 保持未勾——它们要求五个方法一次落齐。

### 首要发现：plan 的核心方案建立在错误假设上

plan「关键技术决策 1」写的是：

> 方案 A：改 `mcp.json` 加 `"disabled": true` → pi 不认识该字段 → 无效
> 方案 C（选用）：从 `mcp.json` 移除条目，原文存入插件停用仓库

实测 pi 1.4.0 的 `docs/mcp.md` 第 69 行：

> `enabled: false`: keep the entry without connecting to it.

**字段名是 `enabled`，pi 认识，而且这是官方支持的能力。** 于是：

- 停用 = 把该条目 `enabled` 置 false，配置原地不动 → **不需要停用仓库**，T005–T007 作废；
- 启用 = 删掉 `enabled` 字段（pi 缺省为 true），保持文件干净、下次停用仍是单键 diff；
- 项目级覆盖也是官方语义：不带 `command`/`url`/`type` 的项目条目只覆盖 `enabled`/`exposure`/`toolExposure`。

`pi mcp list --json` 的实测输出（临时 `PI_CODING_AGENT_DIR` + 临时项目 + trust.json）：

```json
{ "name": "user-srv", "scope": "global", "enabled": false, "state": "disabled",
  "source": "...\\mcp.json", "override": "...\\.pi\\mcp.json" }
{ "name": "proj-srv", "scope": "project", "enabled": true, "state": "failed" }
```

也就是说：**禁用项照样出现在列表里**，`enabled` / `scope` / `state` / `override` 全都有。
所以 `mcpList` 不需要合并任何东西，前端也不需要自己算生效状态。

### 顺带修掉的一个真 bug

`PiCliRunner.run()` 用 `ProcessBuilder` 但**从不设 working directory**，子进程继承 IDE 进程的 cwd。
而 `pi mcp list` 与 `pi mcp add --local` 都是按 cwd 找 `.pi/mcp.json` 的：

- 多项目窗口里 `mcpList` 读到的是别的项目（或什么也没有）；
- `mcp add --local` 会把服务器写到 GUI 进程的当前目录里。

修法：`run(..., workingDir)`；`mcpList` 传项目根，`mcpAdd`/`mcpRemove` 在 `local=true` 时传项目根。
`BridgeService.withProjectPath()` 统一注入，前端不必知道项目路径。

### 落地清单

| 项 | 内容 |
|---|---|
| T004 | `manage/PiMcpConfig.kt`（**完整实现，不是骨架**）：`fileFor` / `entries` / `setEnabled` / `overrideWarning`；备份 → 校验 → 原子移动，沿用 `PiTrust` 的写盘纪律 |
| T005–T007 | **作废**（见上）。`setEnabled` 一个方法覆盖启用与停用 |
| T008 | `PiManage.mcpSetEnabled` + `mcpList(projectPath)`；`mcpAdd`/`mcpRemove` 支持 `projectPath` |
| T009 | `McpPanel` 加 `role="switch"` 开关（文案 Enabled/Disabled，不靠颜色）、`scope` 徽标、禁用行虚线灰显、停用已连接服务器时提示「下一个会话生效」、`warning` 单独一行提示；Login/Logout 在禁用时 disable（对着关掉的服务器登录是死路） |
| T010 | `manage.spec.ts` 新增 4 例：停用→配置保留→再启用、scope 徽标与禁用态、overlay 覆盖提示、写入失败不翻转开关 |
| T011 | 项目未信任时 `setEnabled(scope=project)` 直接拒绝并说明原因（写了 pi 也不读，看起来像成功最糟） |

### 两处有意偏差

1. **`enabled` 徽标文案用英文 user/project**，而 `SkillsPanel` 用「用户级 / 未生效」。同一个面板里两种语言更糟，
   McpPanel 本身全英文（Add server / No MCP servers configured），所以跟随本面板。
2. **前端只把 `scope` 用于显示，回传仍是 pi 的 `global`**。第一版把 `global` 映射成 `user` 后连回传也用了 `user`，
   后端报 `unknown scope: user`，4 条 e2e 里 3 条直接挂——**显示层的词不要流进协议层**。

### 验证

- `cd web && npm run typecheck` → 0 error
- `cd web && npx playwright test` → **87 passed**（新增 4 条，既有 83 条无回归）
- `cd web && npm test` → 未跑（本批无前端单测改动，逻辑全在 Kotlin）
- `./gradlew compileKotlin` → 通过
- `./gradlew test --tests "dev.pi.agent.manage.PiMcpConfigTest"` → **12 passed**

### 未做

- T001–T003 的其余部分（`packages.update` / `env.update` / `models.readProvider` / `models.openFile`）→ US2–US4。
- T023–T026（全量回归 / `verifyPlugin` / CHANGELOG / 真机冒烟）：CHANGELOG 已随本批补 US1 一条，
  其余等 US2–US4 一起做，避免 What's New 写半截。

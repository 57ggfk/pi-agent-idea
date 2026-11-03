# 待实现功能总览（Spec Kit）

> 生成时间：2026-11-02
> 约束基准：[`.specify/memory/constitution.md`](../.specify/memory/constitution.md)
> 本目录下每个 `NNN-*` 都遵循 spec → plan → tasks 三段式，可独立交付。

## 缺口来源与判定依据

本次盘点**不依赖文档自述**，而是逐条核对代码与真实运行环境。四类证据：

| 来源 | 用途 |
|---|---|
| `docs/PRODUCT_DESIGN.md` 的 P0–P3 规格表 | 找出「设计里有、代码里没有」的项 |
| `docs/TASK_PLAN.md` 的 ☐ 与「用户决定跳过」 | 找出流程上未闭环的项 |
| `docs/UI_ISSUES.md` 的「附：关联隐患」 | 找出修复时被部分处理的遗留 |
| 实测 `pi --help` / `pi mcp --help` / `~/.pi/agent/*.json` | 校正方案，避免把猜测写进规格 |

实测纠正了两个原本会写错的方案（详见 001 plan）：
`pi update` 原生支持 `--self` / `--extensions` / `--models`，不需要自拼 `npm i -g`；
`pi mcp` **没有** enable/disable，停用只能在配置层实现。

## 五个 Feature

| # | 名称 | 优先级 | 缺口本质 | 关键证据 |
|---|---|---|---|---|
| 001 | [Manage 面板功能补全](./001-manage-completeness/spec.md) | P1 | 能加不能停、能装不能升、能看不能改 | `PiManage.kt` 无 `mcpSetEnabled` / `packageUpdate` / `envUpdate`；`authOverview` 只返回 provider 名字 |
| 002 | [项目级资源的信任模型](./002-project-trust/spec.md) | P1 | 配置做对了却不生效，且界面不解释 | `trust.json` 中 `pi-agent-idea` 未被信任；`skillsList()` 用 `File(".pi/skills")` 相对路径 |
| 003 | [静默失败可见化](./003-error-visibility/spec.md) | P1 | 空列表分不清「为空」还是「失败」 | `store.ts` 有 12 处 `.catch(() => undefined)` / 空 catch |
| 004 | [IDE 侧动作的自动化覆盖](./004-action-coverage/spec.md) | P2 | 动作注册/可用性无任何自动化 | UI_ISSUES 第 8 条自述「无自动化覆盖」；TASK_PLAN Phase 7/8 真机验收连续跳过 |
| 005 | [插件镜像消息队列](./005-message-queue/spec.md) | P1 | 流式排队不可见、不可操作；假计数永不更新 | 初版「pi 无队列读写」的断言经实测证伪（2026-11-03 修订）：`queue_update` 携带完整 steering/followUp 数组、`clear_queue` 可全量取出。**新提需求，非审计缺口** |

### 严重度排序逻辑

- **001 排第一**：唯一会造成**用户配置丢失**的缺口（想停用 MCP 只能删除重填）。
- **002 排第二**：唯一会造成**用户按文档做对却无效**的缺口（静默失效比功能缺失更伤信任）。
- **003 排第三**：影响面广但不丢数据、有 workaround（重开窗口）。
- **004 排第四**：面向维护者，但它是**唯一能防止历史事故复发**的手段。

## 依赖关系

```
002 (PiTrust + scope 枚举)
 ├──→ 001.T011  项目级 MCP 停用的信任判定
 └──→ 001 的 scope 字段与 002 共用

001 ── 独立可交付
003 ── 独立可交付（仅前端）
004 ── 独立可交付（仅宿主测试）
005 ── 独立可交付（Kotlin QueueService + web 队列条 + mock 重写）
```

**建议执行顺序**：`002 → 001 → 003 → 004`

理由：002 定义的 `scope` 与 `PiTrust` 是 001 的输入；003 与 004 与前三者无耦合，
可在任意空档穿插（004 的 T014–T017 纯函数部分甚至可以先做，成本最低）。

## 交付规模

| Feature | Tasks | 状态 | 主要触及 |
|---|---|---|---|
| 001 | 26 | **已实现（26/26，真机验证含）** | `PiManage.kt`、新增 `PiMcpConfig.kt`、4 个 manage 面板 |
| 002 | 24 | **已实现（23/24）** | 新增 `PiTrust.kt`、`skillsList` 签名变更、ManageView 横幅 |
| 003 | 24 | **已实现（23/24）** | 新增 `store/sources.ts`、`store.ts` 局部重构、新增诊断面板 |
| 004 | 23 | 待开工 | `build.gradle.kts`、3 个新测试类、新增 `SMOKE_TEST.md` |
| 005 | 31 | **已实现（31/31，真机复验含）** | 新增 `queue/PiMessageQueue.kt`、`QueueBar.tsx`、`queue.*` 桥接与 mock 重写 |
| **合计** | **128** | — | — |

002 的验收结果见 [其 tasks.md 的「实现记录」](./002-project-trust/tasks.md#实现记录2026-11-02)：
`./gradlew test` 与 `npx playwright test`（55 passed）全绿，仅 T024 真机目视未做。

## 未纳入本批（需单独决策，不适合写成 feature）

| 事项 | 为什么不在本批 |
|---|---|
| **Marketplace 上架审核** | 需要用户的 JetBrains Account 令牌与人工提交，不是代码工作。配置已就绪（`publishPlugin`、token 环境变量、channels） |
| **真机人工回归（Phase 7/8 欠账）** | 属于流程执行而非功能实现。004 的 `SMOKE_TEST.md` 会把它固化成可执行清单 |
| **pi TUI 的全功能复刻（`/tree` 等）** | 产品 Non-goals 明确不做 |
| **插件内表单式编辑 `models.json`** | 会与 pi 的 schema 演进强耦合，001 采用「打开文件」而非自建编辑器 |

## 下一步

```
/speckit.plan 或 /speckit.tasks 已产出，可直接 /speckit.implement 001
```

每份 `tasks.md` 的 task 都自带「— 验证：…」，满足宪法第 II 条（无断言覆盖不得标记完成）。

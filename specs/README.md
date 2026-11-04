# 待实现功能总览（Spec Kit）

> 生成时间：2026-11-02（001–005）；**0.5.2 批次 006–010 见文末**
> 0.5.2 批次生成时间：2026-11-04
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

---

# 0.5.2 批次（2026-11-04）

> 版本分支：`release/0.5.2`（已从 main 拉出，`version` 已 +1 patch）
> 约束基准不变：[`.specify/memory/constitution.md`](../.specify/memory/constitution.md)
> 执行提示词：[`specs/0.5.2-ZCODE-PROMPT.md`](./0.5.2-ZCODE-PROMPT.md)
> 执行记录模板：[`specs/0.5.2-run-report.md`](./0.5.2-run-report.md)

## 五个 Feature 与优先级

排序依据：**改动量小、风险低、依赖少者优先**（不是业务价值排序）。008 国际化排在最后，
因为它要扫过其余四个 feature 新增的全部文案，先做等于写两遍。

| 序 | Feature | 难度 | 主要内容 | 关键证据/风险 |
|---|---|---|---|---|
| 1 | [010 界面细节打磨](./010-ui-polish/spec.md) | 低（纯样式 + 一个 util） | 用户消息气泡紧凑、空态上下居中、输入框自适应高度 | 三条都能用几何断言锁死；不涉及协议 |
| 2 | [007 消息级 Fork + 确认框](./007-message-fork/spec.md) | 中（一个协议验证 + 一个通用组件） | pi 消息工具条 Fork、底部 Fork 隐藏、统一应用内确认框 | `fork` 边界语义须先实测（V1）；确认框替换 4 处 `window.confirm` |
| 3 | [009 IDE 集成](./009-ide-integration/spec.md) | 中（Kotlin 侧 4 件事） | 右键分组图标、子菜单不再整片灰、添加目录到 pi、文件变更刷新 VFS | 「整片灰」根因需真机复核；VFS 刷新要防抖 + 让 `files.list` 缓存失效 |
| 4 | [006 会话导航与检索](./006-session-navigation/spec.md) | 中高（3 个 US + 一条新桥接） | 用户消息目录、会话内搜索、全会话搜索 | 新增 `sessions.search`；`Ctrl+F` 在 JCEF 里可能被 IDE 抢走 |
| 5 | [008 多语言](./008-i18n/spec.md) | 高（约 300 条文案 + 双端 + 引框架） | 跟随 IDE 语言、选择器随语言数自适应、Web + IDE 侧全覆盖 | 必须最后做；**引 `i18next`**（为后续加语言，理由见该 plan 的 D0）；复数分类用 `Intl.PluralRules` 校验；加语言不动组件由测试锁定 |

**依赖**：006 的「搜索结果定位」复用 010 的输入框高度与 007 的会话切换；007 的确认框被 006 的下一次改动沿用；
008 依赖前四个的最终文案。**顺序不可颠倒的部分只有一条：008 必须最后。**

## 相对 0.5.1 的范围变化

| 用户原条目 | 处理 | 原因 |
|---|---|---|
| 打开历史会话命令详情不能展开 | **移出** | 0.5.1 已修复（`2d644c4`），本版不复测 |
| 发送按钮右侧下拉 | **不做** | 用户尚未决定交互形态，见 010 的 Non-goals |
| 底部 Fork | **隐藏不删除** | 保留常量开关，后续可一行恢复（007 FR-006） |
| 全会话搜索范围 | 收敛为**当前项目** | 与 Sessions 列表同源；跨项目检索需要索引层，另立规格 |

## 每份 tasks.md 的完成判据

同 001–005：每个 task 自带「— 验证：…」，没有断言覆盖的改动不得标记完成；
真机项必须留截图或日志，写进 [`0.5.2-run-report.md`](./0.5.2-run-report.md)。

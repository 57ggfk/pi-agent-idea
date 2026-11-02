# Implementation Plan: Manage 面板功能补全

**Branch**: `001-manage-completeness` | **Date**: 2026-11-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-manage-completeness/spec.md`

## Summary

把 Manage 面板四个「半截功能」补齐：MCP 停用/启用、扩展包更新、pi 本体更新、自定义 Provider 查看与跳转编辑。

技术上的核心约束来自实测：**pi 1.4.0 的 `mcp` 子命令只有 `add / remove / list / login / logout`，
没有 enable/disable**。所以 MCP 停用不能靠 CLI，必须在配置层实现——把条目从 `mcp.json` 移出，
原文存入插件侧的「停用仓库」，启用时回填。这样 pi 侧看到的就是一个「不存在」的服务器，行为完全等价于未安装，
且配置零丢失。

另一处实测结论修正了初版设想：**pi 1.4.0 原生提供 `pi update`**，形式为
`pi update [source|self|pi] [--self|--extensions|--models|--all] [--extension <source>] [--force]`。
因此扩展包更新与 pi 本体更新都**直接复用该子命令**，不自行拼装 npm 命令、也不做「覆盖安装 + 输出 diff」的土办法。
Provider 查看则只读 `models.json` + 调用 IDE 打开文件。

## Technical Context

**Language/Version**: Kotlin（JDK 21 编译）、TypeScript 5 / React 18

**Primary Dependencies**: IntelliJ Platform Gradle Plugin 2.19.0、kotlinx.serialization、Vite、现有 `PiCliRunner` / `PiManage` / `BridgeService`

**Storage**: 用户级 `~/.pi/agent/{mcp.json, models.json, auth.json, trust.json}`；项目级 `.pi/mcp.json`；
插件私有 `<IDE config>/pi-agent/`（停用仓库、审批策略已有先例）

**Testing**: Kotlin JUnit（`src/test/kotlin`）、Vitest（`web/src/**/*.test.ts`）、Playwright + MockBridge（`web/e2e`）、runIde + JCEF CDP（`scripts/e2e-ide.*`）

**Target Platform**: IntelliJ 平台 233–263.*，运行于 JCEF

**Project Type**: 桌面 IDE 插件的单仓双端（Kotlin 宿主 + web 前端）

**Performance Goals**: 面板操作反馈 < 200ms（本地读文件）；CLI 调用按现有超时策略（安装/更新 300s）

**Constraints**: 不引入新的运行时依赖；所有写操作必须备份 + 校验；离线时区分「检查失败」与「已最新」

**Scale/Scope**: 单人维护的插件；Manage 面板 5 个分区，本规格触及其中 4 个

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原则 | 本规格的落实方式 | 结论 |
|---|---|---|
| **I. 双端契约同步** | 新增桥接方法必须在 `BridgeService` + `web/src/bridge/types.ts` + `mock.ts` 三处同时落地；MCP 启停状态字段进 `types.ts` | PASS |
| **II. 断言含几何与行为** | Manage 面板是表单类 UI，几何风险低；但开关的点击热区、更新按钮的禁用态必须按行为断言（可点/不可点/状态文案） | PASS（需补行为断言） |
| **III. 不依赖环境假设** | 本规格无新增布局计算，沿用现有面板布局 | PASS |
| **IV. 写操作可回滚可解释** | **本规格的核心**：mcp.json 改写前备份；停用仓库本身即回滚手段；失败透传 stderr | PASS |
| **V. JCEF 单向 / 走 bridge** | 全部经既有 `POST /bridge`；新增方法在 `BridgeService` 注册，不做 JS 注入 | PASS |
| **VI. 凭据零托管** | Provider 详情对 `apiKey` / `clientSecret` 等字段只输出 `configured: true/false` | PASS |

无违反项，无需 Complexity Tracking。

## Project Structure

### Documentation (this feature)

```text
specs/001-manage-completeness/
├── spec.md              # 已完成
├── plan.md              # 本文件
└── tasks.md             # /speckit.tasks 产出
```

### Source Code (repository root)

```text
src/main/kotlin/dev/pi/agent/
├── manage/
│   ├── PiManage.kt                  # +mcpSetEnabled / packageUpdate / envCheckUpdate / envUpdate
│   │                                 #  +modelsReadProvider / modelsPath
│   └── PiMcpConfig.kt               # 新增：mcp.json 读写 + 停用仓库
├── bridge/
│   └── BridgeService.kt             # 注册新桥接方法
└── process/
    └── PiLocator.kt                 # 复用版本探测；+upgradeCommandFor(install)

web/src/
├── bridge/
│   ├── types.ts                     # 新方法与数据结构声明（真源）
│   └── mock.ts                      # 对应 mock 实现
├── components/manage/
│   ├── McpPanel.tsx                 # +启停开关 + 层级标记 + 需新会话提示
│   ├── PackagesPanel.tsx            # +更新按钮 + 进行中态
│   └── AuthPanel.tsx                # +provider 详情 + 在编辑器打开
└── components/ManageView.tsx        # 环境区：当前版本/可用版本/更新入口

web/e2e/
└── manage.spec.ts                   # 新增：四个场景的 mock 驱动用例

src/test/kotlin/dev/pi/agent/manage/
└── PiMcpConfigTest.kt               # 新增：停用/回填/冲突/损坏配置
```

**Structure Decision**: 沿用现有「宿主 `src/main/kotlin` + 前端 `web/src` + 双测试层」结构，不新建模块。
MCP 配置读写单独拆 `PiMcpConfig.kt`，避免 `PiManage.kt`（已 289 行）继续膨胀，也便于单测直接覆盖文件层逻辑。

## 关键技术决策

### 1. MCP 停用：配置层实现，不依赖 CLI

pi 无 `mcp disable` 子命令（实测 `pi mcp --help`，1.4.0）。可选方案对比：

| 方案 | 做法 | 问题 |
|---|---|---|
| A | 改 `mcp.json` 加 `"disabled": true` | pi 不认识该字段，会照常启动 → 无效 |
| B | `pi mcp remove` 删除 | 配置丢失，违反 FR-001 |
| **C（选用）** | 从 `mcp.json` 移除条目，原文存入插件停用仓库；启用时回填 | 需处理与外部手改的同步 |

选 C。停用仓库落 `<IDE config>/pi-agent/mcp-disabled.json`：

```json
{
  "version": 1,
  "user": { "github": { "_disabledAt": "...", "_scope": "user", "entry": { ...原 mcp.json 条目... } } },
  "project": { }
}
```

回填规则：
- 若 `mcp.json` 中该 name **已存在**（用户手动重加了），以文件为准，丢弃仓库副本并提示；
- 若不存在，写回原条目；写前备份 `mcp.json`；
- 层级必须与 `_scope` 一致（用户级写 `~/.pi/agent/mcp.json`，项目级写 `.pi/mcp.json`）。

### 2. 扩展包更新：直接用 `pi update`

实测 `pi update --help`（1.4.0）确认可用形式：

| 目标 | 命令 |
|---|---|
| 单个包 | `pi update <source>` 或 `pi update --extension <source>` |
| 全部扩展 | `pi update --extensions` |
| 模型目录 | `pi update --models` |

因此 `packages.update` 只需转发到 `pi update <source>`，超时沿用安装的 300s。
退出码非 0 时透传 stdout+stderr（pi 会把失败原因写在这里）。
不再做「安装前后 diff 判断是否真的有更新」——`pi update` 自身会报告结果，
额外 diff 只会制造与 pi 输出不一致的第二套真相。

### 3. pi 本体更新：`pi update --self`

同一子命令即可完成：`pi update` / `pi update self` / `pi update pi` / `--self` 等价。
不需要判断安装形态（npm 全局 / 独立二进制 / 其他），也不需要拼 `npm i -g`。

执行前后仍需：
- 若 `PiProcessManager` 有活跃会话 → 先确认（更新会替换正在运行的二进制）；
- 成功后 `PiLocator.locate(forceRefresh = true)` 刷新版本，状态栏同步。

`envCheckUpdate()` 不做主动联网探测：pi 无 `check-update` 子命令，
离线判定不可靠（`--offline` / `PI_OFFLINE=1` 也存在）。因此**只显示当前版本**，
更新入口按需触发，结果由 `pi update` 的输出来说明（已最新 / 已更新 / 失败）。
这比自造一个不可信的「有新版本」角标更诚实。

### 4. Provider 详情：只读 + 打开文件

`modelsReadProvider(name)` 返回该 provider 的白名单字段（`type` / `baseUrl` / `models[].id` / `contextWindow`），
对 `apiKey`、`headers.Authorization`、`clientSecret` 等一律替换为布尔 `configured`。
`modelsOpenFile(provider)` 走 IDE `FileEditorManager` 打开 `~/.pi/agent/models.json`（若不存在则先创建空骨架）。

## 依赖与顺序

- US2（扩展包更新）、US3（pi 更新）、US4（Provider 查看）**互相独立**，可分别交付。
- US1（MCP 停用）的项目级分支依赖 `002-project-trust`：项目未被信任时 `.pi/mcp.json` 不生效，
  停用/启用应作用于用户级并提示原因。**先做用户级，项目级留到 002 落地后接**。

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 用户在终端同时改 `mcp.json` | 停用仓库与文件不一致 | 每次操作前重读文件；冲突时以文件为准并提示 |
| npm 全局目录不可写 | pi 更新失败 | 透传原始错误 + 给出 `npm prefix` / sudo 建议 |
| `pi update` 在无更新时也返回 0 | 用户以为升过版了 | 不猜语义，直接把 pi 的输出原文展示（它会自己说明「已是最新」或「已更新到 x.y.z」） |
| `pi update --self` 替换二进制时当前进程仍在跑 | 更新后行为不一致 | 有活跃会话先确认；成功后强刷版本并重建进程 |
| Provider 字段随 pi 版本变化 | 白名单漏字段 | 采用「除敏感键外全量输出」的反向策略，未知键保留 |

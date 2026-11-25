# Feature Specification: 诊断信息增强 + 路径主目录缩写

**Feature Branch**: `release/0.5.10`

**Created**: 2026-11-16

**Status**: Implemented（已实现并随 0.5.10 内测；发布文案见 changelog.d/036-*）

**Input**: 用户提出（2026-11-16）
> - 诊断，增加 node npm 等信息包括版本和路径。增加插件的版本信息，如果有构建时间更好
> - 设置文件路径和诊断文件路径，用户目录也支持缩短

两条合并为一份规格：都只改「设置 / 诊断」两个面板的**信息展示层**，无业务状态机，无桥接写操作，故同批交付、同批验收。

## 可行性结论（读码核实，非推测）

| 诉求 | 现状 | 结论 |
|---|---|---|
| Node / npm 版本 + 路径 | `PiEnvironment.detect()`（`PiEnvironment.kt:200-254`）**已探测** node/npm 的 path 与 version，产出 `tool(path, version)` 结构（`{found, path, version}`），只差把它接到诊断页 | 复用现成探测，几乎零新增 |
| 插件版本 | 运行时无现成读取；`build.gradle.kts:12` 有 `version = "0.5.9"`，`:370` 注入 plugin.xml | 新增一处只读接口读插件版本 |
| 构建时间 + commit ID | 现状无任何注入；需 gradle 在构建期生成（人类可读时间戳 + `git rev-parse --short HEAD`） | 新增构建期资源，随包发布 |
| 用户主目录缩写 | 已有 `shortPath(path, homeDir)`（`SkillsPanel.tsx:33-38`，大小写不敏感、斜杠归一）；`homeDir` 已由后端 `manage.envDetect` 返回（`PiManage.kt:353`）；前端类型 `EnvDetectResult.homeDir`（`manage.ts:261`）已存在 | 把函数提取为公共 tool 并复用到两个面板 |
| 响应式「宽显全路径 / 窄显缩写」 | 已有 CSS 模式 `.skill-path-full` + `.skill-path-short`（`styles.css:5231-5246`，≤640px 切换） | 沿用现成模式，不新增交互 |

**据此**：本条无技术难题、无 internal API（插件版本走 `PluginManagerCore` 公共 API；构建信息走构建期生成资源，不碰 IDE 内部），风险集中在「读不到时的降级显示」和「缩写边界」两个纯展示细节。

## 现状缺口（要改的具体位置）

1. **诊断页环境卡片**（`DiagnosticsPanel.tsx:118-139`，`data-testid="manage-env"`）只显示 pi 的 `version + path` + 硬编码的 `~/.pi/agent`（`:133`）+ 更新按钮；**没有** node/npm、插件版本、构建信息。
2. **环境数据接口**：诊断页走 `api.environment()` → `manage.env` → `PiManage.environment()`（`PiManage.kt:604-613`），只返回 `found/path/version/agentDir` 四项；node/npm 探测虽在 `PiEnvironment.detect()` 现成，但走的是另一个接口 `manage.envDetect`（引导页用）。两条要打通。
3. **设置页路径**（`SettingsPanel.tsx:66`）：`settings.json` 绝对路径直接 `.mono` 输出，未缩写。
4. **缩写函数作用域**：`shortPath` 目前是 `SkillsPanel.tsx` 内的私有函数，未导出；`homeDir` 也只在 `manage.envDetect` 的返回里，诊断页的 `manage.env` 不带。

## User Scenarios & Testing

### US1 - 诊断页看到 Node / npm 的版本和路径 (P1)
进入 Manage → 诊断页，环境卡片除了 pi，还显示：
- `node vX.Y.Z` + 可执行文件路径
- `npm vX.Y.Z` + 可执行文件路径

每个工具读不到时显示明确的「未找到」态（`node/npm` 缺失本就是安装阻塞原因，`PiEnvironment.detect()` 的 `installBlocker` / `canInstall` 已区分 `no-node` / `node-version` / `no-npm`），不得留白或报 `?` 让人误以为加载中。只读展示，不新增任何安装/切换动作。

### US2 - 诊断页看到插件版本与构建信息 (P1)
同卡片显示插件自身的：
- **版本号**（如 `0.5.10`）
- **构建时间**：人类可读时间戳（如 `2026-11-16 20:15`）
- **commit ID**：短哈希（如 `7147df2`）

三项都随插件包发布、只读。构建信息缺失（如开发态直接 runIde 未生成资源）时降级为「未知」而非报错或空白。

### US3 - 设置/诊断页路径按用户主目录缩写 (P1)
设置页的 `settings.json` 路径、诊断页里所有**以用户主目录为前缀**的文件/目录路径（pi 可执行文件路径、node/npm 路径、agent 目录、`~/.pi/agent` 等）：
- 落在主目录下 → 显示为 `~/相对路径`（大小写不敏感匹配；`C:\Users\X\...` 与 `C:/Users/X/...` 都要能缩写）
- 不在主目录下 → 保持原绝对路径
- **响应式**：面板宽时用完整绝对路径，窄（≤640px，沿用现有断点）时切到 `~/` 缩写；沿用 `.skill-path-full` / `.skill-path-short` 现有 CSS 模式，不新增 tooltip、不新增切换开关

### US4 - 缩写不改变任何真实路径 (P1)
缩写只作用于展示层：复制、点击打开、保存回写用的仍是原始绝对路径。任何桥接请求、配置文件、错误详情都不因展示缩写而被改成 `~/...`（后端 `BridgeService.kt:873-874` 已有 `~/` 展开能力，但本规格不依赖它——绝不让缩写值流回存储）。

## Requirements

- **FR-001** 诊断页 MUST 展示 node 与 npm 各自的 `version` 与 `path`，数据来源 MUST 复用 `PiEnvironment.detect()` 的探测结果（不可另行 spawn 或猜测）。
- **FR-002** node/npm/pi 任一工具未找到或版本读取失败时，对应行 MUST 显示明确降级文案（未找到 / 未知版本），不得显示空白、`?` 或残留加载态；MUST NOT 让某一项失败导致整卡片渲染失败。
- **FR-003** 诊断页 MUST 展示插件版本号、人类可读构建时间戳、短 commit ID 三项；任一构建信息缺失时 MUST 降级为「未知」，MUST NOT 抛错或阻断面板。
- **FR-004** 插件版本 MUST 从运行时插件描述符读取（`PluginManagerCore` 公共 API 或等价公开途径），MUST NOT 硬编码版本号，也 MUST NOT 使用 internal API（verifyPlugin 硬拒项）。
- **FR-005** 构建时间戳与 commit ID MUST 在构建期生成并随包发布（gradle 生成资源或注入 plugin.xml），人类可读时间戳采用本地时区 `YYYY-MM-DD HH:mm` 形式，commit ID 为短哈希；**版本号仍只由发版流程决定**，本规格不引入任何自动升版逻辑（沿用项目「版本号只在发版时定」硬规则）。
- **FR-006** 设置页与诊断页中所有以用户主目录为前缀的路径 MUST 以 `~/` 缩写形式展示；不在主目录下的路径 MUST 保持原样。缩写匹配 MUST 大小写不敏感且斜杠归一（`/` 与 `\` 等价）。
- **FR-007** 缩写 MUST 复用 `shortPath` 的同一份实现（提取为公共工具，消除 SkillsPanel 私有副本），MUST NOT 在多个面板各写一遍缩写逻辑。
- **FR-008** 响应式 MUST 沿用现有 `.skill-path-full` / `.skill-path-short` 与 640px 断点：宽显全路径、窄显缩写；MUST NOT 新增 tooltip、切换开关或其它交互。
- **FR-009** 缩写 MUST 只作用于展示层：MUST NOT 改变任何用于复制/打开/回写/桥接请求的真实路径值。
- **FR-010** 新增用户可见文案 MUST 双语（en/zh）；保留现有 `manage-env` / `pi-version` 等 testid 不改名（e2e 与 011 文档依赖它们）。

## Decisions（用户 2026-11-16 已拍板）

| # | 问题 | 结论 |
|---|---|---|
| Q1 | 两条需求拆几份 spec | **合并为 1 份**（036）：都只改设置/诊断展示层，同批交付 |
| Q2 | 构建信息形态 | **人类可读时间戳 + commit ID**（均随包发布）；版本号走发版流程，不自动升 |
| Q3 | 缩写后如何看完整路径 | **响应式拉宽即可见**，不可见也接受；不做 tooltip、不做切换开关 |
| Q4 | 缩写范围 | **凡基于用户主目录的路径全部缩写**（设置页 settings.json 路径 + 诊断页所有路径），不限于单一字段 |

## 待 plan 阶段决定的技术问题（本规格不锁定）

- 打通 node/npm 探测到诊断页的具体方式：扩展 `manage.env` 返回，还是让诊断页并读 `manage.envDetect`（后者已带 node/npm/homeDir，但语义偏引导页）。
- 构建信息的生成与注入载体（gradle 生成资源文件 vs 写 plugin.xml），以及 runIde 开发态的降级表现。
- `shortPath` 提取到哪里（如 `lib/path.ts`）与 `homeDir` 的传递方式（诊断页数据接口带 `homeDir` 字段）。

## 不做的事

- 不做 node / npm / pi 的安装、升级、切换、路径配置（诊断页只读展示；安装/更新沿用现有入口）。
- 不做插件自动更新检查（无 check-update 语义，插件不猜「有新版本」）。
- 不新增 tooltip、路径切换开关、复制按钮等交互（响应式已满足看全路径的需求）。
- 不改变任何文件的真实路径、不改写桥接契约的写操作、不引入自动升版逻辑。
- 不在本规格内写 plan/tasks 或实现（用户明确只产出 spec）。

## 与既有规格/事实的关系

- **复用 034** 的 `homeDir` 返回与 `shortPath` 缩写口径（含大小写不敏感、斜杠归一），不改其语义。
- **复用 003** 的诊断页「区分未加载 / 失败」原则：未找到工具是明确状态，不是失败，也不是空白。
- **不改** 028 的 Node ≥ 22.19 门槛与 011 的 CLI 输出解码——本条只把已有探测结果显示出来，不重做探测。
- 保留 `DiagnosticsPanel.tsx` 现有 testid（`manage-env` / `pi-version` / `pi-update` 等），不破坏 011 文档与 e2e 锚点。

## 验证计划（实现后填写，本规格仅列判据）

| 层 | 用例 | 期望 |
|---|---|---|
| 单测 | `shortPath` 提取后：主目录下（含大小写差异、正反斜杠）/ 主目录外 / home 为空 | `~/` 缩写正确；目录外原样；home 缺失不崩 |
| 单测 | 插件版本/构建信息读取：正常 / 资源缺失 | 正常显示三项；缺失降级「未知」不抛错 |
| 单测 | node/npm/pi 探测结果映射：全有 / 部分缺失 / 全缺 | 各行列如下载状态、无整卡片崩溃 |
| vitest | 诊断页与设置页组件 | 新增信息行齐全；双语键齐全；旧 testid 保留 |
| e2e | mock 诊断页注入 node/npm/插件/构建字段 | 版本+路径+构建信息按断言显示；降级态可见 |
| e2e | 响应式：宽 / ≤640px 两档 | 宽显绝对路径、窄显 `~/` 缩写；无 tooltip/开关 |
| 静态 | verifyPlugin | 无 internal API 命中（插件版本走公共 API） |
| 真机 | 真机 JCEF 打开诊断页与设置页 | node/npm/插件/构建信息正确；路径缩写与响应符合预期 |

## 开放问题

无阻塞项。用户四条疑问（spec 拆分 / 构建信息形态 / 完整路径可见方式 / 缩写范围）已于 2026-11-16 全部拍板，结论见 Decisions。

# Implementation Plan: 项目级资源的信任模型

**Branch**: `002-project-trust` | **Date**: 2026-11-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-project-trust/spec.md`

## Summary

让「项目级配置是否生效」这件事从不可见变为可见、可操作。核心是读/写 pi 的 `trust.json`，
把信任态暴露到 UI，并按信任态决定 pi 进程的启动参数。

顺带修掉一个真 bug：`PiManage.skillsList()` 用 `File(".pi/skills")` 相对路径扫描项目级目录，
解析到的是 **IDE 进程的工作目录**而非项目根——多项目窗口下会串台或列空。改为以项目 basePath 为基准。

## Technical Context

**Language/Version**: Kotlin（JDK 21）、TypeScript / React 18

**Primary Dependencies**: 现有 `PiCliRunner.agentDir()`、`PiProcessManager`、`BridgeService`（per-project 路由）

**Storage**: `~/.pi/agent/trust.json`（唯一信任存储，不新增）；项目根下 `.pi/{skills,mcp.json,settings.json}`

**Testing**: JUnit（路径归一化、trust.json 读写/损坏）、Vitest、Playwright（面板状态）

**Target Platform**: IntelliJ 平台 233–263.*

**Project Type**: 单仓双端（宿主 + web）

**Performance Goals**: 面板打开时读一次 `trust.json`（< 10ms），不做长缓存

**Constraints**: 不改动 pi 的信任语义；`trust.json` 写坏会导致用户在终端也无法使用 pi，必须 fail-safe

**Scale/Scope**: 单项目几十个 skills、个位数 MCP 服务器

## Constitution Check

| 原则 | 落实方式 | 结论 |
|---|---|---|
| **I. 双端契约同步** | `trust.get/grant/revoke` 三方法同时在 `BridgeService`、`types.ts`、`mock.ts` 落地；`scope` 字段与 001 共用同一枚举 | PASS |
| **II. 断言含几何与行为** | 面板状态靠文案 + `data-state` 属性断言（生效/未生效），不只断言元素存在 | PASS |
| **III. 不依赖环境假设** | 路径判定必须走 `canonicalPath`，不假设大小写敏感或分隔符形式 | PASS |
| **IV. 写操作可回滚可解释** | `trust.json` 写前备份 + JSON 校验 + 原子写；失败透传 | PASS |
| **V. JCEF 走 bridge** | 全部经既有 bridge，无 JS 注入 | PASS |
| **VI. 凭据零托管** | 信任操作不涉及凭据 | PASS |

无违反项。

## Project Structure

```text
src/main/kotlin/dev/pi/agent/
├── process/
│   ├── PiTrust.kt                   # 新增：trust.json 读写 + 路径归一化
│   └── PiProcessManager.kt          # 按信任态决定是否追加 --approve
├── manage/
│   └── PiManage.kt                  # skillsList(projectBasePath) 修正相对路径；条目补 scope
└── bridge/
    └── BridgeService.kt             # +trust.get / trust.grant / trust.revoke；skills.list 带上 projectBasePath

web/src/
├── bridge/{types.ts, mock.ts}       # 契约 + mock
├── components/ManageView.tsx        # 顶部信任横幅（未信任时）
├── components/manage/SkillsPanel.tsx# 层级标签 + 未生效样式
└── styles.css                       # 未生效条目的样式（弱化 + 原因 tooltip）

src/test/kotlin/dev/pi/agent/process/
└── PiTrustTest.kt                   # 路径归一化、缺失、损坏、写入回滚
```

**Structure Decision**: `PiTrust` 放在 `process/` 而非 `manage/`——进程启动（是否传 `--approve`）与 UI 都要用它，
属于进程层的环境事实，不是管理页的私有逻辑。

## 关键技术决策

### 1. 路径归一化是正确性的唯一关键

`trust.json` 的键是 pi 写入的绝对路径。插件要判断「当前项目是否在里面」，必须做与 pi 一致的比较：

```kotlin
fun normalize(path: String): String =
    File(path).canonicalFile.path.lowercase(Locale.ROOT).replace('\\', '/')
```

- `canonicalFile` 处理符号链接与 `..`
- `lowercase` 处理 Windows 大小写不敏感（NTFS 默认）
- 分隔符统一避免 `D:\a` 与 `D:/a` 失配

**风险**：Linux/macOS 上大小写敏感，`lowercase` 会把 `/home/Foo` 与 `/home/foo` 误判为同一项目。
因此仅在 `OsProcess.isWindows` 时启用小写化，其他平台只做 `canonicalPath`。

### 2. 信任态如何影响 pi 进程

`PiProcessManager` 启动 `pi --mode rpc` 时：
- 项目已信任 → 不追加参数（pi 自己会读 trust.json）；
- 项目未信任 → 同样不追加。**默认不替用户做信任决定**，只是把状态显示出来。

只有用户在本会话内点了「信任本项目」且我们希望立刻生效时，才对该次启动追加 `--approve`。
这样避免插件擅自放大权限——符合「不在用户未确认时改变安全姿态」的底线。

### 3. skillsList 的路径修正

签名从 `skillsList()` 改为 `skillsList(projectBasePath: String?)`：

```kotlin
val dirs = buildList {
    add(File(PiCliRunner.agentDir(), "skills") to "user")
    projectBasePath?.let {
        add(File(it, ".pi/skills") to "project")
        add(File(it, ".agents/skills") to "project")
    }
}
```

`BridgeService` 需要拿到项目根：它已经是 per-project 路由（token 绑定项目），
从持有 `Project` 的位置取 `project.basePath` 传入即可。

### 4. trust.json 写入

```json
{ "<canonical absolute path>": true }
```

- 读：`JsonObject`，任何解析失败 → 返回 `null` + 错误信息，调用方按「未信任」处理（fail-safe）
- 写：`copyTo(trust.json.bak)` → 重建 JsonObject（保留其他项目的键）→ 校验 → 原子写（临时文件 + move）
- 撤销：删除该键；若删除后为空对象，保留 `{}` 而不删文件（pi 对缺失与空对象的处理应等价，但保留文件更安全）

## 依赖

- `001-manage-completeness` 的 T011（项目级 MCP 停用）依赖本规格的信任读取能力。
- 本规格的 `scope` 概念与 001 共用，建议 001 先落地 `types.ts` 的 `scope` 字段。

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 误写 `trust.json` 导致用户在终端也无法正常使用 pi | 高 | 写前备份 + 原子写 + 只增删目标键，整体结构不动 |
| 大小写归一化在 Linux 上误判 | 中 | 仅 Windows 小写化 |
| 用户在终端已信任，插件缓存了旧状态 | 中 | 每次打开面板重新读取，不做长缓存 |
| IDE 项目 basePath 与实际 git 根不同 | 中 | 以 IDE 的 basePath 为准（与 pi 的 cwd 一致性由用户在 IDE 中打开的项目决定） |

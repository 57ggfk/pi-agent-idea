# Implementation Plan: IDE 侧动作的自动化覆盖

**Branch**: `004-action-coverage` | **Date**: 2026-11-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-action-coverage/spec.md`

## Summary

给 IDE 侧动作补上三层原本缺失的自动化：**注册**（动作 id 与分组是否存在）、**可用性**（`update()` 在各种
DataContext 下的 enabled 状态）、**内容拼装**（真正要发给 pi 的文本）。

关键取舍：不试图用 robot/UI 自动化点菜单（脆弱且慢），而是
① 用 IntelliJ 平台测试框架驱动 `ActionManager` 与 `AnActionEvent`；
② 把「拼给 pi 的文本」从 action 里抽成纯函数，沿用项目已有的 `CommitMessageBuilder` + 单测范式。

图标渲染这类纯视觉问题不强行自动化，落进冒烟清单并标注原因。

## Technical Context

**Language/Version**: Kotlin（JDK 21）、JUnit 5

**Primary Dependencies**: 需新增 `testFramework(TestFrameworkType.Platform)`（IPG 2.19.0）；
现有 `BasePlatformTestCase` / `LightPlatformTestCase` 均来自该依赖

**Storage**: 无

**Testing**: IntelliJ 平台测试夹具 + 现有 JUnit 5；e2e 沿用 CDP

**Target Platform**: IntelliJ IDEA Community 2024.3.1（编译基准线）

**Project Type**: 单仓双端的宿主侧测试补强

**Performance Goals**: 平台测试单次 < 60s；CI 缺依赖时可跳过

**Constraints**: 不能因为加平台测试而让 `buildPlugin` 变慢或引入运行时依赖（`testImplementation` 隔离）

**Scale/Scope**: 4 个动作（SendFile / ExplainFile / SendSelection / GenerateCommitMessage）、
3 个菜单分组、7 种 DataContext 形态

## Constitution Check

| 原则 | 落实方式 | 结论 |
|---|---|---|
| **I. 双端契约同步** | 不涉及双端 | N/A |
| **II. 断言含几何与行为** | 本规格正是该原则的延伸：断言 enabled 与 description，而不是「动作类存在」 | PASS |
| **III. 不依赖环境假设** | 测试固定编译基准产品，不假设多产品一致 | PASS |
| **IV. 写操作可回滚** | 测试不写用户配置（提交信息生成走 mock pi） | PASS |
| **V. JCEF 走 bridge** | 不涉及 | N/A |
| **VI. 凭据零托管** | 测试不使用真实凭据 | PASS |

无违反项。

## Project Structure

```text
build.gradle.kts                     # dependencies.intellijPlatform 加 testFramework(TestFrameworkType.Platform)

src/test/kotlin/dev/pi/agent/editor/
├── PiActionsRegistrationTest.kt     # 新增：动作存在性 + 分组 + 清单漂移
├── PiEditorActionsUpdateTest.kt     # 新增：7 种 DataContext × 4 动作的 enabled/description
└── PiActionPayloadTest.kt           # 新增：抽出的纯函数（拼 prompt 文本）

src/main/kotlin/dev/pi/agent/editor/
└── PiEditorActions.kt               # 重构：把「拼发送内容」抽成 `PiActionPayload` 纯函数对象

docs/
└── SMOKE_TEST.md                    # 新增：真机冒烟清单（操作 / 通过判据 / 可否自动化）
```

**Structure Decision**: 纯函数抽到 `PiActionPayload`（同包，`object`），action 只负责取 DataContext 与调用它。
这样 90% 的逻辑可以用普通 JUnit 覆盖，不必进平台夹具，测试跑得快、也不会因为 IDE 服务未初始化而 flaky。

## 关键技术决策

### 1. 先补平台测试依赖

当前 `build.gradle.kts` 只引了 JUnit 5，注释里提到「IPG 会把平台测试框架自动加到 Test task」，
但没有显式 `testFramework(TestFrameworkType.Platform)`。需要补：

```kotlin
dependencies {
    intellijPlatform {
        testFramework(TestFrameworkType.Platform)
    }
}
```

若补完后 `BasePlatformTestCase` 仍不可解析，退化为 `LightPlatformTestCase` + 手动 `ApplicationManager`。

### 2. 注册测试怎么查分组

`ActionManager.getAction(id)` 只能证明「动作被解析」，不能证明「挂在正确的 group 下」。
分组校验用：

```kotlin
val group = ActionManager.getInstance().getAction("PiAgent.EditorPopup") as ActionGroup
assertTrue(group.getChildren(null).any { it is SendFileToPi })
```

即先断言 group 存在，再断言其 children 包含预期动作。

### 3. 清单漂移检测（FR-003）

读插件描述符里的全部动作 id，与测试中硬编码的期望集合做**双向**比对：

```kotlin
val declared = descriptorActions()   // 递归遍历 <actions> 节点
assertEquals(expected.sorted(), declared.sorted())
```

新增动作忘了登记 → 测试失败并打印差集。这是防止这份测试本身腐烂的唯一办法。

### 4. DataContext 矩阵

```kotlin
fun ctx(vararg pairs: Pair<DataKey<*>, Any?>): DataContext =
    SimpleDataContext.builder().apply { pairs.forEach { (k, v) -> add(k, v) }.build() }
```

| # | 场景 | 期望 |
|---|---|---|
| 1 | `EDITOR` + `VIRTUAL_FILE` | SendFile/Explain/SendSelection 均可用 |
| 2 | 仅 `VIRTUAL_FILE` | SendFile、Explain 可用（Explain 不再强制 editor） |
| 3 | 仅 `VIRTUAL_FILE_ARRAY`（1 元素） | 可用（正是曾经的恒灰场景） |
| 4 | 目录 | 不可用 + description 含原因 |
| 5 | 二进制 | 不可用 + description 含原因 |
| 6 | > 256KB 文本 | 不可用 + description 含原因 |
| 7 | 空上下文（无 project） | 不可用，不抛异常 |

### 5. 纯函数抽取

`PiEditorActions` 当前在 action 里拼字符串。抽出：

```kotlin
object PiActionPayload {
    fun fileMessage(relativePath: String, content: String): String
    fun selectionMessage(relativePath: String, line: Int, selection: String): String
    fun explainMessage(relativePath: String, line: Int?, content: String): String
}
```

单测断言：含路径、含 `:line`（有行号时）、无 editor 时**不出现伪造行号**。
这与 `CommitMessageBuilder` + `CommitMessageBuilderTest` 的既有范式一致。

### 6. 冒烟清单

`docs/SMOKE_TEST.md` 表格三列：操作 / 通过判据 / 可否自动化。首批 8 项：

1. Find Action 能搜到 4 个动作
2. 项目树右键出现 Pi Agent 组且两项可点
3. 编辑器右键出现三项
4. 编辑器标签页右键
5. VCS 提交面板出现 Generate Commit Message
6. 工具窗口图标在浅色/深色 New UI 下不是色块（**不可自动化**）
7. 窄窗（430px）下 Chat/Sessions/Manage 三页无横向溢出
8. 审批卡片 Allow / Deny 两条路径

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 平台测试首次运行需下载 IDE 包 | CI 慢或超时 | 允许缺失时 `assumeTrue` 跳过并打印原因 |
| `SimpleDataContext` 构造的 context 与真实 DataContext 行为有差 | 测试假绿 | 先修 001 已知的 `VIRTUAL_FILE_ARRAY` 场景，用它验证夹具真实有效 |
| 动作 id 重命名导致测试与实现同时改 | 漂移检测失效 | 双向比对保证改名必须同步改清单 |
| 平台测试污染用户配置目录 | 影响真实环境 | 测试用临时目录 + `PI_CODING_AGENT_DIR` |

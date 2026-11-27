# 技术方案：IDE 动作路由到当前实例

**Spec**: [spec.md](./spec.md) · **编号**: `20261127-214745` · **Issue**: #7

## 落点

- 分支：`release/0.5.11`（工作树 `D:\code\github\pi-agent-idea-wt\release-0.5.11`，
  远端 `origin/release/0.5.11`，HEAD `7fa419f`）

## 一、根因（读代码得到）

### 1.1 前端是对的

`web/src/bridge/jcef.ts`：

```ts
const INSTANCE_ID =
  typeof window === "undefined" ? 1 : (new URLSearchParams(window.location.search).get("instance") ?? "1");
const INSTANCE_PARAM = `&instance=${INSTANCE_ID}`;
```

每个桥接请求都带 `?instance=N`（`/bridge?instance=N`、`/bridge/poll?instance=N`）。

### 1.2 IDE 侧漏了

`src/main/kotlin/dev/pi/agent/bridge/BridgeService.kt`：

```kotlin
fun pushIdePrompt(text: String, refs: List<Pair<String, Boolean>> = emptyList()) {
    wirePiEvents()
    PiProcessManager.getInstance(project).client()      // 起的是 1 号
    push(buildJsonObject { ... })                       // instanceId 默认 1
}

fun pushIdeRefs(refs: List<Pair<String, Boolean>>, fromDrop: Boolean = false) {
    if (refs.isEmpty()) return
    wirePiEvents()
    PiProcessManager.getInstance(project).client()
    push(buildJsonObject { ... })                       // instanceId 默认 1
}
```

`push(record, instanceId = 1)` —— **默认值就是 1**，两处调用都没传。

### 1.3 动作的调用方

`src/main/kotlin/dev/pi/agent/editor/PiEditorActions.kt`：
`PiSelectionAction.actionPerformed`（Explain / Fix / Send Selection）、
`ExplainFileWithPi`、`SendFileToPi`、`AddDirectoryToPi` —— 五处都调上面两个方法，
都不带实例信息。

## 二、方案

### 2.1 判定「当前实例」

**采纳：工具窗口 ContentManager 的选中态**（候选 A/B 的合并实现）：

```kotlin
/** 工具窗口里当前选中的 Pi 实例 id；没有 Pi 实例时返回 null。 */
private fun currentInstanceId(): Int? {
    val tw = ToolWindowManager.getInstance(project).getToolWindow("Pi Agent") ?: return null
    val selected = tw.contentManager.selectedContent
    val panel = selected?.component as? PiAgentPanel
    if (panel != null) return panel.id
    // 选中的是浏览器标签页 → 最近一次选中的 Pi 实例（记在工厂侧）
    return lastPiInstanceId
}
```

「最近一次选中的 Pi 实例」由 `PiAgentToolWindowFactory` 在
`ContentManagerListener.contentSelected` 里记一份（浏览器标签页不算）。

**退化规则**（FR-004）：
1. 选中的是 Pi Content → 用它
2. 选中的是浏览器标签 / 选不中 → 用最近一次选中的 Pi 实例
3. 一个都没有 → 保持今天的行为（起 1 号）

这样 `PiEditorActions` 五处动作都不用改调用方式——只要 `pushIdePrompt` /
`pushIdeRefs` **自己**取 instanceId 并传给 `push` 与 `client(instanceId)`。

### 2.2 改动点

| 文件 | 改什么 |
|---|---|
| `BridgeService.kt` | `pushIdePrompt` / `pushIdeRefs` 解析 instanceId，`push(..., instanceId)` + `client(instanceId)` |
| `PiAgentToolWindowFactory.java` | 记「最近一次选中的 Pi 实例」，暴露给 BridgeService |
| `PiEditorActions.kt` | **不改**（动作语义不变，路由在 BridgeService 内解决） |

### 2.3 要不要切前台

**本期不改**：动作仍只 `activate` 工具窗口。理由：切 Content 会让用户在
「编辑 Pi 2 的输入框」和「Pi 2 标签」之间跳，交互更乱；且内容落对了实例，
用户从内容出现在哪能看出来。若真机反馈需要，再单独加。

## 三、测试计划

先补断言（红）→ 再改实现（绿）。

**Kotlin（`src/test/kotlin/dev/pi/agent/`）**
- `PiInstanceRoutingTest`：实例路由是纯函数
  `resolveTargetInstance(selectedId, lastPiId, liveIds): Int?`
  - 选中的 Pi 实例 → 用它
  - 选中的是浏览器 → 用 lastPiId
  - 都没有 → null（走退化）
- `BridgeService` 侧：`pushIdePrompt` 推给目标实例（mock transport 断言 instanceId）

**前端**
- 若采用「前端心跳」方案才需要前端断言；本方案（IDE 侧判定）**零前端改动**

## 四、真机验收

1. 开两个 Pi 实例 → 在 Pi 2 里右键「用 Pi 解释」→ 内容进 Pi 2，Pi 1 不动
2. 单实例右键 → 行为与现在一致
3. 切到浏览器标签页后右键 → 内容进最近用过的 Pi 实例

## 五、风险

- **「当前实例」判错**：判据从「固定 1」变成「动态」，需要真机确认选中态的可靠性
  （工具窗口重建、Content 替换时会不会丢）。
- **退化路径**：没实例时的自愈（起 1 号）不能被改坏——这是 FR-003。

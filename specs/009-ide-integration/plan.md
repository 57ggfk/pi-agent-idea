# Implementation Plan: IDE 集成修复与增强

**Feature**: `specs/009-ide-integration/spec.md`

**Branch**: `release/0.5.2`

**Status**: Ready to implement（US2 的根因需真机复核）

## 摘要

四件事，全在宿主侧：① 两个右键分组加图标；② 目录右键不再整片灰（Explain 支持目录、Send 明确拒绝并说明）；
③ 新增 `Add Directory to Pi`（NIO 遍历 + 摘要文本）；④ pi 写类工具结束后防抖刷新 VFS 并使 `files.list` 缓存失效。

## 技术上下文

- 动作注册：`src/main/resources/META-INF/plugin.xml` 顶层 `<actions>`，
  两个 group：`PiAgent.EditorPopup`（`EditorPopupMenu`）、`PiAgent.FilePopup`（`ProjectViewPopupMenu` + `EditorTabPopupMenu`）。
- 动作实现：`src/main/kotlin/dev/pi/agent/editor/PiEditorActions.kt`（`selectedVirtualFile` / `projectRelativePath` /
  `fileActionBlockReason` 已有，逻辑要在这里扩）。
- 事件接入：`BridgeService.wirePiEvents()` 里 `manager.addEventListener { event -> ... }`，已有
  `maybeCaptureBaseline(event)`（`EDIT_TOOLS` 集合已存在）与 `messageQueue().onPiEvent(event)`。
- 缓存：`BridgeService.filesCache`（30s TTL）与 `projectFilesCached(force)`。
- 测试：`./gradlew test`（JUnit5 + `@TempDir`）；真机 `scripts/e2e-ide.ps1`；
  IDE 右键菜单本身没有自动化，只能真机矩阵。

## 设计决策

### D1. 图标：复用工具窗字形

```xml
<group id="PiAgent.FilePopup" popup="true" text="Pi Agent" icon="/icons/piAgent.svg">
```
- `icons/piAgent.svg` 已是 16×16、纯描线、颜色写在 path 上，并配 `_dark.svg`，平台会按菜单行高缩放。
- **不新建**菜单专用图标：两份字形一旦分叉就会长期不同步；工具窗图标已经是「π 单字」，缩到 13px 仍可辨。
- 校验方式：真机浅/深主题各截图一张，比对相邻系统分组图标的高度与基线。

### D2. 可用性判定抽成纯函数（US2 的关键）

```kotlin
// editor/ActionAvailability.kt
enum class TargetKind { File, Directory, Binary, Oversized, Multi, None }
data class Availability(val enabled: Boolean, val reason: String?)

fun availability(action: PiFileAction, kind: TargetKind): Availability
```
- `TargetKind` 由 `VirtualFile` 属性推导（`isDirectory` / `fileType.isBinary` / `length` / 多选标志），
  推导逻辑与判定逻辑分开，判定部分可 100% 单测。
- 动作矩阵（初版，落地时以真机结果校准）：

| 目标 | Send File | Explain File | Add Directory |
|---|---|---|---|
| 普通文本 | 可用 | 可用 | — |
| 目录 | 禁用（指向 Add Directory） | **可用**（解释目录结构） | 可用 |
| 二进制 | 禁用（原因） | **可用**（只送路径） | — |
| >256KB | 禁用（原因） | 可用 | — |
| 多选 | 可用（首个） | 可用（首个） | 目录优先 |

- `update()` 改为读该函数；`presentation.description` 写原因（008 之后走 bundle key）。

### D3. 目录清单：NIO 遍历，纯函数可测

```kotlin
// editor/DirectoryListing.kt
data class DirectoryEntry(val path: String, val kind: Kind)   // File / Dir
data class DirectoryListing(val root: String, val entries: List<String>, val omitted: Int, val truncated: Boolean)

fun listDirectory(root: Path, projectRoot: Path?, limits: Limits = Limits()): DirectoryListing
```
- `Files.walkFileTree` + `FileVisitOption` **不跟随符号链接**（默认即不跟随），深度 12、条目 5000、
  输出清单 200 条；跳过 `EXCLUDED_DIRS`（与 `BridgeService.EXCLUDED_PATHS` 同名集合，抽常量共用）。
- 在 `ProgressIndicator`/后台线程执行：`ApplicationManager.getApplication().executeOnPooledThread`
  或 `ProgressManager.getInstance().runProcessWithProgressSynchronously`（大目录时给进度）。
- 生成文本：

```
Here is the directory `web/src/components` (12 files, 3 subdirectories):

web/src/components/App.tsx
web/src/components/Composer.tsx
...

Read whatever you need. 
```
- 超大目录追加 `… 2988 more entries omitted (raise the limit by listing a subdirectory)`。

### D4. VFS 刷新：监听事件 + Alarm 防抖 + 缓存失效

```kotlin
// bridge/VfsRefresh.kt
object VfsRefresh {
    fun onPiEvent(project: Project, event: JsonObject)   // 由 wirePiEvents 调用
    fun flushNow(project: Project)                       // 供测试与 settle 使用
}
```
- 触发条件：`tool_execution_end` 且 `toolName ∈ EDIT_TOOLS ∪ WRITE_TOOLS ∪ {"bash","powershell"}`；
  `agent_settled` 时做一次整体刷新。
- 路径推导：从 `args` 里取 `path`/`file_path`/`file`（与前端 `filePathOf` 同规则），`bash` 无路径 → 整体刷新。
- 防抖：`com.intellij.util.Alarm` 单例，400ms；同一批路径合并。
- 执行：`VirtualFileManager.getInstance().asyncRefresh(paths)`（路径级）或 `asyncRefresh(null)`（整体），
  回调里 `BridgeService.getInstance(project).invalidateFilesCache()`（新增 internal 方法，置 `filesCache = null`）。
- **不覆盖未保存编辑**：只用 VFS 刷新，不调用 `FileDocumentManager.saveDocument`；
  `asyncRefresh` 对「文档已修改」的虚拟文件不会覆盖内存内容（平台自身保证），真机再确认一次。

### D5. 分组图标与「整片灰」的关系

有些平台上，若一个 popup group 的子项**全部** disabled，分组本身会显示为灰色不可展开。
因此 US2 与 US3 是同一修改的两面：目录上有一个可用项（Add Directory）之后，整组自然恢复可展开。
这也是把「加目录」排进同一 feature 的原因。

## 触及文件

| 文件 | 改动 |
|---|---|
| `src/main/resources/META-INF/plugin.xml` | 两个 group 加 `icon`；`PiAgent.FilePopup` 增加 `PiAgent.AddDirectory` 动作 |
| `src/main/kotlin/dev/pi/agent/editor/PiEditorActions.kt` | 新建 `AddDirectoryToPi`；`ExplainFileWithPi` 支持目录/二进制；`update()` 走 `availability` |
| `src/main/kotlin/dev/pi/agent/editor/ActionAvailability.kt` | **新增**：`TargetKind` + 判定纯函数 |
| `src/main/kotlin/dev/pi/agent/editor/DirectoryListing.kt` | **新增**：NIO 遍历 + 摘要文本生成 |
| `src/main/kotlin/dev/pi/agent/bridge/VfsRefresh.kt` | **新增**：事件 → 防抖 → 刷新 → 缓存失效 |
| `src/main/kotlin/dev/pi/agent/bridge/BridgeService.kt` | `wirePiEvents` 调 `VfsRefresh.onPiEvent`；新增 `invalidateFilesCache()` |
| `src/test/kotlin/dev/pi/agent/editor/ActionAvailabilityTest.kt` | **新增**：矩阵全格 |
| `src/test/kotlin/dev/pi/agent/editor/DirectoryListingTest.kt` | **新增**：`@TempDir` 造树、排除、截断、深目录、符号链接（Windows 上跳过） |
| `src/test/kotlin/dev/pi/agent/bridge/VfsRefreshTest.kt` | **新增**：事件→路径推导（纯函数部分） |
| `MANUAL_TEST.md` | 新增「IDE 集成（v0.5.2）」段：右键矩阵 5 格 + 目录注入 + 刷新 |

## 顺序

1. 真机复核「整片灰」是文件还是目录（记录到本文件），必要时调整 D2 矩阵。
2. `ActionAvailability` + 单测（先断言）。
3. `DirectoryListing` + 单测。
4. `plugin.xml` 图标 + `AddDirectory` 注册；`ExplainFileWithPi` 扩目录；`update()` 收口。
5. `VfsRefresh` + `BridgeService` 接线 + `invalidateFilesCache`。
6. 真机矩阵逐格勾选 + 截图；`./gradlew test` 与 `scripts\e2e-ide.ps1` 回归。

## 风险

| 风险 | 缓解 |
|---|---|
| `VirtualFileManager.asyncRefresh` 在某些 remote/dev 文件系统上开销大 | 路径级优先；整体刷新只在 `agent_settled` 且距上次刷新 > 2s 时做 |
| 目录遍历在大仓上卡住 | 硬上限（5000 条目/12 层/200 条输出）+ 后台线程 + 单测覆盖截断 |
| 图标在 13px 渲染糊 | 描线宽度保持 1.5、viewBox 16；真机两个主题各看一眼，必要时把描线降到 1.4 |
| 动作在「新 UI 项目树」里 DataContext 与旧版不同 | 保留 `selectedVirtualFile()` 的双 key 兜底；再加 `LangDataKeys`? 仅在真机证明必要时才加 |
| 刷新导致 `@` 补全抖动（缓存反复失效） | 只在写类工具与 settle 时失效，读类不触发 |

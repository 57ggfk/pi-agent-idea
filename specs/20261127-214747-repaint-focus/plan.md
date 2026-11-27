# 技术方案：自动编辑后不闪、不夺走输入焦点

**Spec**: [spec.md](./spec.md) · **编号**: `20261127-214747` · **Issue**: #9

## 落点

- 分支：`release/0.5.11`（工作树 `D:\code\github\pi-agent-idea-wt\release-0.5.11`，
  远端 `origin/release/0.5.11`，HEAD `7fa419f`）

## 一、根因（读代码得到）

### 1.1 唯一的整帧重绘入口

`src/main/kotlin/dev/pi/agent/browser/JcefFrameRepaint.kt`：

```kotlin
object JcefFrameRepaint {
    fun forceRepaint(browser: JBCefBrowser?) {
        ...
        component.revalidate()
        component.repaint()
        cef.javaClass
            .getMethod("wasResized", Integer.TYPE, Integer.TYPE)     // ← 强制整帧
            .apply { isAccessible = true }
            .invoke(cef, component.width.coerceAtLeast(1), component.height.coerceAtLeast(1))
    }
}
```

注释写得很清楚：这是 0.5.4 为治 **OSR 帧残留**（切视图后屏幕上留着上一个视图的残影，
真机）引入的。反射调 `wasResized` 让渲染器在尺寸没变的情况下也产出一帧新的。

**整帧重绘 = webview 重新渲染 = 焦点丢失**（JCEF 里 DOM 焦点在重绘后不保留）。

### 1.2 前端只有一个重绘请求入口

`web/src/lib/repaint.ts`：

```ts
export function requestRepaint(): void {
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    void Promise.resolve((sender ?? defaultSend)()).catch(() => undefined);
  }, REPAINT_DEBOUNCE_MS);
}
```

→ `ide.repaint` → `BridgeService` 的 `"ide.repaint" -> repaintBrowser()` → `JcefFrameRepaint`。

### 1.3 现有的调用点都是「视图级」

| 调用点 | 场景 | 是不是视图级 |
|---|---|---|
| `App.tsx` 切 tab | 聊天/会话/管理 换页 | **是** |
| `ManageView.tsx` 进入管理页 | 换整块面板 | **是** |
| `ManageView.tsx` 切子 tab | MCP/包/技能/诊断 换页 | **是** |
| `store.ts` 切会话 / 新会话 | 换整个消息流 | **是** |

**没有一个是「pi 改完文件」**。→ 这正是 FR-003 要说的：**文件内容变化根本不该触发
整帧重绘**。

### 1.4 那「闪一下」从哪来

两条候选链：
1. **VFS 刷新 → IDE 重绘文件编辑器 → 工具窗口失去焦点**（IDE 层面的焦点，
   不是 webview 内的）。VFS 刷新在 `BridgeService.flushVfsRefresh`。
2. **webview 内 React 因状态更新重渲染 → 整块面板重画 → 视觉上「闪一下」**
   （不是 JCEF 整帧重绘，但看起来一样）。

**这两条要分开量**：前者是 IDE 焦点，后者是 webview 内的重绘。

## 二、方案

### 2.1 先量清楚（真机取证，阻塞项）

1. 在 composer 的 textarea 上挂 `focus` / `blur` 监听，把「谁夺走了焦点」记进
   `idea.log`（插件已有 JCEF console → idea.log 的通道：
   `PiAgentPanel` 会打 `JCEF console: [pi-agent] …`）。
2. 真机复现一次「pi 改文件」，看日志里是：
   - textarea 的 `blur` 事件触发了（→ webview 内失焦，需查谁触发的重绘）
   - 还是 textarea 根本没 blur、只是 IDE 侧窗口失焦（→ 焦点在 IDE 层，插件管不了）

**这一步的结果决定后面走哪条路**，不能靠猜。

### 2.2 分情况处理

**情况一：webview 内失焦（React 重渲染 / 整帧重绘导致）**
- 找出「pi 改文件」这条路径上多余的 `requestRepaint()` → 去掉（FR-003）
- 若仍有整帧重绘发生在输入期间 → 在 `requestRepaint` 里加一道闸：
  **输入框有焦点时不发重绘请求**（前端自己知道焦点状态）

**情况二：IDE 层失焦（VFS 刷新把编辑器抢了焦点）**
- 与 `flushVfsRefresh` 的时机有关：当前是工具调用结束就刷 VFS。
  改成**延后到输入框失焦时**（或在 `agent_settled` 之后再刷）
- IDE 层的焦点切换插件控制不了「不抢」，只能**减少抢的时机**

**情况三：都不成立（视觉闪烁来自别处）**
- 回到取证数据再判。

### 2.3 焦点保持（FR-005，仅在需要时）

若必须重绘且焦点会丢，前端记下 `document.activeElement` 与光标位置，
重绘后恢复：

```ts
// 重绘请求前记焦点，重绘后恢复
const active = document.activeElement as HTMLElement | null;
const selStart = active instanceof HTMLTextAreaElement ? active.selectionStart : null;
// …重绘…
if (active && selStart != null) { active.focus(); active.setSelectionRange(selStart, selStart); }
```

**优先避免重绘，而不是事后恢复焦点**——恢复焦点本身就是一种抢。

## 三、测试计划

**前端（vitest）**
- `repaint.test.ts` 扩展：输入框有焦点时，`requestRepaint()` **不**发请求（FR-003）
- 焦点记录/恢复是纯函数 → 单测

**Kotlin**
- 若改 `flushVfsRefresh` 的时机 → 抽出纯函数 `vfsRefreshDelay(streaming, composerFocused)` 便于单测

## 四、真机验收

1. pi 跑着 → 输入框打字 → 让 pi 改文件 → **输入框仍聚焦、字没丢、光标没动**
2. 切 tab / 切会话 → **没有残影**（OSR 那个 bug 没回来）
3. 大消息插入 → 画面正确

## 五、风险

- **删错重绘 = 残影回来**：0.5.4 的真机 bug。本批最需要真机的一条。
- **取证不足就动手**：2.1 的日志通道必须先通，否则是在猜。
- **两处「闪」可能同时存在**：VFS 刷新（IDE 层）与 React 重渲染（webview 层），
  修一条不见效，要靠取证数据定位。

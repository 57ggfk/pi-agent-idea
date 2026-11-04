# Implementation Plan: 会话导航与检索

**Feature**: `specs/006-session-navigation/spec.md`

**Branch**: `release/0.5.2`

**Status**: Ready to implement

## 摘要

三条能力共用一套「消息定位」地基：① 用户消息目录（锚点跳转）；② 会话内搜索（计数 + 循环导航 + 高亮）；
③ 全会话搜索（新增桥接 `sessions.search`，结果点进去复用 ② 的定位能力）。

## 技术上下文

- 消息模型：`web/src/store/types.ts` 的 `ChatItem[]`，文本在 `blocks[kind="text"]`，工具输出在
  `blocks[kind="toolcall"].result.output`。
- 渲染：`MessageList.tsx` → `.message-col` → `.item`（user/assistant/system）→ `Markdown` / `ToolCard`。
- 会话：`PiSessionIndex.list(projectPath)`（Kotlin）扫描 `~/.pi/agent/sessions/**/*.jsonl`，
  每行 `{type:"session"|"message"|"session_info", ...}`。
- 桥：`BridgeService.dispatch()` 白名单 + `web/src/bridge/types.ts` 的 `BridgeMethod` 联合类型（宪法 I/V）。
- mock：`web/src/bridge/mock.ts` 需实现 `sessions.search`，否则前端无法 e2e。

## 设计决策

### D1. 目录与搜索共用一个「消息锚点」注册表

`MessageList` 已按 `item.id` 渲染；新增 `data-item-id={item.id}` 到 `.item` 容器，
跳转统一走：

```ts
// web/src/lib/scrollToItem.ts
scrollToItem(listEl, itemId, { offset = 12, highlightMs = 2000 })
```
- 计算 `target.offsetTop - listEl.scrollTop`，用 `scrollTo({top, behavior:"smooth"})`；
  `prefers-reduced-motion` 时用 `behavior:"auto"`。
- 高亮：给元素加 `.flash-target` 类，2s 后移除（CSS 动画，不触碰 markdown DOM）。

### D2. 用户消息目录：顶栏按钮 + 浮层

- 入口按钮插在 `.tabs` 右侧（与 008 的 🔍 相邻），`data-testid="outline-btn"`，仅在
  `items` 中存在 user 消息时渲染（FR-003）。
- 浮层 `SessionOutline.tsx`：`role="listbox"`，每项 `role="option"`，单行 `text-overflow: ellipsis`，
  显示 `#序号 + 摘要`；当前可见项高亮（用 IntersectionObserver 简单版：滚动停止后取最近的 `.item`）。
- 宽度 `min(320px, calc(100cqw - 24px))`，`max-height: min(60vh, 420px)`，内部滚动；
  打开时按 `.app` rect 实测定位（沿用 `OptionsPopover` 的实测定位写法，宪法 III）。
- 增量：直接由 `items` 派生（`useMemo`），无需额外同步逻辑。

### D3. 会话内搜索：模型算命中，DOM 画高亮

```
hitsFromItems(items, query) -> Array<{ itemId, blockIndex, kind: "text"|"tool-output", offset, length, preview }>
```
- 纯函数，`toLowerCase()` 比较，字面量匹配（`indexOf`，不用正则），CJK 直接按子串。
- **计数与导航走模型**，保证与渲染无关、可单测；**高亮走 DOM**：
  - 优先 `CSS.highlights` + `Range`（JCEF/Chromium 支持）：构建文本节点索引
    （遍历 `.item` 下全部 text node，累积偏移），落成 Range；
  - 降级：用 `range.getClientRects()` 画绝对定位的高亮层（不改 DOM，不破坏 markdown）。
- 工具输出命中时：若该 `ToolCard` 折叠，先把 `searchFocusToolId` 写进 store，`ToolCard` 读它决定
  `open` 初值（把 `open` 从纯局部 state 改成 `local | forced`），渲染后再建 Range。
- 快捷键：`document.addEventListener("keydown", …)`，`(ctrl|meta)+f` → `preventDefault()` + 打开；
  `Enter` / `Shift+Enter` 导航；`Esc` 关闭并 `CSS.highlights.clear()`。
- 流式更新：`items` 变化时重算命中（`useEffect` 依赖 `items`），保持当前索引 clamp 在范围内。

### D4. 全会话搜索：桥接 `sessions.search`

```
POST /bridge  { t: "sessions.search", p: { query, maxSessions?, maxHitsPerSession? } }
→ { results: [{ file, id, name, modifiedAt, hitCount, hits: [{ role, snippet, hitIndex }] }], scanned, truncated }
```
- Kotlin 新增 `session/SessionSearch.kt`：
  - 复用 `PiSessionIndex.list(project.basePath)` 拿到本项目会话文件（已按 mtime 排序）；
  - 逐文件流式读行，`type=="message"` 时取 `message.content` 里的 text 块拼接，
    以及 `toolResult` 的 text；`indexOf(lowercase(query))`；
  - 片段：命中位置前后各 60 字符，折叠换行；`hitIndex` = 该会话内命中的第几个（供前端定位）；
  - 上限：会话 ≤ 50、每会话命中 ≤ 5、单文件 ≤ 20MB、总耗时 ≤ 2000ms（超时返回已扫部分 + `truncated:true`）；
  - 全程 `Dispatchers.IO`。
- 前端 `SessionsView`：
  - 输入 ≥2 字符 → 250ms 防抖 → `sessions.search`；`AbortController` 式的序号守卫
    （只认最后一次请求的响应）；
  - 命中会话排在列表前面并显示 `N hits` + 最多 2 条片段；点击 → `switchSession(file)` 后
    `openSearch({ query, jumpTo: hitIndex })`。
- 定位实现：切会话后 `items` 加载完，搜索框以该 query 打开并跳到第 `hitIndex` 个命中——
  不依赖「第 k 条消息」的映射，避免 pi 修复历史消息后偏移。

### D5. 会话切换重置

`switchSession()` 内 reset：`outlineOpen=false`、`search={open:false, query:"", hits:[], index:0}`、
清 `CSS.highlights`。避免把上一会话的命中画到新会话上。

## 触及文件

| 文件 | 改动 |
|---|---|
| `web/src/lib/scrollToItem.ts` | **新增**：滚动 + 闪高亮 |
| `web/src/lib/search.ts` | **新增**：`hitsFromItems`、`buildTextIndex`、`applyHighlights`（含降级） |
| `web/src/lib/search.test.ts` | **新增**：命中计算（多块、跨行、CJK、正则字符、无命中） |
| `web/src/components/SessionOutline.tsx` | **新增** |
| `web/src/components/SessionSearch.tsx` | **新增**：搜索条 + 计数 + 导航 |
| `web/src/components/ToolCard.tsx` | `open` 支持被搜索强制展开 |
| `web/src/components/MessageList.tsx` | `data-item-id`；接入 flash 高亮 |
| `web/src/components/SessionsView.tsx` | 内容搜索、命中片段、点击定位 |
| `web/src/store/store.ts` | `outline` / `search` 切片、`openSearch`、`switchSession` 重置、`searchSessions` |
| `web/src/bridge/types.ts` | `"sessions.search"` 加入 `BridgeMethod` |
| `web/src/bridge/mock.ts` | 实现 `sessions.search`（在既有 mock 会话数据里搜） |
| `src/main/kotlin/dev/pi/agent/session/SessionSearch.kt` | **新增** |
| `src/main/kotlin/dev/pi/agent/bridge/BridgeService.kt` | 注册 `sessions.search` |
| `src/test/kotlin/dev/pi/agent/session/SessionSearchTest.kt` | **新增**：`@TempDir` 造 jsonl |
| `web/e2e/session-navigation.spec.ts` | **新增** |
| `web/e2e/session-search.spec.ts` | **新增** |

## 顺序

1. `search.ts` 纯函数 + 单测（红 → 绿），`scrollToItem` + 目录（US1，最快见效）。
2. 会话内搜索 UI + 高亮（US2），含 ToolCard 强制展开。
3. Kotlin `SessionSearch` + 单测 → 桥接 → mock → Sessions 页（US3）。
4. 几何与快捷键真机验证（JCEF 下 `Ctrl+F` 是否被 IDE 抢走）。

## 风险

| 风险 | 缓解 |
|---|---|
| JCEF 拦截 `Ctrl+F`，`preventDefault` 无效 | 同时提供 🔍 按钮（FR-005 已要求）；真机若确认被抢，改用 `Ctrl+Shift+F` 并在 UI 上标明，且写进 CHANGELOG |
| CSS Custom Highlight API 在旧 JCEF（2023.3）不可用 | 降级用 `getClientRects()` 覆盖层，e2e 用「高亮层元素存在」断言两种路径 |
| 4000 条消息的会话，DOM 文本索引构建慢 | 只索引视口附近 ±50 条（按 `hitsFromItems` 的 itemId 范围），远处命中先滚动再建 Range |
| `sessions.search` 在 200 会话上超 2s | 文件并行（默认 8 线程）+ 早停；返回 `scanned/truncated` 让 UI 说实话 |
| 搜索结果与 `@` 文件补全抢同一个输入框 | 二者在不同页面（Sessions / Chat），不冲突；Sessions 输入框加 `data-testid="sessions-search"` 区分 |

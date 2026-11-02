# UI 待修问题清单

> 记录时间：2026-11-02 20:19
> 修复时间：2026-11-02 21:20（1–8 全部完成，见每条末尾的「修复结论」）
> 验证：`web/e2e/layout-regressions.spec.ts`（17 条，按几何值断言）+ 全量 e2e 51/51 + `vitest` 23/23 + `tsc --noEmit` + `gradlew compileKotlin`

## 总览

| # | 问题 | 影响面 | 涉及文件 | 状态 |
|---|------|--------|----------|------|
| 1 | 输入框打 `/` 和 `@` 不再弹出候选菜单 | 功能完全不可用（slash 命令 / 文件引用入口丢失） | `web/src/components/Composer.tsx`、`web/src/store/store.ts`、`web/src/styles.css` | ✅ 已修 |
| 2 | Options 弹出菜单布局适应性差，窄面板下被裁 | 开关点不到（审批模式改不了） | `web/src/components/OptionsPopover.tsx`、`web/src/styles.css` | ✅ 已修 |
| 3 | Sessions 列表卡片宽度溢出，右侧被切掉 | 右侧操作按钮 / 时间看不见 | `web/src/components/SessionsView.tsx`、`web/src/styles.css` | ✅ 已修 |
| 4 | Sessions 页 `+ New session` 按钮没用 | 点击无可见反馈，多余入口 | `web/src/components/SessionsView.tsx:50-53` | ✅ 已删 |
| 5 | 拉宽窗口后空态 π 图标偏右漂移 | 视觉错位；与 3 / 6 同一横向根因 | `web/src/components/MessageList.tsx`、`web/src/styles.css` | ✅ 已修 |
| 6 | 输入框与上下内容左右边界不一致 | 消息列与输入框不同轴 | `web/src/styles.css`（`.message-list` / `.composer`） | ✅ 已修 |
| 7 | AI 干活时点 `New` 直接丢当前会话 | 误点即丢失进行中的回复 | `web/src/components/Composer.tsx:414-422` | ✅ 已修 |
| 8 | 项目视图右键 Pi Agent 子菜单两项全灰 | 文件进不了 pi，入口形同废掉 | `plugin.xml:66-77`、`PiEditorActions.kt` | ✅ 已修 |

---

## 1. `/` 和 `@` 不弹选项了

**现象**：Composer 输入框（placeholder 仍写着 `/ for commands, @ for files`）里输入 `/` 或 `@`，下方不再出现候选菜单。

**代码位置**

- `Composer.tsx:136-145` — 菜单数据来源：
  - `/` 依赖 `commands`（store），过滤逻辑 `commands.filter(...).slice(0, 8)`
  - `@` 依赖 `files`（本地 state），过滤逻辑 `files.filter(...).slice(0, 20)`
- `Composer.tsx:29-41` — `filesCache` 是**模块级一次性缓存**：
  ```ts
  let filesCache: string[] | null = null;
  async function loadProjectFiles() {
    if (filesCache) return filesCache;      // 空数组 [] 也是 truthy
    try { ... filesCache = resp.files ?? []; }
    catch { filesCache = []; }              // 失败也写空数组，且永不重试
  }
  ```
- `Composer.tsx:116-118` — 只在组件挂载时拉一次文件列表。
- `store.ts:332-334` — `commands` 只在 `init()` 里通过 `get_commands` 拉一次，失败被 `.catch(() => undefined)` 静默吞掉，`commands` 永远停在 `[]`。
- `BridgeService.kt:89 / 292-321` — 后端 `files.list` 由 `ProjectFileIndex` 遍历项目内容，有 `FILES_TTL_MS` 缓存；项目未同步索引 / 空项目时返回空数组。

**疑似原因（按可能性排序，修前需先确认）**

1. `commands` 或 `files` 为空 → 菜单条件 `fileMatches.length > 0` / `slashMatches.length > 0` 直接不成立。**最可能是 `get_commands` 在 pi 进程就绪前失败，被 catch 吞掉后没有重试**；`files.list` 失败后把 `[]` 写进 `filesCache`，此后整个 UI 生命周期内永久为空。
2. `AT_QUERY_RE = /(?:^|\s)@([^\s@]*)$/` 要求 `@` 在行首或空白之后；`slashQuery` 要求**整个输入以 `/` 开头且不含空格**。先加字再打 `/`、或 `@` 前面紧跟中文/标点（无空格）时同样不弹 —— 与"完全不弹"不是一回事，需分开验证。
3. 构建产物 `web/dist` 过期，源码改动没进 JCEF（若 dev 环境正常、IDE 里不正常，优先查这条）。

**建议修法（待确认后再动手）**

- 失败不再写死空缓存：区分 `null`（未加载）与 `[]`（确实为空），失败时保留 `null` 并允许下次 mount / 聚焦时重试；`commands` 同理提供 `refreshCommands()`。
- 菜单条件只看 `query !== null`，为空时给一条 `No matching files / commands` 的空态提示，避免"点了没反应"。
- 对齐时可放宽 `@` 的正则（允许 `@` 紧跟中文），`/` 只认行首仍可保留，但要在 UI 上说明。

**验收**：冷启动（pi 进程尚未 ready）→ 等 ready → 输入 `/` 能出命令、输入 `@` 能出文件；`Escape` 关闭后改一个字又能重开；空项目里输入 `@` 显示空态文案而不是静默。

**修复结论（根因不是数据空，是菜单根本被画到窗口外面）**

1. **主因：菜单的包含块错了。** `styles.css` 的设计刷新段把 `.file-menu` / `.slash-menu` 改成了 `position: absolute; bottom: calc(100% + 6px)`，而它们的父级 `.composer-inner` 没有 `position` —— 由于 `.app` 有 `container-type: inline-size`（含 layout containment），它成了包含块，于是 `bottom: 100%` 是「整个 app 高度」，两个菜单被放到工具窗口**上边界之外**：DOM 在、`toBeVisible()` 也过、肉眼永远看不到。给 `.composer-inner` 补 `position: relative` 修复。
2. **数据源确实也会空，一并修死**：`filesCache` 失败后写 `[]` 且 `if (filesCache)` 对 `[]` 为真 → 整个 UI 生命周期内永不重试。现在成功才写缓存、失败记时间戳并允许重试（`loadProjectFiles(force)`，带 2s 退避与 in-flight 去重）；打开 `@` 菜单时若列表为空会主动重拉一次。
3. **`commands` 同理**：新增 `store.refreshCommands()`，`init()` 改调它；`pi-state` 变 `running` 时补拉 `commands` / `models` / `thinkingLevels`（init 早于 pi 就绪时这些请求会全失败被吞掉）；打开 `/` 菜单时若 `commands` 为空再补拉一次。空结果不再覆盖已有列表。
4. **菜单条件改为「有 query 就开」**，无匹配显示 `No matching files` / `No matching commands`；`Escape` 在空菜单里也能关。
5. **`@` 正则放宽**：`/(?:^|\s)@/` → `/(?:^|[^\w@])@/`，中文/标点紧跟 `@` 也能触发（`user@example.com` 仍按邮箱不触发）。

**验证**：`layout-regressions.spec.ts` 断言 `@` / `/` 菜单的 `bottom ≤ 输入框 top`、`top ≥ app top`（原来会挂在 app 之外）；无匹配时 `file-menu-empty` 可见；`看@sto` 能出 `src/store/store.ts`。

---

## 2. Options 菜单布局适应性差（图 2 / 图 3）

**现象**

- 窄面板（约 430px，图 2）：Theme 行只剩 `Light | Dark` 两个分段，`Follow IDE` 被裁；`Auto-*` 三行的开关被右侧切掉；菜单上半部分被上方容器裁掉。
- 稍宽面板（图 3）：Theme 三个分段完整，但 `Auto-compact context` / `Auto-retry` / `Auto-approve` 的开关**仍显示在菜单右边界之外**被切。

**代码位置**

- `OptionsPopover.tsx:91-137` — 菜单结构：Theme 分段 + 3 个 `OptionRow`；`.options-menu` 为绝对定位、`bottom: calc(100% + 6px)`，不带任何边界计算。
- `styles.css:1439-1450` — 第一套 `.options-menu`：`left: 0; min-width: 280px`。
- `styles.css:2485-2496` — **第二套**（后加载覆盖前一套）：`right: 0; width: 280px`（固定宽度取代了 min-width）。
- `styles.css:2800-2803` — `@container (max-width: 480px)` 内再补一条 `left: auto; right: 0`（即 commit `5dfdee4` 的"窄窗左开"修复）；这条只在容器 ≤480px 生效，仍不能解决固定 280px 宽 + 内容更宽的问题。
- `styles.css:1452-1467` — `.options-row` 用 `space-between` + `gap: 16px`，`.options-label` 没有 `min-width: 0` / 允许换行。

**根因判断**

1. 菜单宽度被硬编码 280px，而内容（"Auto-approve tool calls" + 开关 + gap）自然宽度超过 280 → 行溢出菜单边界，开关被画到框外。
2. 定位只做"左开/右开"二选一，没有按可用空间做横向翻转判断；窄面板下无论左右开都会压到 tool window 边界，再加上父级 `overflow: hidden`，超出的部分直接被裁。
3. 同一份样式在 `styles.css` 里有两套（1439 / 2485），谁生效取决于顺序，容易改了一处不生效。

**建议修法（记录，不实施）**

- 弃用固定 280px：改 `min-width: 260px; max-width: min(320px, calc(100cqw - 24px))`（`.app` 已设 `container-type: inline-size`，可用 `cqw`）。
- 打开时用 `getBoundingClientRect()` 算可用空间，决定 `left` 还是 `right` 对齐，必要时限制 `max-height` + 内部 `overflow-y: auto`。
- `.options-row` 的 label 加 `min-width: 0` + 允许两行；`.switch` 保持 `flex-shrink: 0`。
- 主题分段 `.segmented` 在窄宽下改为可横向滚动或缩短标签（`IDE` / `Light` / `Dark`）。
- 合并 1439 与 2485 两套 `.options-menu`，删除失效的一份。

**验收**：面板宽度分别在 360 / 430 / 520 / 900px 下打开 Options —— 三个开关完整可见可点、Theme 三个分段都在、菜单不出 tool window 边界。

**修复结论**

- **删掉重复定义**：顶部那套 `.options-menu`（`left: 0; min-width: 280px`）整块删除，只留设计刷新段一套。之前两套叠加成 `left: 0` + `right: 0` + `width: 280px`，LTR 下 `right` 被忽略 → 菜单从按钮左边缘往右铺 280px，右端被窗口裁掉，正是「开关跑到框外」。`.options-row` / `.options-label` / `.switch` 的重复定义一并清掉。
- **改成实测定位**（`OptionsPopover.tsx` 的 `useLayoutEffect`）：读 `.app` 的 rect，宽度取 `min(内容宽, 窗口宽 - 16)`，水平先按「右边缘对齐触发器」算，再 clamp 进窗口；`resize` 与触发器尺寸变化时重算。
- **垂直方向一起修**：直接挂在行内按钮上会让菜单压在输入框上，所以 `bottom` 按 `.composer-inner` 的顶边反算，菜单整体浮在输入框之上；上方余量不足时写 `max-height` 并内部滚动（`overflow-y: auto` + `overscroll-behavior: contain`）。
- `.options-label` 加 `min-width: 0` + `overflow-wrap: anywhere`，`.switch` 保持 `flex-shrink: 0`；`.segment` 加 `min-width: 0` + 省略号，极窄时才截断。CSS 里保留 `width: min(300px, calc(100cqw - 16px))` 作为 JS 运行前的兜底。

**验证**：`layout-regressions.spec.ts` 在 360 / 430 / 520 / 900 四档断言菜单 rect 在 `.app` 内、3 个 `role="switch"` 与 3 个主题分段的左右边界都在菜单内。

---

## 3. Sessions 卡片右边被丢掉（图 4）

**现象**：Sessions 列表中会话卡片（高亮那条以及其他几条）右边缘超出面板内容区，右侧被裁；卡片右侧的复制 / 导出 / 删除按钮和右上角时间完全看不见。

**代码位置**

- `SessionsView.tsx:61-108` — `.session-row > .session-row-main + .session-actions`
- `styles.css:2311-2400`（后加载的一套）：
  - `.sessions-list { display: grid; grid-template-columns: 1fr; overflow-x: hidden; padding: 0 20px 16px; scrollbar-gutter: stable; }`
  - `.session-row { display: flex; gap: 6px; padding: 10px 12px; }`（未设 `min-width: 0` / `width: 100%`）
  - `.session-preview` 用 `-webkit-line-clamp: 2`，未设 `min-width: 0`
- `styles.css:692-790` — 旧的同一批类名定义（`.sessions-view` / `.sessions-toolbar` / `.sessions-list` / `.session-row` 全部重复了一遍）。

**疑似原因（需复现确认）**

1. `grid-template-columns: 1fr` 的隐含最小尺寸是 `minmax(auto, 1fr)`：item 的 min-content 一旦变大，列宽会被撑开并横向溢出（`overflow-x: hidden` 只是把溢出藏起来，所以看到的是"右边被切"而不是滚动条）。
2. `.session-row` 自身没有 `min-width: 0` / `max-width: 100%`，flex 子项（`.session-row-main` 有 `min-width: 0`，但 row 本身没有约束）在窄容器里收缩不彻底。
3. 老/新两套样式并存，`.sessions-list` 的 `padding`、`display` 在新旧之间来回覆盖，实际生效的组合可能不是设计时预期的那套。

**建议修法（记录，不实施）**

- `.sessions-list` 改 `grid-template-columns: minmax(0, 1fr)`，`.session-row` 补 `min-width: 0; width: 100%;`。
- `.session-preview` / `.session-name` 补 `min-width: 0`；`.session-actions` 用 `flex-shrink: 0`。
- 清掉 692 行起那套旧样式，只留一套（与问题 2 的清理一起做）。
- 顺带修 `SessionsView.tsx:43-49`：`<input className="select sessions-filter">` 复用了新样式里给**容器**写的 `.sessions-filter`（`display: flex; height: 28px; padding: 0 8px`，并且配的是 `.sessions-filter input` 子选择器），input 自己吃到容器样式，是当前 filter 框样式不对的根因。

**验收**：面板宽度 360 / 430 / 900px 下，卡片左右都在容器内，右侧三个操作按钮和时间可见；长会话名 + 长 uuid 预览不会把卡片撑开。

**修复结论**

- `.sessions-list` → `grid-template-columns: minmax(0, 1fr)`；`.session-row` 补 `min-width: 0; width: 100%; overflow: hidden`，`.session-preview` 补 `min-width: 0` + `overflow-wrap: anywhere`，`.session-actions` 补 `flex-shrink: 0`。
- 清掉第 692 行起那套旧 `.sessions-*` / `.session-*` 样式（与问题 2 的重复定义一起清），只留一套。
- filter 框根因确认并修好：原来 `<input className="select sessions-filter">` 吃的是给**容器**写的 `.sessions-filter`（`display:flex; height:28px; color: text-tertiary`），改成专用 `.sessions-filter-input`（`border/background/font-size` + `:focus` 高亮），旧的容器规则与 `.sessions-filter input` 子选择器删除。

**验证**：`layout-regressions.spec.ts` 在 360 / 430 / 900 三档先把会话名/预览替换成 120 / 160 字符的无空格长串，再断言每条 `.session-row` 的左右边界在 `.sessions-list` 内、`.session-actions` 宽度 > 0 且右边界不越过卡片。

---

## 4. `+ New session` 按钮没用，去掉（图 5）

**现象**：Sessions 页工具栏右侧的 `+ New session` 按钮，点了之后界面没有任何可见变化。

**原因**：`SessionsView.tsx:50-53` 调的是 `store.newSession()`（`store.ts:421-436`），它只做 `new_session` RPC + 重置 items + 刷新 sessions 列表，**不会把 tab 切回 Chat**。用户停在 Sessions 页，看不到新建的空会话，于是判断"按钮没用"。

**处理决定**：按用户要求**直接删掉**这个按钮（`SessionsView.tsx:50-53`），新建会话入口保留 Composer 底部的 `New`（`Composer.tsx:414-422`，在 Chat 页可见）。

**验收**：Sessions 页只剩 filter 输入框；Chat 页 `New` 按钮仍能新建会话并清空消息区。

**修复结论**：按决定删除按钮与 `newSession` 选择器（`SessionsView.tsx`），工具栏只剩 filter。新建入口保留 Composer 的 `New`（已按 7 加确认）。**验证**：`layout-regressions.spec.ts` 断言 `.sessions-toolbar button` 数量为 0。

---

## 5. 拉宽窗口后空态图标漂移（图 6，2026-11-02 20:48 追加）

**现象**：Chat 页无消息时的空态（π 图标 + "Pi Agent" + 模型名），把 tool window 拉宽后图标/文案不再水平居中，整体向右偏（截图 680px 视口下图标中心约在 415px，应居中于 340px，偏右约 75px）；同一张截图里还出现了**两份 app 结构**——上面一份全宽（图标偏右），下面又有一个 405×228 的完整面板（标题 + Chat/Sessions/Manage + 小号空态）。

**已做实测（浏览器侧，未改代码）**：`web/probe-empty-state.mjs` 在 Chromium 下跑了 360 / 520 / 680 / 760 / 900 / 1100 / 1440 七档：

| 视口 | `.empty-logo` 中心 | 视口中心 | doc overflow | `.empty-state` 个数 |
|---|---|---|---|---|
| 360 | 180 | 180 | 0 | 1 |
| 680 | 340 | 340 | 0 | 1 |
| 900 | 450 | 450 | 0 | 1 |
| 1440 | 720 | 720 | 0 | 1 |

结论：**CSS 居中链路是对的**（`.message-list` → `.message-col { max-width: 780px; margin: 0 auto }` → `.empty-state { margin: auto }`），纯浏览器里逐像素居中、无横向溢出、只有一个空态实例。所以漂移只能来自 JCEF 运行时，不是这条链路写错。

**可疑方向（按可能性）**

1. **JCEF 里文档出现横向溢出**：某个元素把 `documentElement.scrollWidth` 撑到约 830px（`margin:auto` 就会相对这个更宽的包含块居中 → 视觉上偏右，同时右侧被裁）。这与**问题 3（Sessions 卡片右边被切）是同一族症状**，很可能是同一个元凶，建议两条一起定位。
2. **`scrollbar-gutter: stable both-edges`**（`styles.css:1614`，`.message-list`）：浏览器里两侧各留 10px（实测 `clientWidth 340 / width 360`）。JCEF 真实滚动条叠加时若表现不同，会让内容区与视口不同轴。
3. **截图里的两份 app**：正常只有一个 `.app`；同时出现两份像是 resize 后旧帧残留（JCEF OSR 重绘）或开了两个 Pi Agent 视图（停靠 + 浮动）。这条需要复现确认，不排除是真 bug。

**下一步验证（只读，在 IDE 的 JCEF 里 Ctrl+Shift+I 打开 Console 跑一行）**

```js
const d = document.documentElement;
console.log(
  d.clientWidth, d.scrollWidth,
  document.querySelectorAll('.app').length,
  [...document.querySelectorAll('*')]
    .filter((e) => e.getBoundingClientRect().right > d.clientWidth + 1)
    .map((e) => `${e.tagName}.${e.className}`),
);
```

- `scrollWidth > clientWidth` 或第二个数组非空 → 方向 1 成立，按列出的元素名（多半是固定宽度 / 不收缩的组件）补 `min-width: 0` / `max-width: 100%`。
- `.app` 数量 > 1 → 方向 3，查是不是有两个视图实例或旧帧残留。

**不要这样做**：给 `html, body` 加 `overflow-x: hidden` 掩盖 —— 只把溢出藏起来，居中仍按更宽的包含块算，图标照样偏，还会让问题 3 更难查。

**验收**：JCEF 里把 tool window 从 360 拉到 1400px，空态图标始终停在消息列中心，且与输入框中线对齐；`documentElement.scrollWidth === clientWidth`；`.app` 只有一个。

**修复结论**

浏览器侧复现不到漂移，所以按「把可变环境假设全部去掉 + 堵住一切横向溢出源」处理，三条一起做：

1. `.empty-state` 补 `width: 100%; max-width: 100%`：图标与文案的居中改为相对消息列整宽，不再依赖「一段文本 shrink-to-fit 盒子」的宽度。
2. `.app` 补 `min-width: 0; max-width: 100%; overflow-x: clip`：任何一个宽子元素都不可能再把文档撑宽到 830px 那种程度（撑宽会同时让 `margin:auto` 的包含块变宽 → 图标偏右 + 右侧被裁），clip 之后轴心包含块恒等于窗口宽度。
3. 与 6 一起把 `.message-list` 的横向内缩从「6px + 10px gutter 假设」改成写死的 16px，并把 `scrollbar-gutter: stable both-edges` 去掉 —— 这正是「居中链路依赖一个环境假设」的根源。

**验证**：`layout-regressions.spec.ts` 在 360 / 680 / 900 / 1440 四档断言 `doc.scrollWidth === doc.clientWidth`、`.app` 实例数为 1、`.empty-logo` 中心 == 视口中心（误差 < 0.5px）。

---

## 6. 输入框和上下内容的左右边界不一致（图 7，2026-11-02 20:56 追加）

**现象**：输入框（`composer-box`）的左右边界，与上方消息区/空态、下方状态栏的边界不在同一条垂直线上。用两根红箭头标出的"上边界 / 下边界"就是这条错位。

**代码位置**

- `styles.css:1897-1906` — `.composer { padding: 0 16px 12px }` + `.composer-inner { max-width: 780px; margin: 0 auto }`
- `styles.css:1604-1615` — `.message-list { padding: 20px 6px 8px; scrollbar-gutter: stable both-edges }`，注释里写着"6px + 每侧 10px gutter == composer 的 16px 内缩"
- `styles.css:2785` — `@container (max-width: 480px)` 里 `.message-list { padding: 12px 0 8px }`，而同一个查询里 `.composer { padding: 0 8px 6px }`

**根因**

1. 这条"同轴"是**靠一个环境假设成立的**：假设滚动条 gutter 恰好 10px。真实环境里 CEF 的经典滚动条是 17px（Windows），或者 `both-edges` 没被完整支持、只在一侧留位 —— 此时消息列的实际内缩是 `6+17` 或 `6+0`，与 composer 的 16px 差 1~17px，上下边界就对不齐。**问题 5 的图标偏右大概率也是这条**：gutter 一旦被算进 padding box，居中列的轴心就整体偏移。
2. 窄屏分支更明显：`.message-list` 左右内缩被写成 `0`，composer 是 `8px`，两者必然差 8px。
3. 两处宽度上限各自硬编码 780px，没有任何共同的"gutter 变量"，改一处不会带动另一处。

**建议修法**

- 把水平内缩统一成一个值：`message-list` 直接写 `padding: 20px 16px 8px`、窄屏写 `12px 8px 8px`，与 `.composer` 的 16px / 8px 对齐；`.message-col` 保持 `max-width: 780px`。
- 去掉对 `scrollbar-gutter: stable both-edges` 的依赖（它才是"看起来对称"的唯一变量）。滚动时出现的瞬时滚动条会带来半条滚动条的偏差，比长期错位划算。
- 给 `.composer`、`.composer-inner`、`.message-list`、`.app` 补 `min-width: 0` / `max-width: 100%`，防止任何一处被内容撑宽后破坏轴心（与问题 3、5 同一道保险）。

**验收**：360 / 680 / 900 / 1440 四档下，`.composer-inner` 与 `.message-col` 的 `left`、`width`、中心点三值必须完全相等（`web/probe-empty-state.mjs` 已能直接量这两个值）。

**修复结论**

- `.message-list` 横向内缩统一到 16px（窄屏分支 0 → 8px，与 `.composer` 的 8px 对齐），删除 `scrollbar-gutter: stable both-edges`。上下同轴不再依赖「gutter 恰好 10px」这个假设：CEF 经典滚动条 17px、或 `both-edges` 未生效时，原来的 6+10 会变成 6+17 / 6+0，必然错位 1~17px。
- `.composer` / `.composer-inner` / `.message-list` / `.message-col` 全部补 `min-width: 0` + `max-width: 100%` 保险。
- 代价：出现滚动条时消息列会整体内缩半个滚动条（5px），这是文档里认可的那笔交易（瞬时 5px vs 长期错位）。

**验证**：430px 实测 `.message-col = [8, 422] / width 414`、`.composer-inner = [8, 422] / width 414`，完全相同；`layout-regressions.spec.ts` 在 360 / 680 / 900 / 1440 四档断言 `left`、`width`、空态中心点三值与输入框一致。

---

## 7. AI 正在干活时，新增会话应该弹窗确认（图 8，2026-11-02 20:57 追加）

**现象**：Pi 正在流式回复（有内容在跑）时，点输入框右下角的 `+`（New），会**直接新建会话**，进行中的回复被静默丢弃，没有任何确认。

**代码位置**

- `Composer.tsx:414-422` — `data-testid="new-session"`，`onClick={() => void newSession()}`，无任何 streaming 保护。
- `store.ts:421-436` — `newSession()` 发 `new_session` RPC 后立刻 `set({ items: [], ... })`，前端消息区被清空。
- 对比：同一行的 `Fork` 有 `disabled={isStreaming}`，`Compact` 也有，**只有 New 没有**。

**建议修法**：在 `onClick` 里先判 `isStreaming`，弹 `window.confirm("Pi is still working. Start a new session and discard the current run?")`，取消则 return；确认才调 `newSession()`。同时把 `title` 在 streaming 时改成 "New session (current run will be discarded)"。（`window.confirm` 在 JCEF 里可用，Sessions 的删除确认已经在用它。）

**验收**：streaming 中点 `+` → 出确认框；点取消 → 当前回复继续、消息区不清空；点确定 → 新建并清空。

**修复结论**：`Composer.tsx` 的 `new-session` 改为先判 `isStreaming`，弹 `window.confirm("Pi is still working. Start a new session and discard the current run?")`，取消即 `return`；`title` 在 streaming 时改成 `New session (the current run will be discarded)`。**验证**：`layout-regressions.spec.ts` 在 busy 态断言 title 含 `discarded`、点击后弹出含 "still working" 的对话框、取消后 `item-user` 仍在且 `empty-state` 不存在。

---

## 8. 项目视图右键 Pi Agent 子菜单两项全灰（图 9，2026-11-02 21:00 追加）

**现象**：在项目视图选中 `demo.txt` 右键 → `Pi Agent` 子菜单里，`Send File to Pi Agent` 和 `Explain File with Pi` 都是灰色不可点。

**代码位置**

- `plugin.xml:66-77` — `PiAgent.FilePopup` 挂在 `ProjectViewPopupMenu` + `EditorTabPopupMenu`，两个 action：`PiAgent.SendFile` → `SendFileToPi`、`PiAgent.ExplainFile` → `ExplainFileWithPi`。
- `PiEditorActions.kt:119-126` — `SendFileToPi.update()`：`project != null && vf != null && !vf.isDirectory && !vf.fileType.isBinary && vf.length <= 256KB`，其中 `vf = e.getData(CommonDataKeys.VIRTUAL_FILE)`。
- `PiEditorActions.kt:89-94` — `ExplainFileWithPi.update()`：`project != null && e.getData(CommonDataKeys.EDITOR) != null`。

**根因**

1. **`ExplainFileWithPi` 必灰**：它的 enabled 条件只认 `CommonDataKeys.EDITOR`。从项目视图右键时 DataContext 里没有 editor（那是 editor popup / editor tab 才有的），所以这项在项目树里永远是灰的 —— 而它恰恰是"整个文件"语义，最该在项目树里可用。这是逻辑错误，不是环境问题。
2. **`SendFileToPi` 灰的原因**：只认单个 `CommonDataKeys.VIRTUAL_FILE`。Project View 的 DataContext 在部分版本/节点（新 UI、多选、包视图）只提供 `VIRTUAL_FILE_ARRAY`，单值 key 取不到 → `vf == null` → 直接 disabled。
3. 两者都没有降级路径：任何一环取值失败就整项灰掉，用户看不到任何原因说明。

**建议修法**

- 抽一个共用取文件的方法：`e.getData(VIRTUAL_FILE) ?: e.getData(VIRTUAL_FILE_ARRAY)?.firstOrNull()`，两个 action 都用它。
- `ExplainFileWithPi` 改为：有 editor 用 caret 取行号，没有 editor 就用 `vf` 读内容、行号按 1；`update()` 改成"有 editor 或 有 vf"即启用。
- 目录 / 二进制 / 超 256KB 的禁用保留（这三种情况本来就该灰），但建议在 description 或 tooltip 里写清禁用原因。

**验收**：项目视图选中文本文件右键 → 两项都可点且能把文件送到 composer；选中目录 / 二进制 / >256KB 文件 → 两项灰；编辑器标签页右键 → 两项仍正常。

**修复结论**（`PiEditorActions.kt`）

- 新增共用 `selectedVirtualFile(e)`：`getData(VIRTUAL_FILE) ?: getData(VIRTUAL_FILE_ARRAY)?.firstOrNull()`，两个 action（以及 `PiSelectionAction`）都用它；项目树只给数组时不再 `vf == null`。
- `ExplainFileWithPi` 改为「有 editor 用 caret 行号，没有 editor 就用 vf 读整文件、prompt 里不带行号」；`update()` 改成「有 editor 或 有可读的 vf」即启用 —— 它本来就是「整个文件」语义，项目树里最该可用。
- 禁用原因写进 `presentation.description`（`Folders cannot be sent to pi` / `Binary files cannot be sent to pi` / `File is larger than 256 KB`），不再无声变灰。
- 项目相对路径抽成 `projectRelativePath(project, vf)`，`PiSelectionAction` 的私有副本删除。

**验证**：`./gradlew compileKotlin` 通过。IDE 内的手工验收（右键 demo.txt 两项可点）需装插件后确认 —— 这一条没有自动化测试覆盖。

---

## 附：梳理时发现的关联隐患（未在 4 条之内，供决定是否一起处理）

1. **`styles.css` 存在成对重复定义**：`.sessions-view` / `.sessions-toolbar` / `.sessions-list` / `.session-row` / `.options-menu` / `.session-row-main` 等各出现两次（约 692-790 与 2311+、1439 与 2485），后一套覆盖前一套。问题 2、3 都与它有关，建议修的时候一并合并。 **→ 已合并**：删掉旧的一整套（`sessions-*` / `session-*` / `options-*` / `switch` / `empty-*` / `file-menu` / `slash-menu` 底座），每类只剩一处定义，注释里标明「只此一处」。
2. **`store.init()` 里多个 `get_*` 请求失败被静默吞掉**（`store.ts:312-336`），失败后没有任何重试或可见提示，问题 1 就是这种静默失败的典型表现。 **→ 部分修**：新增 `refreshCommands()`，并在 `pi-state=running` 时补拉 `commands` / `models` / `thinkingLevels`；打开菜单时再兜一次。仍然是 `console.warn`，没有做成可见提示。
3. **`filesCache` 无失效机制**：新建/删除项目文件后 `@` 列表不会更新，要重开 tool window 才刷新。 **→ 部分修**：失败不再写死空缓存、可重试；`files.list` 命中后端 `FILES_TTL_MS` 缓存，所以「项目里新增文件后」仍需等 TTL 或重开窗口。
4. **`web/probe-empty-state.mjs`**：为定位问题 5 写的只读测量脚本（Chromium 下量 `.empty-logo` 中心、doc 溢出、空态实例数），未跟踪、可保留复用或随时删除。 **→ 保留**；本次同款探针 `web/probe-ui-fixes.mjs` 也保留（量轴心与各弹层的 rect）。
5. **新发现（本次修复时确认）**：`e2e` 里 `toBeVisible()` 只要求「有非空包围盒」，所以「元素被画到工具窗口外面」这类 bug 全绿通过 —— 这才是这 8 条能一起活到发版的原因。新增 `web/e2e/layout-regressions.spec.ts` 按截图/几何值断言（rect 在 `.app` 内、轴心相等、无横向溢出），专门堵这个口子。

## 修复顺序（实际执行）

8 → 7 → 4（独立小改动）→ 1（前端逻辑 + 一个包含块修复）→ 6 + 5（同一条轴心根因）→ 3（同源收尾）→ 2（最后统一整理 `styles.css` 的重复定义）。与建议顺序一致，只是 1 提前到布局合并之前做 —— 因为它的主因也是 CSS 包含块，先修好能少一轮截图确认。

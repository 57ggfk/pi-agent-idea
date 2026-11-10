# Implementation Plan: 022 滚轮卡顿与长列表交互成本

**Branch**: `release/0.5.7` | **Date**: 2026-11-10 | **Spec**: [spec.md](./spec.md)
**Tasks**: [tasks.md](./tasks.md)（T401–T414）

## 摘要

两处症状、两条不同的病根：

- **下拉列表（已证）**：`onMouseEnter` → `setHighlight` → 整表重渲染 + `ensureVisible` 的两次 `getBoundingClientRect`。滚轮一动，指针下的行就换一次，于是每滚一格就重渲染 359 个节点并强制布局一次，主线程占满，滚轮排队 → 「停一下才动」。修法是把**悬停视觉交给 CSS**，键盘项才进 state。
- **消息列表（一半已证、一半待量化）**：`stickToBottom` 用「距底 < 60px」这种**距离**判定用户是否想贴底，而单次滚轮位移与 60px 同量级 —— 向上滚一格仍被判为贴底，被下一次更新拽回去。改成**方向判定**即可；余下的 OSR 光栅化成本靠 memo + 视口外不绘制压下去，并用埋点量化。

## 技术上下文

- **语言/栈**：TypeScript + React 18（web），无新增依赖。
- **样式**：只加 `.model-option:hover` 一类的纯 CSS 规则，复用既有 `--surface-hover` / `--user-bubble` 变量。
- **测试**：`vitest`（吸底状态机、抽屉件的纯函数）+ `playwright`（滚轮位移、`data-active` 语义、Enter 选中）。
- **平台**：JCEF（Chromium OSR）—— 主线程每帧预算比桌面 Chrome 窄，滚动是主线程滚动，因此「减少每帧工作量」比「加快单次操作」更有效。
- **约束**：不改消息 DOM 契约（`data-item-id` / `flash-target` / `[data-model-key]` 是 006/011/020 的定位锚点）。

## Constitution Check

| 条款 | 本次是否涉及 | 结论 |
|---|---|---|
| I 双端契约同步 | 纯前端，桥接零改动 | 通过 |
| II 断言含几何与行为 | 位移必须断言「有符号变化量」，不能只断言元素存在 | 通过（见验证命令） |
| III 布局不依赖运行时假设 | `content-visibility` 的占位高度用 `contain-intrinsic-size: auto …`，不做「按平均高度 × 条数」推算 | 通过（并有 Q3 的退路） |
| IV 对 pi 写操作可回滚 | 不涉及 | 不涉及 |
| V 桥接双向声明 | 不新增 | 不涉及 |
| VI 凭据零托管 | 不涉及 | 不涉及 |

无违反项。

## 现状与代码定位

| 位置 | 现状 | 问题 |
|---|---|---|
| `components/ModelPicker.tsx:270` | `onMouseEnter={() => setHighlight(vi)}` | 悬停写 state，触发整表重渲染 |
| `components/ModelPicker.tsx:143-148` | `useEffect([highlight, open])` → `ensureVisible` | 每次 hover 都 `querySelectorAll` 全表 + 两次 `getBoundingClientRect`（强制布局） |
| `components/ModelPicker.tsx:255-257` | 每个分组对 `visibleFlat` 做一次 `filter` | O(组数 × 条目数) 的重建，359 条目录下每次 hover 都跑一遍 |
| `components/ModelPicker.tsx:186-190` | `visibleIndexOf` 建 Map（已 memo） | 本身没问题，但被上游高频重渲染反复消费 |
| `components/manage/ProviderPicker.tsx:180,214` | 同款 `onMouseEnter` → `setHighlight` | 同款缺陷（第二处） |
| `components/manage/ProviderPicker.tsx:81-86` | 同款 `ensureVisible` effect | 同上 |
| `lib/modelGroups.ts:179-190` `ensureVisible` | 逐次读 `getBoundingClientRect` | 正确性没问题，但调用频率不该由 hover 驱动 |
| `styles.css:1251-1262` | `.model-option` **无** `:hover`，高亮只靠 `.model-option-active` | 想「CSS 管视觉」必须先补 hover 规则 |
| `components/MessageList.tsx:169-174` | 贴底时 `el.scrollTop = el.scrollHeight`（依赖 `[items, retryInfo]`） | 贴底判定错误时会把用户拽回底部 |
| `components/MessageList.tsx:176-180` | `stickToBottom = 距底 < 60` | **距离**判定；单次滚轮位移同量级 → 向上滚一格仍算贴底 |
| `components/MessageList.tsx:186-198` | `ItemView` 未 memo；`actions` 每次新建 | 任意 store 变化（stats/queue/语言）都重渲染整屏消息 |
| `components/Markdown.tsx:132-166` | `useMemo` 解析 html；`useEffect([html])` 里跑 `hljs` + `TreeWalker` | 解析已缓存；但节点多时首次/更新成本在，视口外仍在 DOM 里参与绘制 |

## 设计决策

### D1 悬停视觉与「键盘当前项」彻底分离

- 删除 `onMouseEnter` 里的 `setHighlight`。
- 新增 `hoverIndexRef = useRef<number | null>(null)`：`onMouseEnter` 只写 ref（零渲染）；`onMouseLeave`（容器级）清空。
- 视觉高亮改由 CSS `:hover` 承担（`.model-option:hover`，用与 `.model-option-active` 相同的 `--user-bubble`）。
- `data-active` 的语义收窄为「键盘当前项」，**只有** `↑/↓`、搜索重置、打开定位能改它。
- `Enter` 与点击取 `hoverIndexRef.current ?? highlight` —— 这样「悬停后按 Enter 选中鼠标所指」的直觉仍然成立（US1 第 3 条），但不为它付一次渲染。

### D2 行组件 memo，props 必须稳定

`ModelOption` 抽成独立组件并 `React.memo`，props 只有 `model/provider/current/dataActive/index` 这类原始值 + 一个 `useCallback` 的 `onPick`。悬停不再改 state 后，一次滚轮不再产生任何渲染。

分组渲染去掉「每组 filter 一遍全表」：一次遍历把条目按 `groupIndex` 桶装（O(n)），再按组输出。**注意与 020 的冲突**：020 T202/T204 会改 `flattenGroups` / `buildPickerData`，本项必须在 020 之后叠加，按 020 的 `PickerModelData` 形状写。

### D3 `ensureVisible` 只服务键盘导航

调用点从 `useEffect([highlight])` 收窄为「由键盘/打开定位触发的 highlight 变化」。实现上用 `scrollOnChangeRef`：`↑/↓` 处理里置 `true`，effect 读完即置 `false`；悬停从不置位。这样滚动位置**只**由用户滚轮和键盘导航决定，不会被 hover 干扰。

### D4 吸底改为「方向优先」状态机

`MessageList` 内把 `stickToBottom` 布尔换成显式状态：

```ts
type Pin = { pinned: boolean; lastTop: number };
// onScroll:
//   1) 若 scrollTop < lastTop（向上滚了）→ pinned = false，无论距离多近
//   2) 否则若距底 <= 4px → pinned = true
//   3) 记录 lastTop
```

- 只有 `pinned` 为真时，`items` 更新才写 `scrollTop = scrollHeight`。
- 阈值从 60px 收到 4px：60px 是「判定用户意图」的错误量级（一次滚轮就能跨过），4px 只用来吸收亚像素与取整误差。
- 方向判定优先于距离判定，从根上消除「滚一格仍算贴底 → 下一帧被拽回」。

### D5 消息级 memo（自定义比较器）

`ItemView` 用 `React.memo` + 自定义比较：

```ts
(a, b) => a.item === b.item
      && a.activeHitBlockIndex === b.activeHitBlockIndex
      && sameActionIds(a.actions, b.actions)   // 长度 + kind 序列（O(k)，k<=6）
```

`actions` 每次渲染都是新数组，默认浅比较必然失效，所以必须比内容不比引用。`sameActionIds` 写成纯函数放 `lib/`，可单测。

### D6 视口外不参与绘制

`.item` 加：

```css
content-visibility: auto;
contain-intrinsic-size: auto 120px;
```

- `auto` 让浏览器记住实测高度，滚动条不会来回跳。
- 风险：`scrollHeight` 在首次进入时是估算值 → 「跳转到第 N 条」可能差一点（`scrollToItem` 本身用 `getBoundingClientRect`，跳完会二次校正），「吸底」只依赖 `scrollTop/scrollHeight` 的相对关系，`pinned` 状态机里有 4px 容差。
- **退路**：真机若发现定位偏移或滚动条抖动，只保留 D5、撤掉 D6（单条 CSS 回滚，不影响其它决策）。

### D7 度量

复用 021 T314 定义的 `web/src/lib/perf.ts`（同在 0.5.7；若 021 尚未落地则本 spec 先建最小版，021 再接管）。

- `scroll.frame`：`wheel` 事件 → 下一帧 `scrollTop` 实际差值，超 50ms 记为「掉帧」。
- `hover.render`：开发期计数器（`React.Profiler` 或渲染侧自增），真机取「滚 10 格内的渲染次数」，目标 0。
- 取值：`grep "\[pi-agent\] perf" idea.log`（`PiAgentPanel` 的 console handler 已把该前缀写日志）。

### D8 与 021 的边界

021 管「点了之后进入会话的延迟」，本 spec 管「已经进来了、滚不动」。两者共用 `perf.ts` 与「减少主线程工作」的思路，但**改的文件不重叠**（021：store/切换链路；022：两个 picker + MessageList + CSS）。实施顺序：020 → 021 → 022，避免在同一批文件上交叉改。

## 改造前后（下拉列表滚轮一次）

```
改造前：
wheel ─→ 行变化 ─→ mouseenter ─→ setHighlight ─→ React 重渲染 359 条（含每组 filter）
                                      └─→ effect: querySelectorAll + 2× getBoundingClientRect
      → 主线程被占 ─→ 滚轮排队 ─→ 视觉上「不动」，直到指针停下

改造后：
wheel ─→ 行变化 ─→ mouseenter ─→ 写 ref（零渲染） ─→ CSS :hover 换背景
      → 主线程空闲 ─→ 每次滚轮即时生效
```

## 接口契约

```ts
// web/src/lib/messageActions.ts（新，纯函数，可单测）
export function sameActionIds(a: MessageAction[], b: MessageAction[]): boolean;

// web/src/lib/pin.ts（新，纯函数，可单测）
export interface PinState { pinned: boolean; lastTop: number }
export function nextPin(state: PinState, scrollTop: number, scrollHeight: number, clientHeight: number): PinState;
// 规则：scrollTop < lastTop → unpinned；否则 距底 <= BOTTOM_EPS(4) → pinned；两者都不满足 → 保持上次
```

`[data-active]` 语义变更（唯一一处对外可见的契约变化）：由「悬停或键盘的当前项」收窄为「键盘当前项」。020 的 e2e 若断言 `data-active` 跟随 hover，需要同步修订（见 T413）。

## 触及文件

| 文件 | 改动 |
|---|---|
| `web/src/components/ModelPicker.tsx` | 去 `onMouseEnter` setState；`hoverIndexRef`；`ModelOption` memo；分组渲染改桶装；`ensureVisible` 只在键盘导航时跑 |
| `web/src/components/manage/ProviderPicker.tsx` | 同款改造 |
| `web/src/styles.css` | `.model-option:hover`；`.item` 的 `content-visibility` + `contain-intrinsic-size` |
| `web/src/components/MessageList.tsx` | 吸底改 `nextPin` 状态机；`ItemView` memo + `sameActionIds` |
| `web/src/lib/pin.ts`（新） | 吸底状态机纯函数 |
| `web/src/lib/messageActions.ts`（新） | `sameActionIds` |
| `web/src/lib/perf.ts` | 复用 021；本 spec 增 `scroll.frame` / `hover.render` 两个事件名 |
| `web/e2e/model-picker.spec.ts` | `data-active` 语义用例改写 + Enter-on-hover 新用例 |
| `web/e2e/chat.spec.ts` 或新增 `e2e/scroll.spec.ts` | 到底回滚、脱离吸附不被拽回、停底仍跟随 |
| `web/src/lib/pin.test.ts`（新） | `nextPin` 全分支 |

## 顺序与依赖

```
阶段 A 下拉（T401–T405）── 纯前端 + CSS，症状已证，先出效果
      ↓
阶段 B 消息列表（T406–T410）── 吸底状态机（纯函数先行）→ memo → content-visibility
      ↓
阶段 C 度量与收尾（T411–T414）── perf 埋点、e2e 补齐、真机取值、文档
```

依赖：T401（`data-active` 语义）必须先于 T413（修订既有 e2e 断言）；`pin.ts` 纯函数必须先于 `MessageList` 接入。

## 风险与降级

| 风险 | 缓解 |
|---|---|
| 悬停高亮改 CSS 后与键盘高亮同屏（指针压在 A、键盘在 B）出现两个高亮 | 设计上接受：CSS `:hover` 用弱色、`data-active` 用强色；两者视觉可分（Q2 可调强弱） |
| `content-visibility` 让「跳转到第 N 条」偏差 | `scrollToItem` 跳完二次校正；真机偏移则撤 D6（单条 CSS） |
| `React.memo` 比较器漏掉变化导致 UI 不更新 | 比较器只覆盖 `item` 引用/命中块/action 序列；其余状态（编辑、流式）经 action 序列间接反映；并用 e2e 全量回归兜底 |
| 与 020 改同一批文件冲突 | 实施顺序 020 → 021 → 022，022 按 020 之后的 `PickerModelData` 写 |
| 用户说的第三类「性能问题」不在本 spec 覆盖范围内 | spec 已列三种归位路径；确认后并入 US3 或另立 |

## 验证命令

```bash
cd web
npx tsc --noEmit
npx vitest run src/lib/pin.test.ts src/lib/messageActions.test.ts
npx playwright test e2e/model-picker.spec.ts e2e/scroll.spec.ts
npx playwright test                        # 全量零回归
```

关键断言写法：

```ts
// 悬停不得改键盘项
await options.nth(4).hover();
await expect(options.nth(4)).toHaveAttribute("data-active", "false");
await expect(options.nth(0)).toHaveAttribute("data-active", "true");

// 悬停后 Enter 选中鼠标所指
await options.nth(4).hover();
await page.keyboard.press("Enter");
await expect(page.getByTestId("model-chip")).toContainText(<第 5 项的名字>);

// 到底后向上滚一次必须立刻生效
await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
const before = await list.evaluate((el) => el.scrollTop);
await list.hover();
await page.mouse.wheel(0, -120);
await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeLessThan(before);
```

真机取值（US4）：`scroll.frame` 单次耗时、`hover.render` 渲染次数，记录进 `specs/0.5.7-run-report.md`。

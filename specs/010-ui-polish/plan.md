# Implementation Plan: 界面细节打磨

**Feature**: `specs/010-ui-polish/spec.md`

**Branch**: `release/0.5.2`（直接在版本分支上做）

**Status**: Ready to implement

## 摘要

三处改动都收在渲染层，不涉及桥接协议与 pi 交互：① 用户气泡收紧间距；② 空态在消息区垂直居中；
③ 把 `autosize` 抽成唯一的高度计算入口，所有程序化写入调用它，并把写死的 160px 换成按视口比例的上限。

## 技术上下文

- 前端：React 18 + TypeScript + Vite，样式集中在 `web/src/styles.css`（单文件，约 3.5k 行，
  历史上有「新旧两套定义并存」的坑，改动前先确认命中哪一处定义）。
- 测试：`vitest`（纯函数）、`playwright`（`web/e2e/*.spec.ts`，mock bridge 驱动）、
  JCEF 真机（`scripts/e2e-ide.ps1` + `scripts/e2e-ide.mjs`）。
- 宪法约束：II（几何断言，不得只断言存在）、III（不得依赖运行时环境假设）。

## 现状与目标（实测基线，实现前先复测并写回本文件）

> **T001 基线实测（2026-11-04 夜，680×760 视口，mock bridge，测量脚本 `web/e2e/tmp-baseline-010.spec.ts`（临时，已删））**：
> - 单行用户消息（「好的」）：`.item-user` 高 **72.28px**、`.item-body` 高 **56.28px**。
>   组成 = 旧块 `.item-user { padding: 8px 12px }`（styles.css ~:270，与新块并存未清理）8×2
>   + `.item-body { padding: 8px 12px }` 8×2 + **两个行盒 40.28px**——第二行盒来自
>   `marked` 输出 HTML 的尾部 `\n`（`.item-body` 是 `white-space: pre-wrap`，块级 HTML 后的
>   裸换行渲染成空行盒）。
> - 20 轮固定消息（mock 每轮 3 个 item）：`.message-col` gap **20px**，发送后停在底部时
>   视口内可见 **3** 个 item，整列 scrollHeight 待实现后同口径对比（SC-001 用总高度比 ≤0.85 断言）。
> - 空态垂直偏差（`.empty-logo` 中心 − `.message-list` 可见中心）：**−25 / −175 / −325px**
>   （视口高 300 / 600 / 900）——`margin:auto` 无自由空间可吸收，空态贴顶。
> - 输入框注入 20 行：`clientHeight=140`（CSS `max-height:140px` 生效）、JS inline `height=160px`
>   （两处硬编码且互相矛盾）、`scrollHeight=400`（上限内滚动）；`app.clientHeight=760`
>   → 目标上限 `min(320, 0.45×760)=320px`。

| 项 | 现状 | 目标 |
|---|---|---|
| `.item-user .item-body` padding | `8px 12px`，且旧块 `.item-user { padding: 8px 12px }` 双重叠加 | `6px 10px`（气泡高度比 ≤ 0.85），清除双重 padding |
| marked HTML 尾部 `\n` | 在 `pre-wrap` 下成为空行盒（单行消息多 ~20px） | 渲染前 trim 块间/尾部装饰性换行 |
| `.item-user` max-width | `82%` | 保持 82%（避免长句被压成窄条） |
| `.message-col` 垂直空间 | 高度由内容决定，无自由空间 | `min-height: 100%`，让 `margin:auto` 能吸收垂直余量 |
| `.message-list` 垂直 padding | `20px 16px 8px`（上下不对称 12px） | 上下对称（如 `16px 16px`），否则视觉中心偏 6px |
| `autosize` 上限 | JS 写死 `160px`、CSS `max-height:140px`（两处硬编码且互相矛盾） | `min(320, 0.45 × app 高度)`，单一来源（CSS 变量 `--composer-max-h`，JS 读同一值） |
| `autosize` 调用点 | `onChange`、`pendingPrompt`、发送后重置 | + `insertFile`、编辑回填、目录注入、队列取回 |

## 设计决策

### D1. 气泡紧凑化：只改间距，不改字号

- `.item-user .item-body`：`padding: 6px 10px`，`line-height: 1.45`，`border-radius` 保持现状。
- 消息列 `gap` 从 `20px` 调整为 `14px`（对话密度主要由 gap 决定，比压气泡内边距更有效且不伤可读性）。
- 助手消息的段落间距不动（渲染由 `Markdown` 组件控制，改它会牵动所有既有 e2e 的文本高度断言）。
- **为什么不用 `line-height: 1.2`**：中文密集段落会挤到不可读，且 5 行以上消息的收益递减。

### D2. 空态垂直居中：让父容器有高度，而不是给空态加绝对定位

- `.message-col { min-height: 100%; }` + `.empty-state { margin: auto }`：flex 列容器里 `margin:auto`
  会同时吸收水平与垂直自由空间，这是最小改动且不新增包含块。
- `.message-list` 上下 padding 对称化，消除 6px 的视觉偏差。
- **不采用**：`position: absolute; inset: 0`（会脱离消息流，切会话时闪烁）、`height: 100%`（有消息时会撑出空白）。

### D3. autosize 收口成单一函数 + CSS 变量

```
// web/src/lib/autosize.ts
export function composerMaxHeight(appEl: HTMLElement): number  // min(320, 0.45 * app.clientHeight)
export function autosize(ta: HTMLTextAreaElement, appEl?: HTMLElement | null): void
```

- 上限值写进 CSS 变量 `--composer-max-h`（由 React 在 resize 时设置到 `.app` 上），CSS 与 JS 读同一来源，
  避免「CSS 160 / JS 160」这种两处硬编码。
- 所有写入路径改为 `setText(...)` 之后 `requestAnimationFrame(() => autosize(ta))`；
  为防遗漏，`Composer` 内部用一个 `applyText` 包装器统一处理（替换现有分散的 `setText` 调用）。
- 输入法组合态：在 `onCompositionStart` 置 `composing=true`，`autosize` 期间跳过；`compositionend` 后补一次。
- 发送后 `resetComposerHeight()`：`ta.style.height = ""` + `autosize(ta)`，让 CSS `rows={1}` 生效。

### D4. 断言策略

- 新增 `web/e2e/composer-density.spec.ts`：气泡高度上限与比例、20 条消息首屏条数、代码块无横向溢出。
- 扩展 `web/e2e/layout-regressions.spec.ts`：空态垂直中心（300/600/900）、输入框高度三档宽度。
- 纯函数（`composerMaxHeight` / `clampHeight`）进 `vitest`：给定 scrollHeight 与 app 高度输出确定值。

## 触及文件

| 文件 | 改动 |
|---|---|
| `web/src/styles.css` | `.item-user .item-body`、`.message-list`、`.message-col`、`.composer-input`（`max-height` 改 `var()`） |
| `web/src/components/Composer.tsx` | `applyText` 包装、`autosize` 全路径调用、`--composer-max-h` 设置、composition 处理 |
| `web/src/lib/autosize.ts` | **新增**：唯一的高度计算实现 |
| `web/src/lib/autosize.test.ts` | **新增**：边界值单测 |
| `web/e2e/composer-density.spec.ts` | **新增** |
| `web/e2e/layout-regressions.spec.ts` | 追加空态垂直中心与输入框高度断言 |
| `MANUAL_TEST.md` | 追加三条真机判据（气泡观感、空态居中、注入长文本后可见） |

## 顺序

1. 先量基线（写入本文件表格），否则 SC-001 的 15% 无从判断。
2. `autosize.ts` + 单测（纯函数先行，符合宪法「先断言后实现」）。
3. 气泡与空态样式 + e2e 断言。
4. `Composer.tsx` 收口 + 三档宽度 e2e。
5. 真机（JCEF）目视 + `scripts/e2e-ide.ps1` 跑一遍既有用例。

## 风险

| 风险 | 缓解 |
|---|---|
| `styles.css` 里同一类名有多处定义，改了不生效 | 改动前 `grep -n "^\.item-user"` 确认只有一处生效定义（0.5.1 已合并重复定义，本次复核） |
| 气泡变紧后，既有 e2e 的高度/位置断言失效 | 先跑全量 e2e 拿基线，逐条判断是「断言过严」还是「回归」，过严的断言按新基线更新并在提交信息里说明 |
| `min-height: 100%` 在 flex 子项上可能引发滚动条抖动 | 用 `min-height: 100%` 而非 `height: 100%`；e2e 断言 `scrollWidth === clientWidth` 且在 300px 高度下无纵向抖动（连续两次量高度一致） |
| CJK 输入法导致高度抖动 | composition 期间跳过 autosize，e2e 无法覆盖，写进 `MANUAL_TEST.md` |

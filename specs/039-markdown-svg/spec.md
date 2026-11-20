# Feature Specification: Markdown 渲染增强（中）——内联 SVG 安全渲染

**Feature Branch**: `release/0.5.10`

**Created**: 2026-11-16

**Status**: Implemented（已实现并随 0.5.10 内测；发布文案见 changelog.d/039-*；真机审查另修正了 SVG 远程 URI 净化，见该 spec 的真机审查修订）

**Input**: 用户提出（2026-11-16，第 3 条拆分后的「中」档）
> 扩展格式的支持 SVG、Mermaid、KaTeX 数学公式、diff 高亮、脚注。可按难易程度拆分成多个spec。

本规格覆盖**内联 SVG 渲染**：pi 回复或扩展包内容里出现 `<svg>…</svg>` 时，在消息中直接渲染为图形，而非被当作纯文本/被净化成空白。安全是本规格的核心约束。diff 高亮 + 脚注见 038；KaTeX + Mermaid 见 040。

## 可行性与现状（读码核实）

- 渲染栈：`marked ^15` → `DOMPurify.sanitize` → `dangerouslySetInnerHTML`（`Markdown.tsx`）。DOMPurify 默认**允许** `<svg>` 元素但会清理危险属性，是否放行取决于净化配置与 hook——现状未显式配置 SVG 白名单，需实现期实测。
- **能否复用 IDE 自身能力（用户 2026-11-16 要求纳入考量）**：已核实 UI 是**独立 web server + JCEF**（`LocalUiServer.kt`），插件 `plugin.xml` 未声明对 IDE Markdown / SVG 预览能力的依赖，因此**不能直接复用 IDE 的 Markdown 预览渲染器**。结论：SVG 渲染必须在前端渲染栈内实现。可复用的「IDE 侧能力」仅限：外部链接仍走 `BrowserUtil.browse`（系统浏览器）这类已打通的通路；IDE 图标资源约定仅作图标风格参考，不作运行时依赖。此结论写死，避免实现期走弯路。
- **无新依赖**：SVG 渲染用浏览器原生 `<svg>`，核心工作是 DOMPurify 白名单配置 + 样式约束，不涉及 npm 新包。

## User Scenarios & Testing

### US1 - 内联 SVG 显示为图形 (P1)
pi 回复中包含合法内联 SVG（`<svg viewBox=...>…</svg>`）时，消息中渲染出对应图形，尺寸受容器约束（不撑破消息气泡、不溢出工具窗）；SVG 之外的文本正常排版。

### US2 - 恶意/畸形 SVG 被安全拦截 (P0)
含 `<script>`、`onload`/`onerror` 等事件属性、外部引用（`xlink:href` 指向远程、`foreignObject` 内嵌 HTML、`@import` 等）的 SVG 必须被净化：危险标签/属性被移除，**不得执行脚本、不得发起外部请求、不得突破消息容器**。畸形/不完整 SVG 不得导致整条消息渲染失败或白屏。

### US3 - 零回归 (P1)
放行 SVG 不得让其它 HTML 注入面变大：普通 Markdown、代码块高亮、文件链接、脚注（038）、复制按钮全部零回归。

## Requirements

- **FR-001** 合法内联 SVG MUST 在消息中渲染为图形，尺寸 MUST 受消息容器约束（自适应缩放、不得溢出）。
- **FR-002** SVG 渲染 MUST 经 DOMPurify 严格净化：MUST 放行 svg 基本图形元素（svg/path/rect/circle/line/polygon/g 等）与必要属性（viewBox/宽度高度/fill/stroke 等），MUST 移除 `<script>`、全部 `on*` 事件属性、`foreignObject`、指向远程的 `xlink:href`/`href`、`@import`、`url(http…)` 等可执行或外链向量。
- **FR-003** 净化 MUST 在现有 `DOMPurify` 单一入口完成，MUST NOT 为 SVG 新增第二条 innerHTML 注入路径或跳过净化的渲染通道。
- **FR-004** 畸形/不完整 SVG MUST 优雅降级（净化后显示为空或占位），MUST NOT 抛错、白屏或使整条消息渲染失败。
- **FR-005** 本增强 MUST NOT 回归现有 Markdown 行为（代码块、文件链接、表格、复制按钮、008 双语等）。
- **FR-006** 已核实 UI 为独立 web server + JCEF、无法直接复用 IDE Markdown 预览（见可行性结论）；实现 MUST 在前端渲染栈内完成，外部链接仍复用 `BrowserUtil.browse` 系统浏览器通路。

## Decisions（用户已拍板）

| # | 问题 | 结论 |
|---|---|---|
| Q1 | 拆分档位 | 「中」档，独立 spec 039 |
| Q2 | SVG 安全口径 | **严格净化**：DOMPurify 白名单放行 svg 标签但禁 script/on* /外部引用，防 XSS |
| Q3 | 能否复用 IDE 自身能力 | 已核实不能直接复用 IDE Markdown 预览（独立 web UI）；仅复用系统浏览器打开通路，结论写进 spec |

## 待 plan 阶段决定的技术问题（本规格不锁定）

- DOMPurify 的 SVG 白名单具体配置（`ADD_TAGS` / `ADD_ATTR` / `FORBID_TAGS` / URI 协议白名单）与 hook 用法。
- SVG 尺寸的 CSS 约束策略（viewBox 自适应 vs 固定 max-width/height）。

## 不做的事

- 不引入 SVG 渲染专用 npm 库（浏览器原生 `<svg>` 足够）。
- 不做 SVG 编辑器、上传、另存为。
- 不做 Mermaid / KaTeX（见 040）、diff / 脚注（见 038）。
- 不绕过 DOMPurify、不新增第二条 innerHTML 注入路径。

## 与既有规格/事实的关系

- 沿用 003 的净化与安全原则；不改变 015 的文件链接与 016 的拖拽。
- 与 038、040 共同构成「Markdown 格式扩展」三条独立规格，可分别交付。

## 验证计划（实现后填写，本规格仅列判据）

| 层 | 用例 | 期望 |
|---|---|---|
| vitest | 合法 SVG | 渲染出 `<svg>` DOM，尺寸受约束，文本排版正常 |
| vitest | 恶意 SVG（script / onload / foreignObject / 远程 xlink:href / @import） | 危险标签属性被移除，无脚本、无外链请求 |
| vitest | 畸形 SVG | 不抛错、不白屏，降级为空或占位 |
| vitest | 零回归 | 普通 Markdown / 代码块 / 文件链接 / 脚注 / 复制按钮断言通过 |
| e2e | mock 含 SVG 的 pi 回复 | 图形渲染，恶意样例被净化 |
| 真机 | JCEF 下含 SVG 的消息 | 显示正确、不溢出、无样式错乱 |

## 反馈批次修订（2026-11-17，0.5.10 内测）

### #6 直接贴 SVG 源码：渲染 vs 代码块展示的边界（对应 US1 / US2）

- **现象**：用户直接把 `<svg>…</svg>` 源码贴进 pi 回复/内容时，展示形态与预期不一致——有时当内联图形渲染、有时是代码块源码，用户问"区别是什么、如何优化"。
- **根因（读码核实）**：`Markdown.tsx:183-197` 的链路是 `marked.parse` → DOMPurify → `dangerouslySetInnerHTML`。裸贴的 SVG 若未被围栏包裹，`marked` 按 HTML 块处理 → DOMPurify 默认 svg profile 放行 → **渲染为图形**（US1 的正常路径）；若贴进 ` ``` ` 围栏或缩进成代码块，则 `marked` 当成代码 → hljs 高亮为源码文本。两条路径都是设计内行为，"区别"即**是否处于围栏代码块**，并非 bug；真正的体验缺口是"用户想展示源码时误渲染成图、想渲染成图时却被当代码"缺少明确可控的语义与提示。
- **期望**：明确并记录边界——① 内联裸 SVG（无围栏）= 渲染为图形；② 围栏内的 SVG 源码 = 代码块展示（可复制、可「在 IDE 打开」，见 041）；③ 二者都不降低安全净化标准。优化方向（用户问"如何优化"）：在预览/降级提示中让用户能区分"这是图形还是源码"，或对"看起来像 SVG 源码却被围栏包裹"给出轻量提示；**具体交互口径留 plan 与用户再确认**，本批只锁定边界语义、不擅自加行为。
- **边界**：不为裸 SVG 新增第二条 innerHTML 注入路径（FR-003 不变）；恶意 SVG 仍按 US2 净化。
- **回归判据**：vitest/e2e 分别喂裸 SVG 与围栏 SVG，断言前者出 `<svg>` DOM、后者出代码块且源码可复制；恶意样例两路径均被净化。

## 开放问题

无阻塞项。拆分档位、安全口径、IDE 能力复用结论均已拍板/核实。裸 SVG vs 围栏源码的优化交互口径留 plan 阶段与用户确认。

---

## 二次修订（2026-11-20，用户新需求推翻 #6 边界）

用户当天提出：**「代码块的 SVG 也要能渲染成图」**。这直接推翻了上面 #6 锁定的边界「② 围栏内的 SVG 源码 = 代码块展示（永不渲染）」：

- **新边界**：① 裸 SVG（无围栏）= 渲染为图形（不变）；② **围栏内的 SVG = 同样渲染成图形**（源码隐藏，但**可复制、可在 IDE 打开**——复制按钮读的仍是源码，`ide.openSnippet` 收到的也是源码）；③ 两者都不降低安全净化标准。
- **落地**：新增 `specs/048-code-block-header/spec.md`（围栏渲染属 048 的 FR-005；净化口径仍属本规格）。实现走与 Mermaid 同构的结构：围栏源码经 DOMPurify 净化后插进 `pre` 内的图形容器，画不出东西的（空壳、畸形、只剩 `<script>`）降级回源码显示，且不出现「复制为图片」入口（047 FR-007）。
- **净化加严**：`<style>` 一并禁掉（`FORBID_TAGS: ["script", "foreignObject", "style"]`）。DOMPurify 不清洗 `style` 标签的**文本内容**，里面的 `@import url(...)` / `url(http…)` 是外链向量，而 FR-002 明确要求移除 `@import`、`url(http…)`——此前只靠 DOMPurify 默认配置并没有真正做到，属于本规格的旧账，本轮补上。
- **回归判据**：e2e 断言围栏里的合法 SVG 渲染成图形（且与裸 SVG 各渲染一次）、围栏里的恶意 SVG 被净化并降级回源码、渲染结果里无 `script` / `foreignObject`、源码仍可复制。

---

## 真机审查修订（2026-11-20，release/0.5.10 真机质量审查 P0-1）

- **现象**：规格假设 DOMPurify 会剥掉 SVG 里指向远程地址的 `xlink:href`，但实测 DOMPurify 3.4.17 **放行** http/https 的 `xlink:href`（只拦 `javascript:` 等危险协议）——即渲染层允许一条从外部站点取资源的引用。
- **修订**：净化钩子在 DOMPurify 之后追加一步：SVG 命名空间节点上，凡是 `href` / `xlink:href` 不是以 `#` 开头的**一律移除**（保留文档内片段引用）。同时修掉规格/注释里「DOMPurify 已剥远程 href」的错误断言。
- **回归判据**：e2e 断言恶意 SVG 的远程 `xlink:href` 不出现在渲染结果里（原来那条断言用 `[xlink\:href]` 选择器，在 HTML 里匹配不到命名空间属性，一直是假绿）；单测覆盖命名空间与片段引用的区别。

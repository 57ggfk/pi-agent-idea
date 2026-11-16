# Feature Specification: Markdown 渲染增强（中）——内联 SVG 安全渲染

**Feature Branch**: `release/0.5.10`

**Created**: 2026-11-16

**Status**: Draft（需求已收集、疑问已澄清；只产出 spec，不写 plan/tasks，不实现）

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

## 开放问题

无阻塞项。拆分档位、安全口径、IDE 能力复用结论均已拍板/核实。

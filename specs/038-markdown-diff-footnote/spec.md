# Feature Specification: Markdown 渲染增强（易）——diff 高亮 + 脚注

**Feature Branch**: `release/0.5.10`

**Created**: 2026-11-16

**Status**: Implemented（已实现并随 0.5.10 内测；发布文案见 changelog.d/038-*）

**Input**: 用户提出（2026-11-16，第 3 条拆分后的「易」档）
> 扩展格式的支持 SVG、Mermaid、KaTeX 数学公式、diff 高亮、脚注。可按难易程度拆分成多个spec。

本规格覆盖**成本最低的两项**：diff 代码块高亮、GFM 脚注。二者都基于现有 `marked ^15 + highlight.js ^11 (common) + DOMPurify ^3` 渲染栈，几乎不引入新依赖。SVG（039）、KaTeX + Mermaid（040）另立规格。

## 可行性与现状（读码核实）

- 渲染入口：`web/src/components/Markdown.tsx`，`marked.setOptions({ gfm: true, breaks: true })`，代码高亮用 `hljs.highlightElement`（`highlight.js/lib/common`，`:151-153`）。
- **diff 高亮**：`highlight.js` 的 `common` 包**包含** diff 语言（需实现期实测确认），大概率只需确保 ```` ```diff ```` 被正确高亮 + 补少量 diff 专用配色（增/删/行首符号），属「配置 + 样式」级。若 common 未含 diff，则按需注册 `highlight.js/lib/languages/diff`，仍是低成本。
- **脚注**：`marked` 的 GFM 支持是否含脚注需实现期实测（marked 历史上脚注是可选扩展）。若原生不支持，用轻量 marked 扩展或 `marked-footnote` 类方案，成本仍属低档。
- **安全**：所有 HTML 经 `DOMPurify.sanitize`（`:1` 及 hook），新增渲染不得绕过净化。

## User Scenarios & Testing

### US1 - diff 代码块高亮 (P1)
pi 返回含 ```` ```diff ```` 代码块时，新增行（`/` 前缀行首 `+`）与删除行（`-`）以可辨识颜色高亮（遵循项目红涨绿跌之外的**代码语义**：新增绿、删除红属 diff 通用约定，不冲突），行首符号清晰；不像普通代码块那样一色平铺。

### US2 - 脚注渲染 (P2)
pi 返回含 GFM 脚注（`[^1]` 引用 + `[^1]: 内容` 定义）的 Markdown 时，引用处渲染为上标链接、文末生成脚注列表、点击可跳转；脚注内容同样经过净化与链接处理，不出现原始 `[^1]` 裸文本。

## Requirements

- **FR-001** ```` ```diff ```` 代码块 MUST 有语法高亮，新增/删除行 MUST 视觉可区分（颜色 + 行首符号）。
- **FR-002** diff 高亮 MUST 沿用现有 `highlight.js` 渲染链路（`highlightElement`），MUST NOT 另起一套高亮实现；如需语言注册，MUST 用 `highlight.js` 官方语言包。
- **FR-003** GFM 脚注 MUST 渲染为「上标引用 + 文末脚注列表 + 可跳转」三要素，MUST NOT 留下 `[^n]` 裸标记。
- **FR-004** 脚注实现 MUST 保持 DOMPurify 净化（防 XSS），脚注内的链接/文件引用 MUST 走与正文一致的处理（文件链接识别、外部链接系统浏览器打开）。
- **FR-005** 两项增强 MUST NOT 回归现有 Markdown 行为：普通代码块高亮、行内文件链接（`src/App.tsx:12`）、纯文本路径识别、表格、复制按钮、消息内的点击打开——全部零回归。
- **FR-006** 若某项经实测已由现有栈原生支持，则只补必要的样式/断言，不重复造轮子；实现记录 MUST 写明「原生支持 / 新增实现」的结论与依据。

## Decisions（用户已拍板）

| # | 问题 | 结论 |
|---|---|---|
| Q1 | 第 3 条拆分方式 | 拆 3 份（易/中/难）；本份为「易」= diff 高亮 + 脚注 |
| Q2 | 依赖口径 | 接受引入新前端依赖；但本档优先复用现有栈，仅实测不足时才新增轻量依赖 |

## 待 plan 阶段决定的技术问题（本规格不锁定）

- diff 语言是否已在 `highlight.js/lib/common` 内（实测确认）；diff 专用配色是 CSS 覆盖还是 hljs 主题。
- 脚注用 marked 原生 / 扩展 / 轻量库——以实现期对 marked ^15 的实测为准。

## 不做的事

- 不做 SVG、KaTeX、Mermaid（分别见 039 / 040）。
- 不重构整个 Markdown 组件或替换渲染栈（marked/highlight.js/DOMPurify 保留）。
- 不改变消息复制、Quote、Fork 等与 Markdown 相邻的既有行为。

## 与既有规格/事实的关系

- 沿用 018 的消息样式改动（表格弱边框等）与 003 的安全净化原则。
- 不触碰 015 的文件引用链接语义与 016 的拖拽。

## 验证计划（实现后填写，本规格仅列判据）

| 层 | 用例 | 期望 |
|---|---|---|
| 单测/vitest | ` ```diff ` 代码块渲染 | 新增/删除高亮 class 存在，行首符号正确 |
| vitest | 脚注渲染 | 上标引用 + 文末列表 + 锚点跳转，无 `[^1]` 裸文本 |
| vitest | 安全 | 脚注/diff 内嵌 `<script>` / `onload` 被净化；文件链接与外部链接处理不变 |
| vitest | 零回归 | 普通代码块、行内文件链接、表格、复制按钮断言仍通过 |
| e2e | mock 含 diff/脚注的 pi 回复 | 渲染出高亮与脚注结构，点击链接行为正确 |
| 真机 | JCEF 下含 diff/脚注的消息 | 显示正确，无白屏/样式错乱 |

## 开放问题

无阻塞项。拆分口径与依赖口径已于 2026-11-16 拍板。

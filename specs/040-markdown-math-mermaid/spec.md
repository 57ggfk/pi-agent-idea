# Feature Specification: Markdown 渲染增强（难）——KaTeX 数学公式 + Mermaid 图表

**Feature Branch**: `release/0.5.10`

**Created**: 2026-11-16

**Status**: Implemented（已实现并随 0.5.10 内测；发布文案见 changelog.d/040-*；真机审查另放宽了行内公式尾随字符集，见该 spec 的真机审查修订）

**Input**: 用户提出（2026-11-16，第 3 条拆分后的「难」档）
> 扩展格式的支持 SVG、Mermaid、KaTeX 数学公式、diff 高亮、脚注。可按难易程度拆分成多个spec。

本规格覆盖成本最高的两项：**KaTeX 数学公式**（行内 `$…$` / 块级 `$$…$$`）与 **Mermaid 图表**（```` ```mermaid ```` 代码块）。二者都需引入新前端依赖、涉及自定义渲染与渲染时机，故合并为「难」档、独立排期。diff 高亮 + 脚注见 038，SVG 见 039。

## 可行性与现状（读码核实）

- 渲染栈：`marked ^15 + DOMPurify ^3 + highlight.js ^11 (common)`（`Markdown.tsx`）。现有依赖清单**无** KaTeX / Mermaid。
- **KaTeX**：需引入 `katex` npm 包 + marked 扩展（识别 `$…$` / `$$…$$` 并输出 KaTeX 渲染 HTML）+ KaTeX CSS。成本主要在扩展与 CSS 随包加载。现成 `marked-katex-extension`（周下载 30 万+，持续维护）可直接用，支持 `throwOnError: false` 与 `nonStandard` 等选项，成本进一步降低。

**数学公式格式生态调研（2026-11-16，回答「除 KaTeX 外还有哪些格式 / 支持程度 / 难度 / 是否全支持」）**：

- **关键区分**：数学公式有「输入语法」与「渲染引擎」两层，不可混谈。
- **输入语法层**：① LaTeX（`$…$` 行内 / `$$…$$` 块级 / `\(…\)` / `\[…\]` / ` ```math ` 围栏）——AI 输出的事实标准，占绝大多数；② MathML（`<math>` XML）——W3C 标准，浏览器原生可渲染，但 AI 几乎不产出；③ AsciiMath（`x^2`）——仅 MathJax 支持，生态小。
- **渲染引擎层**：KaTeX（~30KB gzip、同步、覆盖约 90% 常用 LaTeX、快）｜MathJax 4（~250KB、覆盖最广、三种输入全吃、异步、配置重）｜原生 MathML（0KB、Chromium 109+ 原生、无障碍最好，但需 LaTeX→MathML 转换前置）。
- **「全支持」三种口径**：(a) 覆盖主流 LaTeX 语法 → KaTeX 即可，低难度；(b) 覆盖三种输入语法 → 仅 MathJax，包体积翻数倍且 AI 不产后两种，投入产出比低；(c) 完整 LaTeX 编译（TikZ / `\label`/`\eqref` / 自定义宏包）→ 连 MathJax 都不是完整 TeX 引擎，聊天场景无此需求。
- **本规格取舍**：维持 KaTeX，目标口径 = (a) 全覆盖主流 LaTeX 语法；实现期顺带让扩展识别 `\(…\)` / `\[…\]` / ` ```math ` 等 LaTeX 变体分隔符（现成扩展基本支持，边际成本极低）。**不引入 MathJax、不做 AsciiMath、不做完整 LaTeX 编译**——理由：AI 输出以 LaTeX 为主，(b)(c) 对聊天场景是过度工程。此项为调研结论，不改变用户已拍板的 Q1–Q4。
- **Mermaid**：需引入 `mermaid` npm 包；复杂度高于 KaTeX——异步渲染、渲染时机（React effect）、主题与 JCEF OSR 下的绘制、宽高尺寸、导出/复制交互都需处理。
- **能否复用 IDE 自身能力（用户要求纳入考量）**：已核实 UI 为**独立 web server + JCEF**（`LocalUiServer.kt`），插件未声明对 IDE Markdown / 数学 / 图表预览的依赖，**不能复用 IDE 自带渲染**。结论：两项都在前端渲染栈内实现；仅外部链接复用 `BrowserUtil.browse` 系统浏览器通路。
- **安全**：新增渲染仍须经 DOMPurify 净化；Mermaid/KaTeX 输出的 HTML/SVG 同样要防 XSS 与外链向量（与 039 SVG 口径一致）。

## User Scenarios & Testing

### US1 - 数学公式渲染 (P1)
pi 回复含行内 `$E=mc^2$` 或块级 `$$\sum…$$` 时，渲染为排版良好的数学公式（KaTeX 风格），行内与块级布局正确、不溢出消息气泡；公式内容经净化，不因公式里的特殊字符破坏页面。

### US2 - Mermaid 图表渲染 (P1)
pi 回复含 ```` ```mermaid ```` 代码块时，渲染为对应流程图/时序图等图形，尺寸受容器约束、主题可读（浅色主题，与 IDE light 主题一致）；渲染失败（语法错误）时降级显示源码或友好提示，不白屏。

### US3 - 零回归与性能 (P1)
两项增强不影响现有 Markdown（代码块高亮、文件链接、表格、脚注 038、SVG 039、复制按钮）；异步渲染（尤其 Mermaid）不得阻塞消息列表滚动或造成明显卡顿；新增依赖不打乱现有 e2e/build 基线。

## Requirements

- **FR-001** 行内 `$…$` 与块级 `$$…$$` 数学公式 MUST 渲染为 KaTeX 排版结果，布局正确、不溢出容器。
- **FR-002** KaTeX 渲染 MUST 经现有 DOMPurify 净化链路，公式内的危险 HTML/外链向量 MUST 被移除；MUST NOT 绕过净化。
- **FR-003** ```` ```mermaid ```` 代码块 MUST 渲染为对应图表，主题 MUST 适配**面板当前主题**（IDE light 或 dark，跟随用户在「选项 → 主题」的选择），尺寸 MUST 受容器约束。**2026-11-20 用户反馈修订**：此前主题写死为 mermaid 的浅色（`theme: "default"`），深色 IDE 里画出来是白底浅紫的方块，和旁边 IDE 自带的深色 Mermaid 预览完全不像一个东西；现改为跟随面板主题（内置主题 + 面板自身配色），切换主题时重绘。
- **FR-004** Mermaid 渲染失败（语法错误 / 超时 / 依赖异常）MUST 优雅降级（显示源码或友好提示），MUST NOT 白屏、抛错或使整条消息渲染失败。
- **FR-005** 两项 MUST 沿用现有 Markdown 组件与净化单一入口，MUST NOT 新增第二条 innerHTML 注入通道。
- **FR-006** 新增用户可见文案（如降级提示）MUST 双语（en/zh）；新增依赖 MUST 纳入构建与 e2e 基线核对。
- **FR-007** 实现前 MUST 先做 Mermaid 真机 JCEF 探针，验证：渲染时机、OSR 下绘制、主题、尺寸、与滚动/复活的交互；探针结论回填 plan 后再写实现。KaTeX 如无同等风险可不做探针前置。
- **FR-008** 已核实不能复用 IDE 自带渲染（独立 web UI，见可行性结论）；实现 MUST 在前端渲染栈内完成，仅外部链接复用系统浏览器通路。

## Decisions（用户已拍板）

| # | 问题 | 结论 |
|---|---|---|
| Q1 | 拆分档位 | 「难」档，独立 spec 040；与 038/039 可分别交付 |
| Q2 | 依赖口径 | **接受引入新前端依赖**（KaTeX、Mermaid 作为新 npm 包，接受包体积增加） |
| Q3 | Mermaid 风险 | **实现前先真机验证**（探针）：渲染时机/主题/导出复杂，spec 先写目标，探针结论回填 plan |
| Q4 | IDE 能力复用 | 已核实不能直接复用 IDE Markdown 预览（独立 web UI）；仅复用系统浏览器通路 |

## 待 plan 阶段决定的技术问题（本规格不锁定）

- KaTeX 扩展写法（自定义 marked renderer vs 现成 `marked-katex-*` 扩展）、CSS 随包加载方式。
- Mermaid 渲染方案（异步 effect / 懒加载 / 实例管理）、主题配置、尺寸约束、与消息重渲染/虚拟列表的交互。
- 两者对首屏体积与 e2e 基线的影响评估。

## 不做的事

- 不做公式/图表的编辑、导出图片、另存为、放大查看（后续真需求再立）。
- 不做 SVG（039）、diff / 脚注（038）之外的新格式。
- 不重构 Markdown 组件或替换渲染栈（marked/highlight.js/DOMPurify 保留）。
- 不在无探针结论的情况下直接写 Mermaid 实现（FR-007 硬约束）。

## 与既有规格/事实的关系

- 与 038 / 039 共同构成「Markdown 格式扩展」三条独立规格。
- 沿用 003 的净化安全原则与 039 的 SVG 净化口径（Mermaid 输出含 SVG，同样严格净化）。
- 主题遵循 IDE light（用户 IDE Theme = light）；不触碰 016 拖拽、015 文件链接语义。

## 验证计划（实现后填写，本规格仅列判据）

| 层 | 用例 | 期望 |
|---|---|---|
| 探针（前置） | Mermaid 真机 JCEF 渲染 | 渲染时机/OSR 绘制/主题/尺寸/滚动交互结论回填 plan |
| vitest | KaTeX 行内/块级 | 渲染为 KaTeX 结构，不溢出，特殊字符不破坏页面 |
| vitest | KaTeX 安全 | 公式内危险 HTML/外链被净化 |
| vitest | Mermaid 正常/失败 | 正常出图；语法错误降级为源码或友好提示，不白屏 |
| vitest | 零回归 | 普通 Markdown / 代码块 / 文件链接 / 脚注 / SVG / 复制按钮断言通过 |
| e2e | mock 含公式与 Mermaid 的 pi 回复 | 渲染正确，链接与降级行为正确 |
| 真机 | JCEF 下公式与图表消息 | 显示正确、主题适配、滚动无卡顿 |
| 静态 | verifyPlugin | 无 internal API；构建体积/e2e 基线变化已评估 |

## 反馈批次修订（2026-11-17，0.5.10 内测）

### #5 Mermaid 语法错误时布局下方溢出 `Syntax error in text` 区域（对应 FR-004）

- **现象**：pi 回复含语法错误的 mermaid 块时，消息区下方多出一片空白/区域，显示一条或多条 `Syntax error in text`，且随流式重渲染可能累积多条。
- **根因（读码核实）**：`mermaidRender.ts:49-50` 调用 `mermaid.render(id, text)`；mermaid 在 `parse`/`render` 抛错前会**自行向 `document.body`（或 SVG 容器）注入一个 error div**（mermaid 默认 error 渲染），这段 DOM 不受我们的 `.mermaid-figure` 容器约束、也不随 source 变化回收。我们的 `catch`（`:59-63`）只把失败缓存为 null 后原块降级，**没有清理 mermaid 注入的游离 error 节点**——于是每次不同 source 的失败各留一个错误块，堆积在布局下方；`root.querySelectorAll` 只遍历消息内的 code 块，管不到 body 上的注入。
- **期望**：Mermaid 渲染失败（语法错/超时/依赖异常）时，① 不向消息容器之外注入任何可见 DOM，② 已有 error 节点被清理，③ 多块/流式重渲染不累积错误区域，④ 就地降级为源码块（FR-004 原义不变）。
- **实现方向（plan 决定具体）**：渲染前用 `mermaid.parse(text)` 预校验，失败即跳过 `render` 不触发其错误渲染；或渲染后按 id 清除 mermaid 注入的 error 节点（`div[id^=d]` / `.error-icon` 等，以实测为准）；两者择一或并用，须真机复现闭环。
- **回归判据**：vitest/e2e mock 多块语法错误 mermaid，断言 `document.body` 与消息区无 `Syntax error` 文本节点、错误块数恒为 0/1 不随重渲染递增；正常图表渲染零回归。

- **真机取证（2026-11-17，探针 `web/probe-feedback-0517.mjs mermaid`，0.5.9 构建 / JCEF CDP 9222）**：
  - 触发方式：经 composer 让 pi 输出一个语法错误的 ```` ```mermaid ```` 块（源码 `graph TD / A[start] --> B( bad syntax >>>`）。
  - **坐实泄漏**：`document.body` 出现 **3 个直接子 `DIV`**——第 1 个是 React app 根，第 2、3 个是 mermaid 注入的游离节点（各约 2520 字符、含 `Syntax error in text`），**均不在 `[data-testid="message-list"]` 内**。每个游离 DIV 内含一个 `<svg>`（id 前缀 `pi-mermaid-N`），error 文本在 `<g><text>Syntax error in textmermaid version 12.3.0Parse error on line 4…`。
  - **坐实累积**：同一次会话里出现 `pi-mermaid-1`、`pi-mermaid-4` 等多个错误 SVG（编号随渲染递增），证明不同 source 的失败各留一份、`catch` 未回收——与上文读码根因一致。
  - 对实现方向的修正：清理目标确定为**按 `id^=pi-mermaid-` 的游离 `<div>`/`<svg>`**（不是泛化的 `div[id^=d]`），且 `mermaid.parse()` 预校验可从根本上避免触发错误渲染；清除时注意只删 body 直属的游离节点，勿碰 `.mermaid-figure` 内的正常图。
  - 证据文件：`%TEMP%/fb-probe-mermaid.json`（`leakage.outsideMessageList=8`、`bodyKids[1/2].hasSyntax=true`）。

## 开放问题

无阻塞项。拆分档位、依赖口径、Mermaid 探针前置、IDE 能力复用结论均已拍板/核实。

---

## 真机审查修订（2026-11-20，release/0.5.10 真机质量审查 P1-2）

- **现象**：行内公式 `$x+1$` 后面紧跟标点时，只有 12 种尾随字符能正常渲染，其余 10 种（逗号、句号、分号、闭括号、书名号等）整条公式不渲染——因为上游 `marked-katex-extension` 的 inline 扩展只允许空白或少数标点收尾。
- **修订**：新增本地扩展 `web/src/lib/katexInline.ts`，替换上游 inline 扩展的 start/tokenizer（保留其 renderer），把「闭合 `$` 后允许的尾随字符」放宽到 `;；)）\]】、」』”’/+=(`；**行首/空格约束与「闭合 `$` 后须为空白或标点」约束保持不变**，货币符号（`$5`）仍不会被误判成公式。
- **回归判据**：新增 `web/src/lib/katexInline.test.ts` 覆盖 22 种尾随字符（含货币与不应渲染的边界）；e2e 断言 `$x+1$; $y+2$); $z+3$、` 三种尾随都渲染。

---

## 用户反馈修订（2026-11-20，深色主题下的 Mermaid 样式）

> 黑色主题下的样式能优化吗，你看人家原生的效果。

- **现象**：面板为深色时，消息里的 Mermaid 图仍是浅色（白底浅紫方块 + 深色文字），而同一屏 IDE 自带的 Mermaid 预览是深色的——两张图放在一起像两个产品。根因：`web/src/lib/mermaidRender.ts` 把 mermaid 主题**写死**为 `theme: "default"`（浅色），且配色不跟随面板。
- **修订**：① 主题改为跟随面板（`document.documentElement.dataset.theme`，由 store 驱动，与用户在「选项 → 主题」的选择一致）；② 配色取自面板自身的 CSS 变量（`--bg-input` / `--text` / `--border-strong` / `--text-secondary` 等），画布透明，图表直接融进气泡；③ 主题切换时重新 initialize mermaid 并重绘，渲染缓存按 (主题, 源码) 分键；④ 图上标记 `data-mermaid-theme`，主题写错时可见而不是静默。
- **真机取证（IDEA 2026.2 + CDP 9222，0.5.9 构建）**：面板主题 `dark` → 图的主题 `dark`、节点填充 `rgb(43,45,48)`（= `--bg-input`）、标签文字 `rgb(230,232,235)`（= `--text`）、画布 `rgba(0,0,0,0)`；截图见运行报告。KaTeX 公式在深色下本就跟随 `--text`（实测 `rgb(230,232,235)`），无需改动。
- **回归判据**：`web/e2e/markdown-mermaid.spec.ts` 新增一条「图跟随面板主题」——浅色面板下图节点为亮色、主题标记 `default`；切到深色后主题标记变 `dark`、节点填充亮度 < 0.2、标签亮度 > 0.5。**负向验证**：把内置主题写死回 `default` 后该用例必红。

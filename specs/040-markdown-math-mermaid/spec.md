# Feature Specification: Markdown 渲染增强（难）——KaTeX 数学公式 + Mermaid 图表

**Feature Branch**: `release/0.5.10`

**Created**: 2026-11-16

**Status**: Draft（需求已收集、疑问已澄清；Mermaid 实现前须先真机探针；只产出 spec，不写 plan/tasks，不实现）

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
- **FR-003** ```` ```mermaid ```` 代码块 MUST 渲染为对应图表，主题 MUST 适配浅色（IDE light）主题，尺寸 MUST 受容器约束。
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

## 开放问题

无阻塞项。拆分档位、依赖口径、Mermaid 探针前置、IDE 能力复用结论均已拍板/核实。

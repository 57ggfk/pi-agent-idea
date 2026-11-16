# Feature Specification: 代码块在 IDE 中打开（关联语法高亮）

**Feature Branch**: `release/0.5.10`

**Created**: 2026-11-16

**Status**: Draft（需求已收集、疑问已澄清；只产出 spec，不写 plan/tasks，不实现）

**Input**: 用户提出（2026-11-16，Markdown 格式扩展讨论中的延伸想法）
> 有没有一种方式在 IDE 中打开片段并关联语法格式，如果有所有的代码片段也可以支持了。

本规格解决的是**任意语言代码块的「在 IDE 中打开并高亮」**——利用 IDE 自身注册的语言能力，一次覆盖所有语言，无需逐个在前端加语言包。它与 038/039/040 的**内联渲染**互补而非替代：内联渲染负责「在对话流里看到图/公式」，本规格负责「把代码拿去 IDE 里细看」。

## 可行性与现状（读码核实）

- **前端代码块**：`web/src/components/Markdown.tsx` — `marked` 把围栏代码块渲染为 `<pre><code class="language-xxx">`，`hljs.highlightElement`（`:151-153`）用 `highlight.js/lib/common` 高亮；现有 `addCopyButtons`（`:104-136`）在每个 `pre` 右上角注入 Copy 按钮，本规格的按钮沿用同一注入机制（`code.className` 的 `language-xxx` 即语言 id 来源，块内容取自 `code.textContent`）。
- **宿主桥接**：`BridgeService.kt` 已有 `ide.openFile`（`:782-792`）与 `ide.showFileDiff`（`:800+`），但两者都走 `resolveFile(path)` 并要求**磁盘上已存在的文件**，找不到即抛错；**没有**「打开内存文本 + 关联语言」的能力，需新增一个桥接方法。
- **平台能力（现成、零新依赖）**：`LightVirtualFile(name, fileType, text)` 创建内存文件 → `LanguageManager.getInstance().getLanguage(id)` 按语言 id 查语言 / 或按扩展名经 `FileTypeManager` 查 fileType → `FileEditorManager.getInstance(project).openFile(vf, true)` 打开。全部属于 `com.intellij.modules.platform`，插件**已依赖**，不需要改 `plugin.xml` 或引入任何新库。
- **能力边界（重要）**：本方案只解决「语法高亮 / 代码查看」，**不能**替代内联渲染——
  - SVG / Mermaid / KaTeX：IDE 一般只高亮源码、不渲染成图/公式，且跳到 IDE 是跳出对话的交互（039/040 继续负责内联出图/公式）。
  - diff：IDE 原生 diff 需要「改前/改后」两份文本，消息里的 unified diff 不一定能吃；diff 高亮由 038 在前端低成本解决。
  - 结论：**不缩减 038–040 的范围**，本规格为能力补充。

## User Scenarios & Testing

### US1 - 用 IDE 查看任意语言代码块 (P1)
pi 返回一段代码块（如 ```` ```rust ````、```` ```solidity ```` 等前端 highlight.js 未内置的语言）时，用户点代码块右上角的「在 IDE 打开」按钮，IDE 弹出一个只读编辑器标签页，内容为该段代码，并按对应语言语法高亮（若 IDE 装了相应语言插件）。关闭标签页即弃，不留磁盘文件。

### US2 - 语言无法识别时优雅降级 (P2)
代码块的语言 id 在 IDE 中找不到对应语言/文件类型（如自定义标记 `language-foobar`），按钮仍可用，打开后以纯文本显示，不报错、不白屏，也不影响其他代码块的按钮。

### US3 - 流式输出与批量代码块 (P2)
消息仍在流式输出、一个回复含多个代码块时，每个块各有独立按钮；点击任一按钮只打开对应块的内容（按下按钮那一刻读取 `code.textContent`），不串块、不因 React 重渲染丢失按钮或状态。

## Requirements

- **FR-001** 每个围栏代码块 MUST 在右上角有「在 IDE 打开」按钮，与现有 Copy 按钮并列且不互相遮挡。
- **FR-002** 点击按钮 MUST 新增桥接方法 `ide.openSnippet`，参数至少含 `language`（从 `class="language-*"`，无则空串）与 `text`（点击时从 `code.textContent` 读取，不用缓存的旧值）。
- **FR-003** 宿主 MUST 创建**内存**文件（`LightVirtualFile` 或等价形态）并以 IDE 原生编辑器打开，MUST NOT 在磁盘/项目目录留下任何文件，MUST NOT 污染工作区或版本控制。
- **FR-004** 宿主 MUST 按 `language` 关联 IDE 已注册的语言/文件类型以启用语法高亮；找不到对应语言时 MUST 降级为纯文本成功打开，MUST NOT 抛错到前端。
- **FR-005** 打开的文件 MUST 为**只读查看**（用户可复制/浏览，不作为源码文件参与 IDE 的索引、重构、查找引用等）；本规格不提供保存回写能力。
- **FR-006** 本功能 MUST NOT 回归现有 Markdown 行为：Copy 按钮、普通代码块高亮、行内文件链接、纯文本路径识别、外部链接系统浏览器打开——全部零回归。
- **FR-007** 新增桥接方法 MUST 沿用现有 `bridge` 调用/错误返回约定（`ok` + 错误码形状），失败时前端不崩溃、可给出轻量提示。
- **FR-008** 按钮文案 MUST 走 i18n（中英文），MUST NOT 硬编码中文。

## Decisions（用户已拍板 2026-11-16）

| # | 问题 | 结论 |
|---|---|---|
| Q1 | 定位 | **新增 041 作为互补独立 spec**；038/039/040 内联渲染范围不变，不缩减 |
| Q2 | 触发方式 | 代码块右上角加「在 IDE 打开」按钮（与 Copy 并列），不改成点整块打开 |
| Q3 | 文件形态 | **内存只读查看**——LightVirtualFile，关闭即弃，不留磁盘、不污染工作区 |

## 待 plan 阶段决定的技术问题（本规格不锁定）

- 语言 id 映射：`language-xxx` → IDE `Language`/`FileType` 的具体策略（直接 `LanguageManager.getLanguage(id)`，还是经一小张别名表如 `js→JavaScript`、`ts→TypeScript`、`py→Python`）；映射失败降级纯文本的判定点。
- 内存文件名：用什么名让 IDE 正确选到 fileType（如 `snippet.<ext>`），以及多个块同时打开时的命名去重。
- 只读实现：`LightVirtualFile` 的只读标志 / `FileEditor` 的选项，确保不参与索引与重构。
- 前端按钮注入：是否与 `addCopyButtons` 合并为「块级动作条」重构，还是在同一次 `pre` 遍历里追加一个按钮（后者改动更小）。
- 桥接方法签名细节：是否带 `filename` 覆盖参数、错误码命名。

## 不做的事

- 不做内联渲染 SVG / Mermaid / KaTeX（见 039 / 040），不缩减 038 的 diff 范围。
- 不保存片段回磁盘、不写回 pi 会话、不参与 IDE 索引/重构。
- 不替换前端 `highlight.js` 渲染栈——对话内仍用它高亮，本规格只加「跳转 IDE 查看」的出口。
- 不做「选中文本在 IDE 打开」「整条消息在 IDE 打开」等扩展形态。

## 与既有规格/事实的关系

- 与 038（diff 高亮）、039（SVG）、040（KaTeX/Mermaid）**互补**：各自负责内联渲染，本规格负责跳出到 IDE 的代码查看。
- 复用 015 的「代码/文件引用 → IDE」交互范式与 `ide.openFile` 的 `OpenFileDescriptor.navigate` 模式（区别在数据源是内存文本而非磁盘文件）。
- 001/003 的安全净化仍适用：语言 id 来自已净化的 `class`，`text` 来自 `textContent`，不把富文本传给宿主。

## 验证计划（实现后填写，本规格仅列判据）

| 层 | 用例 | 期望 |
|---|---|---|
| 单测/vitest | 代码块注入按钮 | 每个 `pre` 有 Copy + 「在 IDE 打开」两按钮，互不遮挡 |
| vitest | 点击取数 | mock `ide.openSnippet`；多块/流式 delta 下点击，参数 `language`/`text` 对应正确块 |
| vitest | 零回归 | Copy、普通高亮、行内文件链接、外部链接、表格断言仍通过 |
| Kotlin 单测/集成 | `ide.openSnippet` 常见语言 | 打开的内存文件关联到预期语言、语法高亮生效 |
| Kotlin 单测/集成 | 未知语言降级 | 以纯文本打开成功，`ok=true`，无异常抛出 |
| 真机 JCEF | 点按钮打开 ` ```rust ` 等冷门语言 | IDE 弹出只读标签页并按语言高亮；磁盘无新文件；关闭即弃 |
| 真机 | 工作区/版本控制 | 打开前后 `git status` 无变化，项目树无新增节点 |

## 开放问题

无阻塞项。定位/触发/文件形态三条已于 2026-11-16 拍板。

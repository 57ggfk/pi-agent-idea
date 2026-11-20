# Feature Specification: 代码块在 IDE 中打开（关联语法高亮）

**Feature Branch**: `release/0.5.10`

**Created**: 2026-11-16

**Status**: Implemented（已实现并随 0.5.10 内测；发布文案见 changelog.d/041-*）

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

- **FR-001** 每个围栏代码块 MUST 在右上角有「在 IDE 打开」按钮，与现有 Copy 按钮并列且不互相遮挡。**2026-11-20 用户反馈修订**：按钮条改为位于代码块**上方外侧**（右上角、块之外）、**悬浮块才出现**，且必须保证鼠标从块里移到按钮的途中按钮不消失、能点到（见「用户反馈修订」一节）。
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

## 反馈批次修订（2026-11-17，0.5.10 内测）

### #10 「在 IDE 打开」代码片段只识别为纯文本（对应 FR-004）

- **现象**：用户反馈代码块点「在 IDE 打开」后只按纯文本显示，没有语法高亮。
- **根因（读码核实）**：`SnippetFiles.kt:17-44` 的 `ideLanguageId` 别名表只覆盖常见语言，冷门/变体语言 id（如 `sol`、`protobuf`、`vue`、`bash` 之外的 shell 变体等）落到 `else -> null`；`buildVirtualFile`（`:81-87`）随后把 `mapped` 兜为 raw id 再 `Language.findLanguageByID`——IDE 的语言 id 常与 fence id 不同（大小写/命名差异，如 fence `shell` vs 语言 `Shell Script`），找不到就 `PlainTextFileType.INSTANCE` 降级（US2 允许，但覆盖不足成了实质缺陷）。
- **期望**：扩展语言识别命中率——① 扩充别名表（覆盖 IDE 实际注册的 `Language.findLanguageByID` 可用 id）；② 增加按扩展名反查 fileType 的兜底（已有 `extensionFor`，但当前只对 mapped 命中才用 language 关联）；③ 仍是"找不到才降级纯文本"（US2 不变），但不得因别名表缺项把 IDE 本就支持的语言误降为纯文本。
- **回归判据**：Kotlin 单测扩展示例（含 `sol`/`vue`/`text` 等）断言 fileType 非 PlainText；真机冷门语言打开有高亮；未知语言仍成功降级为纯文本、零回归。

### #9 生成的 SVG 文件点击「在 IDE 打开」失败（对应 FR-004 / 与 015 openFile 相邻）

- **现象**：pi 生成/引用一个 `.svg` 文件，用户点击打开时无法从 IDE 打开。
- **根因（待实现期真机确认，读码初判）**：两条候选——① `SnippetFiles.extensionFor`（`:47-74`）别名表**没有 `svg`**，且 `ideLanguageId` 也无 `svg`，内联 svg 代码块走纯文本（与 #10 同源）；② 若为磁盘上的 `.svg` 文件走 `openFileInEditor`（`BridgeService.kt:788-798`）→ `resolveFile(path)`，则需确认 `resolveFile` 对 svg 扩展名/路径的解析与 `FileTypeManager` 是否识别 SVG 文件类型。真机复现前不锁死根因。
- **期望**：SVG（内联代码块与磁盘文件两种形态）都能在 IDE 中打开查看——内联走扩展别名 + fileType 反查命中 SVG/XML 类型；磁盘文件走 `resolveFile` 正常定位并以 IDE 识别的类型打开；失败不得静默，按 FR-007 返回可感知错误。
- **回归判据**：vitest 断言 `SnippetFiles` 对 svg 返回可用 fileType；e2e/真机点击生成的 `.svg` 文件成功打开、有内容；`resolveFile` 对 svg 路径测试通过。
- **真机取证（2026-11-17，隔离实例 / 0.5.9 构建）——两条常见路径均未复现"打不开"**：
  - 磁盘 svg 文件（untitled/circle.svg）双击 → IDE 原生打开，以 XML 文本呈现 + 右侧 SVG 预览窗格，正常。
  - 内联 svg 代码块（让 pi 输出 ```svg，点"在 IDE 打开"）→ 走 `openSnippet` 生成 `pi-snippet-1.svg`，IDE 以 XML 类型打开成功（含"阅读器模式"按钮）；代码块高亮为 `hljs language-xml`。说明 `extensionFor` 的 else 分支返回 `"svg"` 已能让 IDE 识别类型，候选①（无 svg 别名导致纯文本）在真机上**未成立**。
  - **结论**：用户反馈的"生成 svg 文件点击打不开"未能在常见路径复现，两条候选中的①（无 svg 别名导致纯文本）在真机上未成立。
  - **用户补充的确切复现路径（2026-11-17 口述，仅记录、本轮不探测）**：在会话中让 pi **绘制/生成一个 SVG 文件**，消息里会出现一个**「新增文件的 diff 块」**；用户点的是**这个 diff 块里的文件**（想从 IDE 打开），而不是代码块或普通 `@path` 链接，此时打不开。→ 之前推测的"工具写磁盘文件"方向正确，但**入口应锁定为 diff 块的新增文件**，而非泛泛的 `@path` 引用；可能是 038 diff 块的文件链接未接 `openFile`/`resolveFile`，或该 diff 块走的是与 `.file-link` 不同的点击路径。plan 阶段按此路径补探针，不据本轮"两条常见路径未复现"关闭该条。

## 用户反馈修订（2026-11-20，真机审查）

用户对内容块按钮的交互提出三点异议，全部指向 FR-001 的呈现形态：

> 我让你改内容块按钮放到的上侧你没改。svg 还有代码块等改成鼠标悬浮按钮并在块的右上侧、是在块之外，并且保证鼠标移动过去可以点击。请重新优化按钮样式，还有复制为图片的样式很奇怪，和旁边按钮样式不一致。

### 修订结论

| # | 用户诉求 | 落地规则（对应 FR-001） |
|---|---|---|
| R1 | 按钮放到内容块的**上侧**（此前仍压在块内右上角） | 操作条定位在块的**上方外侧**（右上角、块之外），不再覆盖代码/图形内容 |
| R2 | SVG / 代码块等改成**悬浮才出现** | 操作条默认 `opacity:0; pointer-events:none`，仅在悬浮块（或指针在条上）时显现 |
| R3 | **保证鼠标移动过去可以点击**（途中按钮不能消失） | 指针离开块后延迟 300ms 才隐藏；操作条自带透明下内边距「安全桥」；指针进入操作条立即取消隐藏 |
| R4 | **重新优化按钮样式**，「复制为图片」与旁边按钮不一致 | 复制 / 在 IDE 打开 / 复制为图片 三类按钮统一到同一套 `.block-action-btn` 外观（同底色、同边框、同圆角、同字号、同阴影） |

### 实现要点（why）

- **壳容器 + 兄弟节点**：代码块自身 `overflow-x: auto`（横向滚动）会裁掉越界的绝对定位子元素，故用 `.block-shell` 包裹 `pre`，操作条作为 `pre` 的**兄弟节点**并以壳为定位上下文，才能真正落在「块之外的上方」。
- **JS 悬浮状态机 + 指针坐标记忆**（`wireBlockActions`）：按钮在块外，纯 CSS `:hover` 在指针离开块的瞬间就失效；且 React 每个流式增量都重建 innerHTML，`:hover` 状态随之丢失会导致流式期间按钮闪没。故记录最近一次指针坐标，重建后按坐标恢复显示并临时关闭过渡动画。
- **旧类名保留**：`.code-copy-btn` / `.code-ide-btn` / `.copy-image-btn` 保留（e2e 与既有依赖），仅新增共享类 `.block-action-btn`。

### 回归判据

`web/e2e/block-actions.spec.ts` 五条：① 操作条底边在块顶边之上且右对齐；② 悬浮前 `opacity<0.05` 且 `pointer-events:none`；③ 真实鼠标从块移动到按钮后可点击并得到 ✓；④ 三类按钮计算样式完全一致；⑤ 窄图形的操作条在图形上方、完整落在消息列内（不被横向裁剪）。

### 真机取证（2026-11-20，IDEA 2026.2 + JCEF CDP 9222，0.5.9 构建）

真实 pi 回复产出的代码块，实测（`/tmp/probe-block-actions.mjs`）：

| 探测项 | 实测值 | 结论 |
|---|---|---|
| 悬浮前 | `opacity: 0`、`pointer-events: none` | 默认隐藏 ✅ |
| 操作条 vs 代码块几何 | 条底边 `383` = 块顶边 `383`；条右边 `580` = 块右边 `580` | 操作条在**块外上方**、与块右边缘对齐 ✅ |
| 悬浮代码块后 | `opacity: 1`、`pointer-events: auto` | 悬浮即出现 ✅ |
| 鼠标从块移到按钮途中（6 步采样） | `[1,1,1,1,1,1]` | **途中从不消失** ✅ |
| 真实点击复制按钮 | 按钮文案变为 `✓` | 点得到、反馈正常 ✅ |
| 复制 / 在 IDE 打开 / 复制为图片 三按钮计算样式 | 10px 字号、4px 圆角、1px 边、`1px 6px` 内边距、`rgb(43,45,48)` 底色、`rgb(160,164,171)` 字色、同一阴影 | **三者完全一致** ✅ |

真机还暴露了一条只在窄图形上出现的问题并已修掉：图形靠消息列左边缘时，比图形宽的操作条向左长会被列的 `overflow-x: hidden` 裁掉（按钮左半截消失、点不到）。修法见 047 的「槽位」与对齐规则。

## 开放问题

无阻塞项。定位/触发/文件形态三条已于 2026-11-16 拍板；按钮呈现形态已于 2026-11-20 按用户反馈修订（见上节）。

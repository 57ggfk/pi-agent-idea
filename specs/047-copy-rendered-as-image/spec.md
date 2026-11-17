# Feature Specification: 渲染内容复制为图片

**Feature Branch**: `release/0.5.10`

**Created**: 2026-11-17

**Status**: Draft（用户 2026-11-17 追加需求；只产出 spec，plan/tasks 待后续）

**Input**: 用户提出（2026-11-17，内测反馈批次后追加）
> 扩展格式的支持 SVG、Mermaid、KaTeX 数学公式等支持复制为图片。

## 一、意图与边界（用户表述 + 本规格锁定）

用户希望把消息里"图形化渲染"的内容以**图片**形式复制到系统剪贴板，便于粘贴到文档、聊天、PPT 等处。当前这些格式只能复制源码文本（代码块 Copy）或根本无复制入口。

本规格锁定四点边界：

1. **覆盖范围 = SVG（039）、Mermaid 图表、KaTeX 数学公式（040）** 三类前端渲染为图形/排版结果的内容。用户原话的"等"**不扩展**到：代码块（已有复制文本，语义不同）、整条消息/整页导出为图片（另一个量级的需求）。
2. **只读已渲染结果**：复制的是用户在消息里看到的渲染成品，不是重新渲染或重新排版；输入源必须是经过 DOMPurify 净化后的 DOM（039 FR-002/003、040 FR-002/005），不得绕过净化另开渲染路径。
3. **只做"复制为图片"**：不做"保存为图片文件"（`ide.saveImage` 已在 012 图片预览提供）、不做图片预览/缩放。
4. **不预设取图手段、允许分格式搁置**：用户只要求"复制为图片"这一结果，**没有要求任何格式先转成 SVG 或经某条固定路径**——具体实现手段由 plan/探针阶段决定（见 Q5）。若某格式经探针证明在本环境无法稳定取图、或需引入破坏 OSR 稳定性的重依赖，则该格式**先搁置**，记为开放项，不硬啃、不阻塞其余格式先行交付。

## 二、可行性与现状（读码核实）

- **剪贴板通道已存在**：012 已实现 `ide.copyImage`，Kotlin 侧写系统剪贴板（AWT `imageFlavor`），前端只传 `{ data }`（图片 data URL）；契约见 `specs/012-0.5.4-features/plan.md:139`，实现见 `ImagePreview.tsx:194-209` 的 `copyImage()`。旧结论（012 `clipboard.ts` 注释）认为"JCEF 无 async clipboard API，图片复制必须走桥接"——**该前提已被 2026-11-17 真机探针推翻，见本节末「真机取证」**；走桥接还是前端直写留 plan 定（Q3 待复核）。
- **三类内容的渲染 DOM 形态不同**（如何实现"渲染结果→图片"属 plan/探针阶段的实现细节，本规格**不预设任何具体手段**，不假设任何格式要先转成 SVG 或经某条固定路径）：
  - **SVG / Mermaid**：mermaid.render 产出 `<svg>`，内联 SVG 也是 `<svg>`——渲染结果本身已是矢量 DOM，取图方式由实现期决定。
  - **KaTeX**：渲染产物是 HTML `<span>` + MathML，浏览器没有原生 DOM→图片 API，取图方式同样留实现期决定；须避免引入会破坏 OSR 绘制稳定性的重依赖。**这是必须在 plan 阶段先做探针的点，探针判不可行则按 Q5 搁置。**
- **现有按钮拥挤风险**：代码块已有「复制文本」+「在 IDE 打开」两个按钮（041，`Markdown.tsx:125-210` 的 `addCopyButtons`），本规格再插入「复制为图片」入口需复用同一容器，避免三按钮挤压与 e2e 命中测试失败（参见既有 CSS 踩坑：`.btn` 28px 固定高、工具条被 paint containment 裁切）。
- **流式重渲染**：消息在 assistant 流式期间反复重渲染，按钮注入需要幂等（现有 `if (pre.querySelector(".code-copy-btn")) return` 模式可借鉴），否则会重复堆叠；040 #5 的"游离 error DOM 累积"正是同类教训。

**真机取证（2026-11-17，探针 `web/probe-feedback-0517.mjs capture`，0.5.9 构建 / JCEF CDP 9222，证据 `%TEMP%/fb-probe-capture.json`）**：

| 探测项 | 实测值 | 结论 |
|---|---|---|
| `navigator.clipboard` / `.write` / `.writeText` | 全部 `true` | **推翻旧结论**：当前 JCEF（Chrome 144 内核）已有 async clipboard，不再"必然无" |
| `ClipboardItem` | `"function"` | 图片直写的必要类型存在 |
| `document.execCommand` | `"function"` | fallback 也在 |
| `canvas` 2d / `toDataURL` / `toBlob` | 全可用；`toDataURL` 产出 `data:image/png;base64,…`，`toBlob` 产出 `blob:image/png:106` | 栅格化输出 data URL/Blob 无障碍 |
| **SVG → Image → canvas → PNG** | `"OK:data:image/png;base64,"` | **SVG / Mermaid（渲染为 `<svg>`）取图链路真机跑通** |
| KaTeX DOM | `katexIsSvg:false`、`katexHasAnnotation:false`，样本为 `<span class="katex"><span class="katex-mathml"><math …>` | 坐实 KaTeX = HTML+MathML，无原生 SVG 取图路径——仍是最大不确定点 |

- **重要更正**："JCEF 无 async clipboard、必须走 `ide.copyImage`"是早期版本结论，当前内核已具备 `navigator.clipboard.write` + `ClipboardItem`。但**"API 存在" ≠ "图片写入一定成功"**——真机补测（2026-11-17，CDP 注入 `navigator.clipboard.write([new ClipboardItem({"image/png": blob})])`）报 **`NotAllowedError: Document is not focused`**：`document.hasFocus()` 在 OSR + CDP 注入下恒为 false，`Page.bringToFront` / `body.focus()` 均无法改变。这说明直写受焦点/用户手势约束——**CDP 自动化无法验证直写**（真实用户点击按钮时页面通常是 focused，仍可能可用）。因此 Q3（剪贴板通道）由"已定复用桥接"**改回待复核**：桥接（`ide.copyImage`）不受焦点约束、是真机已验证通路，作为默认兜底；直写路线如需采用，须用**真实点击按钮**（非 CDP 注入）验证往返成功。两者都不新增桥接方法。
- 证据 JSON：`%TEMP%/fb-probe-capture.json`。

## 三、User Scenarios & Testing

### US1 - 复制 Mermaid 图表为图片 (P1)
消息里有一张 Mermaid 渲染的流程图，用户点该图上的「复制为图片」，系统剪贴板得到一张 PNG；粘贴到 Word / 聊天窗口显示为图片而非 `<svg>` 源码或路径文本。

### US2 - 复制 SVG 图形为图片 (P1)
内联 SVG（039）渲染出的图形支持同样的一键复制为 PNG；畸形 SVG 降级为空/占位时不显示复制按钮（无可复制成品）。

### US3 - 复制 KaTeX 公式为图片 (P1，探针优先 / 可搁置)
行内 `$…$` 或块级 `$$…$$` 公式（040）支持复制为 PNG；复制结果保留 KaTeX 的排版与字形，不出现字体丢失、上下标错位或空图。若探针判定 KaTeX 在本环境无法稳定取图，按 Q5 **先搁置该格式**（不显示入口、记为开放项），不阻塞 SVG / Mermaid 先行交付。

### US4 - 一致性 / 不干扰 (P1)
已交付格式的入口位置、点击反馈（成功/失败提示双语）、幂等行为一致；代码块「复制文本」「在 IDE 打开」及图片预览的复制/保存全部零回归；渲染失败或取图失败时有可见失败提示，绝不静默假装成功（对齐 012 的真实 bug 教训）。

## 四、Requirements

- **FR-001** 通过探针的格式渲染块 MUST 提供「复制为图片」用户入口，入口与现有「复制文本」明确区分（文案/图标双语）；被 Q5 搁置的格式 MUST NOT 显示无功能入口。
- **FR-002** 复制结果 MUST 为 PNG 图片写入**系统剪贴板**；通道二选一（plan 探针定）：前端 `navigator.clipboard.write(new ClipboardItem(...))` 直写，或复用 012 `ide.copyImage` 桥接。**MUST NOT 新增桥接方法**。真机已证实当前 JCEF 具备 async clipboard（见二节末），但图片写入往返须实测成功才算直写可用。
- **FR-003** 复制源 MUST 是该块经 DOMPurify 净化后的已渲染 DOM；MUST NOT 绕过 039 FR-002/003 与 040 FR-002/005 的净化单一入口。
- **FR-004** 渲染结果→图片 MUST 在前端完成并输出图片 data URL 交给桥接（**具体手段由探针/plan 决定，本规格不预设**）；取图失败 MUST 返回失败并给用户可见提示，MUST NOT 影响原消息渲染与流式更新。
- **FR-005** 失败/成功提示 MUST 双语（en/zh），对齐 040 FR-006 与项目 i18n 单一来源。
- **FR-006** 本增强 MUST NOT 回归：代码块复制文本、041「在 IDE 打开」、012 图片预览的复制/保存、038–040 全部 Markdown 渲染与 008 双语。
- **FR-007** 流式/重渲染场景下按钮注入 MUST 幂等（同一块不重复注入），且不在降级块/占位块/已搁置格式上显示入口。
- **FR-008** **实现前 MUST 先做 JCEF 真机探针**（对齐 040 FR-007 的前置约束）。已完成的探测（2026-11-17，见二节末）覆盖：① canvas / `toDataURL` / `toBlob` 可用；② SVG→Image→canvas→PNG 链路跑通；③ KaTeX 确认为 HTML+MathML 无原生 SVG 路径；④ `navigator.clipboard.write` + `ClipboardItem` 存在。**仍须补测**：⑤ 前端 `clipboard.write(ClipboardItem)` 写一张 PNG 后能否从系统剪贴板读回（成败定 Q3 走直写还是桥接）；⑥ KaTeX 取图可行性与字形；⑦ 各格式 PNG 在 OSR 下非空、尺寸/字形正确；⑧ 若某格式取图不可行或需破坏 OSR 稳定性的重依赖，记录原因并按 Q5 搁置。探针结论回填 plan 后才写实现。

## 五、Decisions（2026-11-17）

| # | 问题 | 结论 |
|---|---|---|
| Q1 | 覆盖范围 | SVG + Mermaid + KaTeX 三类图形化渲染内容；代码块（复制文本）与整条消息导出不纳入 |
| Q2 | 是否新增 spec | **独立 047**：横切 039/040，塞进任一现有 spec 都越界 |
| Q3 | 剪贴板通道 | **待复核**（2026-11-17 真机推翻旧前提）：当前 JCEF 已有 `navigator.clipboard.write` + `ClipboardItem`，前端直写图片**可能**可用；需 plan 补"写图往返"探针后再定走直写还是复用 012 `ide.copyImage`。两者都不新增桥接方法 |
| Q4 | 版本 | **0.5.10**（用户 2026-11-17 指定） |
| Q5 | 做不了怎么办 | **分格式独立交付、允许搁置**：某格式经探针证明在本环境无法稳定取图（或成本/依赖不可接受）→ 该格式先搁置、记为开放项，不硬啃、不为它引入破坏 OSR 稳定性的重依赖；不阻塞其余已验证可行的格式先行交付 |

## 六、待 plan 阶段决定的技术问题（本规格不锁定）

- **KaTeX 取图方式**（最大不确定点）：具体手段由 FR-008 探针决定，本规格**不预设**（不假设要先转成 SVG 或任何中间格式）；须评估新依赖体积、OSR 绘制稳定性、字形一致性；探针判不可行则按 Q5 搁置。
- **SVG / Mermaid 取图细节**：净化后 DOM 里外链字体/CSS 变量在脱离原页面取图时可能丢失；`<foreignObject>` 已被 039 净化移除，需确认不影响观感。
- 输出 PNG 的分辨率倍率（1×/2×/跟随设备 DPR）、背景（透明 / 适配 IDE 浅色主题的白底）、留白边距。
- 按钮呈现形态：hover 工具条图标 vs 常驻角标；与代码块「复制文本」「在 IDE 打开」共用容器时的布局（注意 041 与既有工具条裁切踩坑）。
- 流式期间按钮注入时机与重渲染后的幂等策略（借鉴 040 #5 error DOM 清理教训）。
- `ide.copyImage` 的 `{ data, mimeType }` 入参需确认与取图输出的 data URL 格式严格匹配（现有实现只被图片预览调用过 PNG data URL）。

## 七、不做的事

- 不新增 IDE 桥接方法（图片写剪贴板在"前端直写"与"复用 `ide.copyImage`"间二选一，二者都不新增方法）。
- 不改 039/040 的渲染与净化逻辑本体（只消费其净化后的 DOM）。
- 不把代码块、整条消息、页面导出为图片。
- 不做「保存为图片文件」（012 图片预览已有 `ide.saveImage`）。
- 不做图片预览/缩放/AIGC 类图像编辑。
- 不为某个做不了的格式硬引入重依赖或第二条渲染/剪贴板通路（按 Q5 搁置）。

## 八、与既有规格的关系

- **039（内联 SVG）/ 040（KaTeX + Mermaid）**：本规格消费二者净化后的渲染 DOM，是这两个渲染能力的"导出"下游，不反向修改其渲染逻辑。
- **012（图片预览）**：`ide.copyImage` / `ide.saveImage` 桥接来源；本规格复用 `copyImage` 而非另起通路。
- **041（代码块在 IDE 打开）**：按钮同处代码/渲染块工具条，需注意布局与 e2e 命中；041 的"在 IDE 打开"不属于本规格的复制图片范畴。
- **038 / 008**：Markdown 基础行为与双语文案的零回归约束沿用。

## 九、验证计划

| 层 | 用例 | 期望 |
|---|---|---|
| 真机探针（FR-008，部分已完成） | 已完成：canvas/SVG→PNG、clipboard API 存在、KaTeX DOM 形态（见二节末）；待补：clipboard 写图往返、KaTeX 取图、各格式 PNG 质量 | PNG 非空、尺寸/字形正确、写图能从系统剪贴板读回；不可行格式按 Q5 搁置并记录原因；结论回填 plan |
| vitest | 取图纯函数（尺寸计算 / data URL 生成） | 合法输入产出 PNG data URL；非法/空输入走失败分支 |
| e2e | mock 剪贴板写入（直写用 mock `clipboard.write`，桥接用 mock `ide.copyImage`，按 Q3 结论择一） | 已交付格式均有入口；写入内容为 PNG；成功/失败提示双语；失败不假绿；搁置格式无入口 |
| e2e | 幂等与零回归 | 流式重渲染不重复注入按钮；代码块 Copy / 041 打开 / 图片预览全过 |

## 开放问题

无阻塞项。范围、独立 spec、搁置策略（Q5）、版本（Q4 = 0.5.10）均已定；**Q3 剪贴板通道待复核**——真机已证实 JCEF 有 async clipboard（旧"必须走桥接"结论作废），但图片写入往返未实测，plan 补探针后定直写或桥接；各格式取图手段由 FR-008 剩余探针锁定，判不可行的格式按 Q5 搁置。

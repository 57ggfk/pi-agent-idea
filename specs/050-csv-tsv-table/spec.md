# Feature Specification: CSV / TSV 代码块渲染成表格

**Feature Branch**: `release/0.5.10`

**Created**: 2026-11-24

**Status**: 已实现（2026-11-24；Q1–Q5 已拍板，T501–T511 见 [./tasks.md](./tasks.md)）

**Input**: 用户提出（2026-11-24，内测第四轮）
> csv等格式支持渲染为表格，还有什么格式来着
> → 核对后确认本仓库并无 CSV/TSV 表格渲染，用户拍板新增该能力。

**GitHub Issue**: [#3 · CSV / TSV 代码块渲染成表格 · Render CSV / TSV code blocks as tables](https://github.com/57ggfk/pi-agent-idea/issues/3)（需求单，与本 spec 互链；issue 号与 `specs/NNN` 编号**解耦**）

## 一、意图与边界

模型输出的 CSV / TSV 只能逐行读原始分隔符文本。期望：**` ``csv ` / ` ``tsv ` 代码块渲染成表格**。

本规格锁定六条边界：

1. **只做 CSV + TSV**（用户 2026-11-24 拍板）。JSON / YAML / XML 不做。
2. **只认围栏**（用户拍板）。正文里的裸 CSV 一律不自动识别 —— 自动嗅探的误判面太大（任何含逗号的多行正文都可能被误判成表格）。
3. **大块数据截断而非降级**（用户拍板）：超过 200 行渲染前 200 行并标注「已截断」。不是"降级成源码"。
4. **纯前端**：不改 Kotlin、不改桥接协议、不新增 npm 依赖。
5. **复用既有链路**：渲染 ⇄ 源码切换（049）、标题栏（048）、表格弱边框与表头灰底（018 US4 / 010）。**不改**现有 Markdown 管道表的行为。
6. **不给「复制为图片」**：047 的复制为图片只覆盖 SVG / Mermaid / KaTeX 三类渲染块；表格转图片要栅格化整表，收益低、风险高。

## 二、可行性与现状（读码核实）

- **现有渲染链路**（`web/src/components/Markdown.tsx`）：
  - `RENDERABLE_LANGS = new Set(["svg", "mermaid"])`（:245）—— 只有这两类围栏默认渲染成图。
  - `applyBlockViewMode(code, theme, intent, index)` 是**唯一**的模式分发点：`lang === "svg" ? renderSvgFence(code) : await renderMermaidBlock(code, theme)`。
  - 渲染失败 → `showSourceBlock` 降级回源码，「渲染」按钮闪 ✗（049 US3 的现成机制）。
  - `renderSvgFence` 是**同步**的：在 `pre` 前插一个 `<div class="svg-figure">`、填 `innerHTML`（已净化）、`code.style.display = "none"`。CSV 表格与它同构，**照抄这个形状**即可，不需要异步，也就不存在 mermaid 那个"并发 null 请求拆掉图形"的老账。
- **表格样式底子**（`web/src/styles.css`）：`.markdown table`（:386）`border-collapse: collapse`、单元格 `1px solid var(--border)`、`thead th` 有 `background: var(--table-head-bg)`。**但没有横向滚动容器** —— 消息列是 `overflow-x: hidden`（:2404），超宽的 Markdown 表格会被裁掉。018 US4 明确把"超宽表格的横向滚动"列为非目标，本规格**不碰管道表**，只给 CSV 表格自带滚动容器。
- **围栏语言标签**：`LANG_LABELS`（:262 附近）没有 csv / tsv → 标题栏会显示 "Text"，要补。
- **i18n**：在 `web/src/i18n/locales/zh.ts` 与 `en.ts`。新增两条 `markdown.tableRowsTruncated` / `markdown.tableColsTruncated`（行、列各一条 —— 一条文案说不清是行还是列被截了）。
- **mock**：`web/src/bridge/mock.ts` 的 `mdKnob`（:2512 起）现有 table / longline / diff / math / mermaid / svg 六个场景 → 新增 `csv` / `csv-big` / `csv-wide` 三个场景供 e2e 使用。拆三个是因为 mock 逐行流式（每个非空白串一个 chunk、间隔 40ms），205 行的样本混在一起会让每条 e2e 都白等 8 秒。
- **无既有 CSV 实现**：全仓 grep `csv|tsv` 只命中 `web/package-lock.json` 里某个依赖的 bin 名（csv2json / csv2tsv / json2csv / tsv2csv / json2tsv / tsv2json），不是我们的代码；`web/src/lib/` 下无任何相关模块。
- **依赖策略**：手写解析器（`web/src/lib/dsvTable.ts`，约 80 行）而不是引 papaparse —— 049 已定「不新增依赖」，且所需能力（RFC4180 引号 + 分隔符嗅探 + 行列截断）远小于 papaparse 的完整能力面。

## 三、User Scenarios & Testing

### US1 - CSV 块渲染成表格 (P1)
pi 回复含 ` ``csv ` 块时，块默认渲染成表格：第一行进表头（灰底），其余行进数据行；单元格内容与原文逐字一致（含引号转义后的真实值）；源码隐藏。

### US2 - TSV 同样渲染 (P1)
` ``tsv ` 块按制表符分隔渲染成表格；围栏语言与实际分隔符不符时（模型把 TSV 标成 csv）仍能正确渲染。

### US3 - 可切回源码 (P1)
标题栏出现「源码」按钮，点一下表格收起、原始 CSV 文本显示（与 049 的 mermaid / svg 同构）；再点回来表格恢复。

### US4 - 大块数据截断并标注 (P1)
300 行的 CSV 只渲染前 200 行，表格上方有一行「已截断：共 300 行，仅显示前 200 行」；中文 / 英文各一份。

### US5 - 宽表可横向滚动 (P1)
30 列的 CSV 表格不被消息列裁掉：表格容器 `scrollWidth > clientWidth` 且能横向滚动。

### US6 - 解析失败降级 (P1)
内容不是表格（没有分隔符 / 只有一行）时，块显示源码，标题栏「渲染」按钮点下去闪 ✗，不给点了没反应的按钮。

### US7 - 零回归 (P1)
既有 Markdown 管道表、脚注、diff 高亮、KaTeX、mermaid / svg 围栏、代码块按钮全部不受影响。

## Requirements

- **FR-001** ` ``csv ` / ` ``tsv ` 围栏 MUST 默认渲染成表格（表头进 `<thead>`），源码隐藏。
- **FR-002** 解析 MUST 遵守 RFC4180：双引号包裹的字段内可含分隔符与换行，`""` 表示一个引号。
- **FR-003** 列数 MUST 以表头为准：短行补空单元格，长行截断多余列。
- **FR-004** 分隔符 MUST 按围栏语言取（csv → `,`、tsv → `\t`）；该分隔符一次都不出现而另一种出现时 MUST 用另一种（模型常把 TSV 标成 csv）。
- **FR-005** 超过 200 行 MUST 只渲染前 200 行，并在表格上方显示**可见**的截断标注（含总行数）。
- **FR-006** 表格 MUST 横向可滚动（MUST NOT 被消息列的 `overflow-x: hidden` 裁掉）。
- **FR-007** 解析不出表格时 MUST 降级显示源码，「渲染」按钮 MUST 可见地报告失败。
- **FR-008** 单元格内容 MUST 以文本方式写入（MUST NOT 解析为 HTML）→ 天然防 XSS。
- **FR-009** 新增用户可见文案 MUST 双语（zh / en）；围栏语言标签 MUST 显示 `CSV` / `TSV`。
- **FR-010** MUST NOT 新增 npm 依赖、MUST NOT 改动 Kotlin 与桥接协议、MUST NOT 改动现有 Markdown 管道表的行为。

## Decisions（用户已拍板）

| # | 问题 | 结论 |
|---|---|---|
| Q1 | 格式范围 | **CSV + TSV**（JSON / YAML / XML 不做） |
| Q2 | 触发方式 | **只认 ` ``csv ` / ` ``tsv ` 围栏**（裸 CSV 不自动嗅探） |
| Q3 | 大块数据 | **超 200 行截断渲染 + 标注**（不降级为源码） |
| Q4 | 列数上限 | 实现侧护栏：列上限 50（200 行 × 500 列 = 10 万单元格会拖死面板）；超出截断并在标注里说明 |
| Q5 | 立项方式 | GitHub issue #3 作需求单（中英双语）；本地编号沿用 `specs/050` |

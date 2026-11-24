# 050 CSV / TSV 表格渲染 — 技术方案（plan）

> spec：[./spec.md](./spec.md)（Draft，Q1–Q5 已拍板）；需求单：https://github.com/57ggfk/pi-agent-idea/issues/3
> 编号：本文 task 用 **T501+**。分支 `release/0.5.10`。

## 0. 取证结论 → 方案映射

| 取证（读码核实） | 方案决定 |
|---|---|
| `RENDERABLE_LANGS` 只有 svg / mermaid（Markdown.tsx:245） | 加 csv / tsv → 自动获得 049 的「渲染 ⇄ 源码」切换与 048 的标题栏，不另造交互 |
| `applyBlockViewMode` 是唯一模式分发点 | 在分发里加第三个分支 `renderDelimitedTable(code)`（**同步**，与 svg 同构） |
| `renderSvgFence` 同步：`pre` 前插 `<div class="svg-figure">` + 隐藏 `code` | CSV 照抄这个形状：插 `<div class="csv-table-wrap">` + 隐藏 `code`；无异步 → 无 mermaid 那个"并发 null 请求拆掉图形"的老账 |
| `.markdown table`（:386）已有弱边框 + `thead th` 灰底 | **零重复样式**：CSV 表格就在 `.markdown` 内，`.markdown table` / `th` / `td` / `thead th` 规则天然命中；新样式只需滚动容器与截断标注两条 |
| `.markdown table` 没有横向滚动容器；消息列 `overflow-x: hidden`（:2404） | 新增 `.csv-table-wrap { overflow-x: auto }`；**不动** `.markdown table`（018 US4 的管道表保持原样，超宽管道表被裁是既有非目标） |
| `LANG_LABELS`（:262 附近）无 csv / tsv | 补 `csv: "CSV"` / `tsv: "TSV"`（格式名不翻译） |
| i18n 在 `web/src/i18n/locales/{zh,en}.ts` | 新增 `markdown.tableRowsTruncated` / `markdown.tableColsTruncated`（参数：total / shown） |
| mock 的 `mdKnob` 六场景（mock.ts:2512 起） | 新增 `csv` 场景供 e2e |
| 全仓无 CSV 实现；049 已定「不新增依赖」 | 手写 `web/src/lib/dsvTable.ts` 纯函数解析器，不引 papaparse |
| React 每帧重建 `.markdown` 的 innerHTML | 表格 DOM 必然随每个 delta 重建（与 mermaid / svg 同构）；不额外优化，真机卡顿另立规格 |

## 1. 架构

```
web/src/lib/dsvTable.ts（新，纯函数，无 DOM）
  ├─ parseDelimited(src, lang: "csv" | "tsv") → DelimitedTable | null
  │     · RFC4180 引号解析（字段内分隔符 / 换行、"" 转义）
  │     · 分隔符嗅探（按围栏语言取默认；默认分隔符一次都不出现而另一种出现 → 用另一种）
  │     · 行上限 MAX_ROWS = 200、列上限 MAX_COLS = 50；短行补空、长行截列
  │     · 返回 { header, rows, totalRows, totalCols, truncatedRows, truncatedCols }
  └─ 无有效行 / 只有一行且无分隔符 → null（判为「不是表格」）

web/src/components/Markdown.tsx（改）
  ├─ RENDERABLE_LANGS 加 "csv" / "tsv"
  ├─ applyBlockViewMode 分发加第三分支 → renderDelimitedTable(code)
  ├─ renderDelimitedTable(code)
  │     解析成功 → pre 前插 <div class="csv-table-wrap">，内含 <table>（表头进 thead）
  │                + 截断标注 <div class="csv-table-note">，隐藏 code，返回 true
  │     解析失败 → 返回 false（049 的现成机制降级回源码，「渲染」按钮闪 ✗）
  └─ LANG_LABELS 加 csv / tsv

web/src/styles.css（改，仅两条新规则）
  ├─ .csv-table-wrap { overflow-x: auto; max-width: 100%; }   ← 宽表横向滚动
  └─ .csv-table-note { 字号小一号、灰字 }                     ← 截断标注
     （表格本体复用 .markdown table / th / td / thead th 的既有样式，不重复定义）

web/src/i18n/locales/zh.ts + en.ts（改）：markdown.tableRowsTruncated / markdown.tableColsTruncated
web/src/bridge/mock.ts（改）：mdKnob === "csv" / "csv-big" / "csv-wide" 三个场景
                               （csv = 引号/逗号/换行/标签错配/非表格；csv-big = 205 行；csv-wide = 30 列与 60 列）
web/src/lib/dsvTable.test.ts（新）：解析器单测
web/e2e/markdown-table.spec.ts（新）：e2e（US1–US7）
```

## 2. 关键实现约定

- **单元格只走 textContent**：表格用 `document.createElement` 逐格写入，**不拼 HTML 字符串** → 天然防 XSS（FR-008）。
- **表格不进 DOMPurify 之外的通道**：本表由我们自己创建（不是 marked 产出的 HTML），不经过 `dangerouslySetInnerHTML`，与 040 的"单一净化入口"不冲突。
- **截断标注的位置**：在 `<table>` **上方**（读表的人第一眼就能看到"下面不是全部数据"），文案随 i18n。
- **流式期行为**：源码逐字增长 → 表格随每一帧重建（与 mermaid / svg 同构）；流式结束后即为最终表格。**不做**增量 DOM patch。
- **语言标签**：`CSV` / `TSV` 是格式名，不进 i18n 字典（与 `LANG_LABELS` 里 `json` / `yaml` 等格式名的既有做法一致）。

## 3. 触及文件一览

| 文件 | 动作 |
|---|---|
| `web/src/lib/dsvTable.ts` | 新增（解析器） |
| `web/src/lib/dsvTable.test.ts` | 新增（单测） |
| `web/src/components/Markdown.tsx` | 改（RENDERABLE_LANGS / 分发 / renderDelimitedTable / LANG_LABELS） |
| `web/src/styles.css` | 改（两条新规则） |
| `web/src/locales/zh.ts`、`web/src/locales/en.ts` | 改（一条文案） |
| `web/src/bridge/mock.ts` | 改（csv 场景） |
| `web/e2e/markdown-table.spec.ts` | 新增（e2e） |
| `changelog.d/050-csv-table.added.md` | 新增（发布文案碎片） |
| `specs/README.md` | 改（补 050 行） |

**Kotlin 侧不动、桥接协议不动、`web/package.json` 不动。**

## 4. 实施顺序

1. **Phase 1 解析器**（纯函数，先 RED 后 GREEN）→ 无 DOM 依赖，可独立验证。
2. **Phase 2 渲染接入**（Markdown.tsx + styles.css + i18n + mock）→ e2e 可断言。
3. **Phase 3 回归与验收**（全量基线 + 真机 + changelog + README）。

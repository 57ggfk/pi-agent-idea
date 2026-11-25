# 050 tasks（T501+）

> 完成判据：每个 task 自带「— 验证：…」；**无断言覆盖不得勾选**。
> 需求单：https://github.com/57ggfk/pi-agent-idea/issues/3　spec：[./spec.md](./spec.md)　plan：[./plan.md](./plan.md)

## Phase 1 解析器（纯函数，先 RED 后 GREEN）

^- [x] **T501** `web/src/lib/dsvTable.ts`：`parseDelimited(src, lang)` —— RFC4180 引号解析（字段内分隔符 / 换行、`""` 转义）、分隔符嗅探（按围栏语言取默认；默认分隔符缺失而另一种存在 → 用另一种）、空行跳过
  — 验证：`dsvTable.test.ts` 单测覆盖「引号内含逗号」「引号内含换行」「`""` 转义」「空行跳过」「分隔符兜底（标 csv 实为 tsv）」
^- [x] **T502** 行列截断：`MAX_ROWS = 200`、`MAX_COLS = 50`；短行补空单元格、长行截掉多余列；返回 `totalRows` / `totalCols` / `truncatedRows` / `truncatedCols`
  — 验证：单测断言 300 行 → `rows.length === 200` 且 `totalRows === 300` 且 `truncatedRows === true`；60 列 → 50 列且 `truncatedCols === true`
^- [x] **T503** 无效输入判定：没有有效行 / 只有一行且无分隔符 → 返回 `null`（判为不是表格）
  — 验证：单测三组样本均断言 `null`

## Phase 2 渲染接入

^- [x] **T504** `Markdown.tsx`：`RENDERABLE_LANGS` 加 csv / tsv；`applyBlockViewMode` 的分发加 `renderDelimitedTable`；该函数在 `pre` 前插 `.csv-table-wrap` + `<table>`（表头进 `thead`）、截断标注 `.csv-table-note`、隐藏 `code`；解析失败返回 `false`
  — 验证：e2e 断言 `thead th` 数量 = 表头列数、`tbody td` 文本与原文逐字一致、`code` 不可见；解析失败块显示源码
^- [x] **T505** `styles.css`：仅新增 `.csv-table-wrap { overflow-x: auto; max-width: 100% }` 与 `.csv-table-note`（表格本体复用 `.markdown table` 既有弱边框与表头灰底，**不重复定义**、**不动管道表**）
  — 验证：e2e 断言 30 列表格容器 `scrollWidth > clientWidth`；断言 `thead th` 的背景色 = `--table-head-bg`（与既有 table-borders 回归同口径）
^- [x] **T506** i18n：`markdown.tableRowsTruncated` / `markdown.tableColsTruncated`（zh / en，参数 total 与 shown）+ `LANG_LABELS` 加 `csv` / `tsv`
  — 验证：e2e 断言中文界面出现「已截断：共 300 行，仅显示前 200 行」、英文界面出现对应英文；断言标题栏语言标签为 `CSV` / `TSV`
^- [x] **T507** mock 新增 `?md=csv` / `?md=csv-big` / `?md=csv-wide` 三个场景：>200 行的大表样本 + 含引号 / 逗号 / 换行的样本 + 宽表与 60 列样本（拆三个是因为 mock 逐行流式，205 行混在一起会让每条 e2e 白等 8 秒）
  — 验证：`mock.test.ts` 断言该场景返回预期文本；e2e 用它做断言

## Phase 3 回归与验收

^- [x] **T508** e2e `web/e2e/markdown-table.spec.ts`：US1–US7 七条（CSV 渲染 / TSV / 源码切换 / 截断标注 / 横向滚动 / 失败降级 / 零回归）
  — 验证：`npx playwright test e2e/markdown-table.spec.ts` 全绿
^- [x] **T509** 全量基线：`npm run typecheck` 0 错、`npx vitest run` 全绿、`npx playwright test` 全量全绿、`./gradlew test` 绿、`./gradlew buildPlugin` 成功
  — 验证：逐条记录数字（用例数 / 耗时）
^- [x] **T510** 真机复验（WebStorm 2026.2.1）：装新包 → 面板内注入 csv / tsv 块 → 截图取证（表格渲染、截断标注、源码切换、宽表滚动）
  — 验证：截图存 `specs/050-csv-tsv-table/evidence/`，路径写进本文件
^- [x] **T511** 发布素材：`changelog.d/050-csv-table.added.md`（正好两行、中英）+ `specs/README.md` 补 050 行
  — 验证：本地跑 CI 同款碎片校验（文件名 / 正好两行 / 第 1 行含中文、第 2 行不含中文）→ 0 问题

## 验证记录（2026-11-24）

| 项 | 结果 |
|---|---|
| `npm run typecheck` | 0 错 |
| `npx vitest run` | 40 文件 / **537** 用例全绿（新增 dsvTable 12 条 + mock 场景 1 条） |
| `npx playwright test e2e/markdown-table.spec.ts` | **11** 条全绿（US1–US7） |
| `npx playwright test`（全量基线） | **467** 条全绿（26.7m；既有 456 + 新增 11） |
| `./gradlew test` | BUILD SUCCESSFUL（3m59s） |
| `./gradlew buildPlugin` | BUILD SUCCESSFUL（3m3s）；zip `pi-agent-idea-0.5.9.zip` 5,670,002 bytes @ 23:25:27 |
| changelog 碎片校验（CI 同款） | 67 个碎片 **0 问题** |
| 真机 WebStorm 2026.2.1 | 通过（下表） |

### 真机证据（WebStorm 2026.2.1，暗色主题，面板宽 594px 可视区）

装新包（主 jar 3,299,409 bytes @ 23:25:26）→ CDP 注入 `window.__piStore.setState` 走真实渲染管线：

- **CSV 渲染**：表头 `name/role/note` 进 `thead`（灰底），行 `Alice|dev|likes, commas`、`Bob|ops|says "hi"` —— 引号里的逗号是内容、`""` 是一个引号，逐字一致；`code` 隐藏，标题栏语言标签 `CSV`。
  → [01-csv-table-and-truncation-note.png](./evidence/01-csv-table-and-truncation-note.png)
- **TSV 渲染**：`name|age` 表头 + `Alice|31`，语言标签 `TSV`。
- **大表截断**：205 行 → 渲染 200 行，表格上方标注 `Truncated: 205 rows in total, showing the first 200`。
  → [01-csv-table-and-truncation-note.png](./evidence/01-csv-table-and-truncation-note.png)
- **宽表横向滚动**：30 列表格 `scrollWidth 1734 > clientWidth 594`，滚到 `scrollLeft 900` 后露出 col17–col26，滚动条随之移动。
  → [04-wide-table-scrolled.png](./evidence/04-wide-table-scrolled.png)
- **解析失败降级**：`just one line of prose` 的 `csv` 块无表格，显示源码 + 行号。
  → [02-wide-table-and-fallback.png](./evidence/02-wide-table-and-fallback.png)
- **切回源码**：点「Source」→ 表格收起、原始 CSV 显示（`Alice,dev,"likes, commas"` 逐字不变）、行号回来、按钮高亮、换行开关恢复可用；其余块不受影响。
  → [03-source-mode-toggle.png](./evidence/03-source-mode-toggle.png)

### 过程中修掉的一个真缺陷

首版渲染后表格底下留了一条 **16px 的空 pre 死白**（实测：表格底 310、空 pre 底 326，shell 高 130.8）—— 表格在 `pre` **之外**（自带横向滚动容器），`pre` 里只剩被隐藏的源码，它的上下内边距就露了出来。改法：渲染成功时把空 `pre` 一并收起（`pre.style.display = "none"`），源码模式再放回来；e2e 加了 `preVisible` 断言（渲染态 false / 源码态 true）。修完 shell 高 130.8 → 114.8，正好少 16px。

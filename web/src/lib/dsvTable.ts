/**
 * 050: CSV / TSV 解析器（纯函数，无 DOM、无依赖）。
 *
 * 为什么手写而不引 papaparse：049 已定「不新增依赖」，且这里要的能力很窄 ——
 * RFC4180 的引号规则 + 分隔符嗅探 + 行列上限。引一个完整库反而要把它的边界
 * 也一起继承。
 *
 * 两条硬约束：
 *   1. **分隔符**：按围栏语言取默认（csv → ","、tsv → "\t"）；默认分隔符在原文里
 *      一次都不出现、而另一种出现时，改用另一种 —— 模型经常把 TSV 标成 csv。
 *   2. **列数以表头为准**（FR-003）：短行补空单元格，长行截掉多余列。
 *
 * 截断（FR-005）：行上限 `MAX_ROWS`、列上限 `MAX_COLS`。两者都在这里落地，
 * 渲染层只负责把「被截断了」这件事如实告诉用户。
 */

/** 渲染的最大数据行数（不含表头）。 */
export const MAX_ROWS = 200;

/** 渲染的最大列数。200 行 × 500 列 = 10 万单元格会把面板拖死。 */
export const MAX_COLS = 50;

export interface DelimitedTable {
  /** 表头（已按渲染宽度截断）。 */
  header: string[];
  /** 数据行（已按渲染宽度补齐/截断，且不超过 MAX_ROWS 行）。 */
  rows: string[][];
  /** 数据行总数（截断前）。 */
  totalRows: number;
  /** 列总数（截断前，表头与所有数据行里的最大值）。 */
  totalCols: number;
  /** 行是否因 MAX_ROWS 被截断。 */
  truncatedRows: boolean;
  /** 列是否因 MAX_COLS 被截断。 */
  truncatedCols: boolean;
}

/** 围栏语言 → 默认分隔符。 */
const DEFAULT_DELIMITER: Record<string, string> = { csv: ",", tsv: "\t" };

/** 围栏语言 → 备用分隔符（默认的那个一次都没出现时启用）。 */
const ALT_DELIMITER: Record<string, string> = { csv: "\t", tsv: "," };

/**
 * RFC4180 状态机：切记录与字段。引号内的分隔符与换行是**字段内容**，
 * `""` 表示一个字面引号。引号只在字段开头才生效（其余位置的引号按普通字符处理）。
 */
function scan(src: string, delim: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch !== '"') {
        field += ch;
        continue;
      }
      if (src[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = false;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      continue;
    }
    if (ch === delim) {
      record.push(field);
      field = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      field = "";
      records.push(record);
      record = [];
      continue;
    }
    field += ch;
  }
  // 末行没有换行时也要成一条记录。
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

/**
 * 选分隔符：默认优先；默认的一次都没出现而另一种出现时用另一种。
 * 两个都没有 → 返回 null（这份内容根本不是分隔符数据）。
 */
function pickDelimiter(src: string, lang: string): string | null {
  const primary = DEFAULT_DELIMITER[lang] ?? ",";
  const alt = ALT_DELIMITER[lang] ?? "\t";
  if (src.includes(primary)) return primary;
  if (src.includes(alt)) return alt;
  return null;
}

/**
 * 解析一份 CSV / TSV。
 *
 * 返回 null 表示「这不是一张表」：没有分隔符、只有表头、或者表头只有一列 ——
 * 这三种都应当降级显示源码，而不是给用户一张空表。
 */
export function parseDelimited(src: string, lang: string): DelimitedTable | null {
  const delim = pickDelimiter(src, lang);
  if (!delim) return null;

  // 整行全空白的记录不是数据（模型输出常在分隔符数据前后留空行）。
  const records = scan(src, delim).filter((r) => r.some((c) => c.trim() !== ""));
  if (records.length < 2) return null;

  const header = records[0];
  const width = header.length;
  if (width < 2) return null;

  const dataRecords = records.slice(1);
  let totalCols = width;
  for (const r of dataRecords) {
    if (r.length > totalCols) totalCols = r.length;
  }

  const renderWidth = Math.min(width, MAX_COLS);
  const rows = dataRecords.slice(0, MAX_ROWS).map((r) => {
    const out = r.slice(0, renderWidth);
    while (out.length < renderWidth) out.push("");
    return out;
  });

  return {
    header: header.slice(0, renderWidth),
    rows,
    totalRows: dataRecords.length,
    totalCols,
    truncatedRows: dataRecords.length > MAX_ROWS,
    truncatedCols: totalCols > MAX_COLS,
  };
}

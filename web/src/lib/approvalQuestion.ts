/**
 * 把「编号选项」型提问拆成可点选的条目。
 *
 * pi 的 RPC 协议只有 confirm/select/input/editor 四种对话框，没有多选：像
 * `rpiv-ask-user-question` 这类扩展在 IDE 里只能退化成 `ui.input`，把选项编号
 * 连同说明整段塞进标题，再让用户手打 "1,3"。这里把标题里的
 * `N. 标签 — 说明` 行识别出来交给界面渲染成条目，正文只留问题与说明；
 * 点选后仍然以纯文本（`1,3; 自定义`）回给扩展——不改扩展、不猜它的协议。
 *
 * 只有「从 1 开始连续、至少两条」才算选项，避免把普通步骤列表当成选项。
 */

export interface NumberedOption {
  /** 1 起的编号，也就是扩展期待用户输入的那个数字。 */
  n: number;
  label: string;
  /** `—` 之后的说明，可能没有。 */
  desc?: string;
}

const OPTION_LINE = /^\s*(\d+)\.\s+(.+?)\s*$/;
const DESC_SEPARATOR = " — ";

function toOption(n: number, body: string): NumberedOption {
  const at = body.indexOf(DESC_SEPARATOR);
  return at >= 0
    ? { n, label: body.slice(0, at), desc: body.slice(at + DESC_SEPARATOR.length) }
    : { n, label: body };
}

/**
 * Splits a dialog title into the question part and its numbered options.
 * When fewer than two consecutive options are found the title is returned
 * untouched and `options` is empty — the caller then renders a plain field.
 */
export function splitQuestion(title: string): { question: string; options: NumberedOption[] } {
  const options: NumberedOption[] = [];
  const kept: string[] = [];
  for (const line of title.split(/\r?\n/)) {
    const m = OPTION_LINE.exec(line);
    if (m && Number(m[1]) === options.length + 1) {
      options.push(toOption(options.length + 1, m[2]));
      continue;
    }
    kept.push(line);
  }
  if (options.length < 2) return { question: title, options: [] };
  // 选项行被抽走后会留下成片空行，收成一段再 trim。
  const question = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { question: question.length > 0 ? question : title, options };
}

/**
 * Option numbers already present in the field. Reads only the part before `;`
 * (the custom-text half), and tolerates `,`/`，`/spaces and a trailing dot.
 */
export function selectedNumbers(text: string): number[] {
  const selection = text.split(";")[0] ?? "";
  return selection
    .split(/[,，\s]+/)
    .map((token) => token.replace(/\.$/, ""))
    .filter((token) => /^\d+$/.test(token))
    .map(Number);
}

/**
 * Toggles option `n` in the field text, rebuilding it as `1,3[; 自定义]`.
 * The custom half is preserved verbatim (joined back if it contained `;`).
 */
export function toggleOptionNumber(text: string, n: number): string {
  const at = text.indexOf(";");
  const custom = at >= 0 ? text.slice(at + 1).trim() : "";
  const current = Array.from(new Set(selectedNumbers(text))).sort((a, b) => a - b);
  const next = current.includes(n)
    ? current.filter((x) => x !== n)
    : [...current, n].sort((a, b) => a - b);
  const head = next.join(",");
  if (head.length === 0) return custom;
  return custom.length > 0 ? `${head}; ${custom}` : head;
}

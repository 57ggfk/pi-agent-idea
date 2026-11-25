import markedKatex from "marked-katex-extension";
import type { MarkedExtension, TokenizerExtension, Tokens } from "marked";

/**
 * 040 修订：上游 marked-katex-extension 的行内规则要求闭合的 `$` 之后必须跟
 * 空白或 `?!.,:？！。，：` 才算公式。实测 22 种常见尾随字符里有 10 种会让公式
 * **静默不渲染**（原样显示成 `$…$`）：`;` `)` `、` `」` `”` `；` `/` `+` `=`
 * —— 真实模型输出里「因此 $E=mc^2$；」「（如 $E=mc^2$）」这类写法并不罕见。
 *
 * 040 修订（第二次）：上游还有一条**对称**的位置约束 —— 开头的 `$` 必须在**行首或空格
 * 之后**。用户报的现象「素数定理：$\pi(x)\sim\frac{x}{\ln x}$ 整段不渲染」
 * 正是它：开 `$` 前面是全角冒号 `：`，不是空格 → 公式连匹配都没进，KaTeX
 * 从未被调用（实测 KaTeX 本身能正常渲染这个表达式，坏的是**匹配**，不是
 * 渲染）。040 留下的尾随白名单同样漏了 `》` `〉` `］` `｝` 等闭合符号 →
 * `《$E=mc^2$》` 也不渲染。
 *
 * 第二次修订把两条位置约束统一成一句话：**`$` 不能挨着「词字符」**（字母 / 数字 /
 * 组合记号，任何文字系统）。于是：
 *   - 前面是行首、空白或标点/符号 → 可以是公式开头（`素数定理：$…$` ✓）；
 *   - 后面是结尾、空白或标点/符号 → 可以是公式结尾（`《…$…$》` ✓）；
 *   - 挨着字母/数字 → **仍然不是**公式：`变量$x$` ✗、`售价$5$` ✗、
 *     `价格 $5 到 $10` ✗ —— 货币误判的防线原样保留（040 的单测也还在）。
 *
 * 公式**体**里也不允许再出现裸 `$`（`\$` 转义仍允许）。真机探针发现：
 * `价格 $5 到 $10 变量$x$` 这种句子会被当成**一整段**公式吞掉 —— 公式体跨过了
 * 中间那个 `$`，于是 KaTeX 报错、整段变红字。正文里含裸 `$` 本来就不是合法
 * LaTeX，所以直接不让裸 `$` 成为公式体的一部分。
 *
 * 两条上游防货币误判的约束因此都还在，只是从「写死的空格 + 标点清单」换成了
 * 「词字符边界」这一条更完整的规则。
 *
 * 实现方式仍是**替换**上游 inline 扩展的 start/tokenizer（只改匹配规则），
 * 保留它自己的 renderer（katex.renderToString + 同样的 options）：不另写一套
 * 渲染路径，也不引入第二个 inline 扩展去和 marked 抢优先级。
 */

/**
 * 词字符：字母、数字、组合记号（任何文字系统）。
 * `$` 挨着它就不是公式 —— 这是货币误判的防线。
 */
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

/**
 * 行内规则：与上游同构的内容部分，尾随条件从「写死的标点清单」换成
 * 「结尾，或任何非词字符（标点 / 符号 / 空白）」。
 * `$` 本身排除在外 —— 否则 `$x$$` 会被拆成「公式 x」+「一个多余的 $」。
 */
const EXTENDED_INLINE_RULE =
  /^(\${1,2})(?!\$)((?:\\.|[^\\\n$])*?(?:\\.|[^\\\n$]))\1(?=$|[^\p{L}\p{N}\p{M}$])/u;

/**
 * 开头的 `$` 能不能算公式开头：行首、空白之后，或**标点/符号之后**。
 * 挨着词字符（字母/数字）一律不行 —— 这是 040 起就在的货币误判防线。
 */
function openingBoundaryOk(prev: string | undefined): boolean {
  if (prev === undefined) return true; // 行首
  if (prev === "$") return false; // `$$` 的第二个 `$`：交给规则本身判断
  if (/\s/u.test(prev)) return true; // 空白之后
  return !WORD_CHAR.test(prev); // 标点 / 符号之后
}

/** 与上游一致的「起始位置」扫描：只在合法的 `$` 上尝试匹配。 */
function extendedStart(src: string): number | undefined {
  let index: number;
  let indexSrc = src;
  while (indexSrc) {
    index = indexSrc.indexOf("$");
    if (index === -1) return undefined;
    const prev = index === 0 ? undefined : indexSrc.charAt(index - 1);
    if (openingBoundaryOk(prev)) {
      const possibleKatex = indexSrc.substring(index);
      if (possibleKatex.match(EXTENDED_INLINE_RULE)) return index;
    }
    indexSrc = indexSrc.substring(index + 1).replace(/^\$+/, "");
  }
  return undefined;
}

/** 与上游一致的 token 形状 —— renderer 认这个结构。 */
function extendedTokenizer(src: string): Tokens.Generic | undefined {
  const match = src.match(EXTENDED_INLINE_RULE);
  if (!match) return undefined;
  return {
    type: "inlineKatex",
    raw: match[0],
    text: match[2].trim(),
    displayMode: match[1].length === 2,
  } as unknown as Tokens.Generic;
}

/**
 * marked-katex-extension，但行内公式两侧不再要求「行首/空格」和「写死的
 * 标点清单」—— 只要 `$` 不挨着词字符就算公式（040 的两次修订）。
 * 块级公式（`$$\n…\n$$`）与上游行为一致。
 */
export function markedKatexExtended(
  options: Parameters<typeof markedKatex>[0] = {},
): MarkedExtension {
  const ext = markedKatex(options) as MarkedExtension;
  const inline = (ext.extensions ?? []).find((e) => e.name === "inlineKatex");
  if (!inline) {
    // Upstream changed its extension names — fail loudly rather than silently
    // falling back to the strict rule this module exists to relax.
    throw new Error("marked-katex-extension: inlineKatex extension not found");
  }
  const target = inline as TokenizerExtension;
  target.start = extendedStart;
  target.tokenizer = extendedTokenizer;
  return ext;
}

/** Exported for the unit tests: does the relaxed rule match this source? */
export function matchesExtendedInline(src: string): boolean {
  return EXTENDED_INLINE_RULE.test(src);
}

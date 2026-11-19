import markedKatex from "marked-katex-extension";
import type { MarkedExtension, TokenizerExtension, Tokens } from "marked";

/**
 * 040 修订：上游 marked-katex-extension 的行内规则要求闭合的 `$` 之后必须跟
 * 空白或 `?!.,:？！。，：` 才算公式。实测 22 种常见尾随字符里有 10 种会让公式
 * **静默不渲染**（原样显示成 `$…$`）：`;` `;` `)` `(` `、` `」` `”` `；` `/` `+` `=`
 * —— 真实模型输出里「因此 $E=mc^2$；」「（如 $E=mc^2$）」这类写法并不罕见。
 *
 * 这里**只**放宽「闭合 `$` 之后的尾随字符」，上游两条防货币误判的约束原样保留：
 *   1. 开头的 `$` 必须在行首或空格之后；
 *   2. 闭合的 `$` 之后必须跟空白/标点（而不是任意字符）。
 * 所以 `价格 $5 到 $10` 仍不会被当成公式 —— 它的闭合 `$` 后面跟的是数字 `1`。
 *
 * 实现方式是**替换**上游 inline 扩展的 start/tokenizer（只改匹配规则），
 * 保留它自己的 renderer（katex.renderToString + 同样的 options）：不另写一套
 * 渲染路径，也不引入第二个 inline 扩展去和 marked 抢优先级。
 */

/** 闭合 `$` 之后允许出现的尾随字符（上游集合 + 本次放宽的部分）。 */
const EXTENDED_INLINE_RULE =
  /^(\${1,2})(?!\$)((?:\\.|[^\\\n])*?(?:\\.|[^\\\n\$]))\1(?=[\s?!\.,:？！。，：;；)）\]】、」』”’/+=(]|$)/;

/** 与上游一致的「起始位置」扫描：只在行首或空格后的 `$` 上尝试匹配。 */
function extendedStart(src: string): number | undefined {
  let index: number;
  let indexSrc = src;
  while (indexSrc) {
    index = indexSrc.indexOf("$");
    if (index === -1) return undefined;
    const eligible = index === 0 || indexSrc.charAt(index - 1) === " ";
    if (eligible) {
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
 * marked-katex-extension，但行内公式的闭合 `$` 之后允许更多尾随字符。
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

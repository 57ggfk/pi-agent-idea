/**
 * 038 footnote robustness (real-machine finding, 0.5.10 probe r1): models
 * often write the `[^id]:` definition on the line RIGHT AFTER the sentence
 * referencing it. With `breaks: true` that keeps the definition inside the
 * same paragraph, where the GFM footnote block tokenizer can never see it —
 * the ref and the definition stay raw text (measured: blank-line separated
 * definitions render, single-newline ones do not).
 *
 * This pre-pass makes every definition line its own block: a blank line is
 * inserted before `[^…]:` when the previous line is not blank. Fenced code
 * blocks are left untouched, and the pass is a no-op for well-formed input.
 */
export function normalizeFootnoteDefs(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && /^\[\^[^\]\s]+\]:/.test(line) && out.length > 0 && out[out.length - 1].trim() !== "") {
      out.push("");
    }
    out.push(line);
  }
  return out.join("\n");
}

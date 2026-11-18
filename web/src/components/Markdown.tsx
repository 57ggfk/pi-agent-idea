import { useEffect, useMemo, useRef, type MouseEvent } from "react";
import { marked } from "marked";
import markedFootnote from "marked-footnote";
import markedKatex from "marked-katex-extension";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { getBridge } from "../bridge";
import { usePiStore } from "../store/store";
import { i18n } from "../i18n";
import { copyText } from "../lib/clipboard";
import { rasterizeElement } from "../lib/copyAsImage";
import { parseDiffHeaderPath } from "../lib/diffPaths";
import { normalizeFootnoteDefs } from "../lib/footnotePreprocess";
import { renderMermaid } from "../lib/mermaidRender";

marked.setOptions({ gfm: true, breaks: true });
// 038 US2: marked ^15 has no GFM footnote support of its own (measured:
// `[^1]` passes through as literal text). This extension is the sanctioned
// add — one dependency, marked >=7 peer, renders sup refs + a footnotes
// section with in-page anchors.
marked.use(markedFootnote());
// 040 FR-001: LaTeX math ($…$ inline, $$…$$ block — the AI-output standard).
// throwOnError:false renders invalid input as source text instead of throwing
// (US1 degrades gracefully); output still passes DOMPurify below (FR-002).
marked.use(markedKatex({ throwOnError: false }));

// Links must never navigate the SPA: the IDE (Kotlin) intercepts the click and
// opens the system browser; standalone the browser opens a new tab. The hook
// runs for every sanitize call, so it is registered exactly once at module load.
// Pure-hash links (footnote refs/backrefs, 038) are exempt: they must jump
// inside the page, and a target=_blank on them would pop a second window.
let hooksRegistered = false;
function registerPurifyHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      const href = node.getAttribute("href") ?? "";
      if (!href.startsWith("#")) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
        // 049 易用性：hover 即见目标，不然聊天里一个高亮词点出去才知道去哪。
        node.setAttribute("title", href);
      }
    }
  });
}

// Backticked tokens: any path-looking token with an extension (`src/App.tsx`,
// `README.md:12`, plus Windows/tilde forms `C:\src\App.tsx:12`, `~/notes/a.md`).
const INLINE_FILE_RE = /^((?:[A-Za-z]:[\\/])?(?:~[\\/])?[A-Za-z0-9._\-\\/]+\.[A-Za-z0-9]{1,10})(?::(\d{1,6}))?$/;
// Plain text runs: require at least one "/" (or a drive/tilde prefix) so prose
// like "e.g." or "3.14" is never linkified. Group 2 is the path, group 3 the
// optional :line suffix.
const TEXT_FILE_RE =
  /(^|[\s(])((?:(?:[A-Za-z]:[\\/]|~[\\/])(?:[A-Za-z0-9._\-]+[\\/])*|(?:[A-Za-z0-9._\-]+[\\/])+)[A-Za-z0-9._\-]+\.[A-Za-z0-9]{1,10})(?::(\d{1,6}))?/g;

function isLinkablePath(path: string): boolean {
  return path.length > 0 && !path.includes(" ") && !/^https?:/i.test(path);
}

function markFileLink(el: HTMLElement, path: string, line?: string) {
  el.classList.add("file-link");
  el.dataset.path = path;
  if (line) el.dataset.line = line;
}

/** Wraps path[:line] matches in plain text nodes with clickable spans. */
function linkifyTextNodes(root: ParentNode) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (!parent || parent.closest("pre, a, code, .file-link")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  // Collect first: replacing nodes while walking is unsafe.
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);

  for (const node of nodes) {
    const text = node.textContent ?? "";
    TEXT_FILE_RE.lastIndex = 0;
    if (!TEXT_FILE_RE.test(text)) continue;
    TEXT_FILE_RE.lastIndex = 0;

    const frag = document.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = TEXT_FILE_RE.exec(text)) !== null) {
      const [, sep, path, line] = m;
      const start = m.index + sep.length;
      if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));
      const span = document.createElement("span");
      markFileLink(span, path, line);
      span.textContent = m[0].slice(sep.length);
      frag.appendChild(span);
      last = start + path.length + (line ? line.length + 1 : 0);
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentElement?.replaceChild(frag, node);
  }
}

const COPY_FLASH_MS = 1200;

/**
 * 047 FR-001: a "copy as image" affordance on every graphic render block that
 * passed the probe (SVG / Mermaid figure / KaTeX display). The button hides
 * until the block is hovered; the click rasterizes the SANITIZED rendered DOM
 * (039/040 FR-002/003 — no second render path) and hands the PNG data URL to
 * the 012 `ide.copyImage` bridge (Q3 复核: the machine-verified channel — a
 * direct clipboard write cannot pass the focus check under CDP). ✗ flash on
 * failure — never a silent no-op (003). React rebuilds the HTML per streaming
 * delta, so the per-render injection is naturally idempotent (FR-007).
 */
function addImageCopyButtons(root: ParentNode) {
  const label = i18n.t("markdown.copyAsImage");
  const targets: Element[] = [];
  root.querySelectorAll(".markdown svg").forEach((el) => {
    if (el.closest(".copyable-frame") || el.closest("pre")) return;
    try {
      // A degraded (malformed) SVG paints nothing — no entry for it (FR-007).
      const bbox = (el as SVGGraphicsElement).getBBox();
      if (bbox.width === 0 || bbox.height === 0) return;
    } catch {
      // getBBox needs a rendered tree — wrap anyway and let the click report.
    }
    targets.push(el);
  });
  root.querySelectorAll(".katex-display").forEach((el) => {
    if (!el.closest(".copyable-frame")) targets.push(el);
  });
  for (const el of targets) wrapWithImageCopy(el, label);
}

/** Builds the shared 「复制为图片」 button. `getTarget` reads the graphic at
 * click time; failures flash ✗ and recover — never a silent no-op (003). */
function makeImageCopyButton(label: string, getTarget: () => Element | null) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "copy-image-btn";
  btn.dataset.testid = "copy-image-btn";
  btn.textContent = label;
  const recover = () => {
    setTimeout(() => {
      btn.textContent = i18n.t("markdown.copyAsImage");
    }, COPY_FLASH_MS);
  };
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    void (async () => {
      const target = getTarget();
      if (!target) throw new Error("the graphic has not rendered yet");
      const data = await rasterizeElement(target);
      const api = (await getBridge()) as unknown as {
        request: (m: string, p?: unknown) => Promise<{ ok: boolean; error?: string }>;
      };
      const res = await api.request("ide.copyImage", { data });
      if (!res.ok) throw new Error(res.error ?? "copy failed");
    })().then(
      () => {
        btn.textContent = "✓";
        recover();
      },
      () => {
        btn.textContent = "✗";
        recover();
      },
    );
  });
  return btn;
}

/** Wraps ONE rendered block with the hover copy-as-image button (047). */
function wrapWithImageCopy(el: Element, label: string) {
  if (el.closest(".copyable-frame")) return;
  const frame = document.createElement("span");
  frame.className = "copyable-frame";
  el.parentNode?.insertBefore(frame, el);
  frame.appendChild(el);
  frame.appendChild(makeImageCopyButton(label, () => frame.firstElementChild));
}

/**
 * 041 #9 (feedback batch): pi summarizes new/changed files as ```diff blocks
 * in the message text, and the path in the header lines was inert text —
 * the exact path users click to open the file in the IDE. Wrap the path in a
 * `.file-link` span (same channel as every other file link; the delegated
 * container click calls `ide.openFile`). Runs after hljs highlighting and
 * splits text nodes so the surrounding token markup survives; React rebuilds
 * the HTML on every streaming delta, so this is naturally re-applied.
 */
function linkifyDiffHeaders(code: HTMLElement) {
  // Idempotent: StrictMode (dev) double-invokes effects — a second pass over
  // already-wrapped text would nest .file-link spans inside each other.
  if (code.querySelector(".file-link")) return;
  const text = code.textContent ?? "";
  const ranges: { start: number; end: number; path: string }[] = [];
  for (const m of text.matchAll(/^(?:---|\+\+\+|diff --git)\s+([^\n]*)/gm)) {
    // parseDiffHeaderPath expects the FULL header line (marker included) —
    // feeding it m[1] (marker stripped) always returned null, which made the
    // whole linkify dead until the 047-window re-verification caught it.
    const path = parseDiffHeaderPath(m[0]);
    if (!path) continue;
    const idx = m[0].lastIndexOf(path);
    if (idx < 0) continue;
    const start = m.index + idx;
    ranges.push({ start, end: start + path.length, path });
  }
  for (const { start, end, path } of ranges) wrapTextRange(code, start, end, path);
}

/** Wraps [start, end) of `code`'s text content in a file-link span. */
function wrapTextRange(code: HTMLElement, start: number, end: number, path: string) {
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  let offset = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    const len = node.textContent?.length ?? 0;
    const s = start - offset;
    const e = end - offset;
    offset += len;
    if (s >= len || e <= 0) continue;
    const tail = s > 0 ? node.splitText(s) : node;
    if (e - s < (tail.textContent?.length ?? 0)) tail.splitText(e - s);
    const span = document.createElement("span");
    span.className = "file-link";
    span.dataset.path = path;
    tail.parentNode?.insertBefore(span, tail);
    span.appendChild(tail);
    return;
  }
}

/**
 * marked separates block-level elements with "\n" and ends the document with
 * one. `.item-body` renders `white-space: pre-wrap`, so those decorative
 * newlines became real empty line boxes — the visible reason a one-line user
 * message measured two lines tall (spec 010 T001 baseline). Strip them
 * everywhere outside `<pre>`, where a newline is content.
 */
function stripDecorativeNewlines(html: string): string {
  const parts = html.split(/(<pre[\s\S]*?<\/pre>)/gi);
  return parts
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/>\n+</g, "><").trim()))
    .join("");
}

/**
 * Adds the block action bar in the top-right corner of every fenced code
 * block: Copy + "open in IDE" (041 FR-001, side by side in one container so
 * they never overlap). The ✓/✗ feedback lives in `copiedUntil` (keyed by pre
 * index): React replaces the whole innerHTML on every streaming delta, so the
 * freshly injected button must restore the "✓" state itself until the flash
 * window expires. The IDE button reads `code.textContent` and the
 * `language-*` class at click time (041 US3: streaming, several blocks).
 */
function addCopyButtons(root: ParentNode, copiedUntil: Map<number, number>, openSnippet: (language: string, text: string) => Promise<boolean>) {
  const now = Date.now();
  const copyLabel = i18n.t("common.copy");
  const ideLabel = i18n.t("markdown.openInIde");
  for (const [idx, until] of copiedUntil) {
    if (until <= now) copiedUntil.delete(idx);
  }
  Array.from(root.querySelectorAll("pre")).forEach((pre, idx) => {
    if (pre.querySelector(".code-copy-btn")) return;
    const actions = document.createElement("div");
    actions.className = "code-actions";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy-btn";
    const remaining = (copiedUntil.get(idx) ?? 0) - now;
    btn.textContent = remaining > 0 ? "✓" : copyLabel;
    if (remaining > 0) {
      setTimeout(() => {
        btn.textContent = copyLabel;
      }, remaining + 20);
    }
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      copiedUntil.set(idx, Date.now() + COPY_FLASH_MS);
      // Read at click time: the block may still be streaming.
      const code = pre.querySelector("code")?.textContent ?? "";
      void copyText(code).then((ok) => {
        btn.textContent = ok ? "✓" : "✗";
        setTimeout(() => {
          btn.textContent = i18n.t("common.copy");
        }, COPY_FLASH_MS);
      });
    });
    const ideBtn = document.createElement("button");
    ideBtn.type = "button";
    ideBtn.className = "code-ide-btn";
    ideBtn.textContent = ideLabel;
    ideBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      // Read at click time: the block may still be streaming (041 US3).
      const code = pre.querySelector("code");
      const lang = /language-([\w+#-]+)/.exec(code?.className ?? "")?.[1] ?? "";
      void openSnippet(lang, code?.textContent ?? "").then((ok) => {
        if (ok) return;
        ideBtn.textContent = "✗";
        setTimeout(() => {
          ideBtn.textContent = i18n.t("markdown.openInIde");
        }, COPY_FLASH_MS);
      });
    });
    actions.appendChild(btn);
    actions.appendChild(ideBtn);
    pre.appendChild(actions);
  });
}

export default function Markdown({ text }: { text: string }) {
  registerPurifyHooks();
  const html = useMemo(
    () =>
      stripDecorativeNewlines(
        DOMPurify.sanitize(
          marked.parse(normalizeFootnoteDefs(text), { async: false }) as string,
          {
          // 039 FR-002 (explicit whitelist posture): inline SVG renders via
          // DOMPurify's default svg profile; these two are forbidden even if
          // a future DOMPurify default ever loosened them. Measured with
          // DOMPurify 3.x: script / on* / foreignObject / remote href were
          // already stripped — this pins the guarantee at our call site.
          FORBID_TAGS: ["script", "foreignObject"],
        }),
      ),
    [text],
  );
  const ref = useRef<HTMLDivElement>(null);
  const copiedUntil = useRef<Map<number, number>>(new Map());
  const openFile = usePiStore((s) => s.openFile);
  const openSnippet = usePiStore((s) => s.openSnippet);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll("pre code:not(.hljs)").forEach((el) => {
      hljs.highlightElement(el as HTMLElement);
    });
    addCopyButtons(root, copiedUntil.current, openSnippet);
    // Inline code tokens (`path.ts:12`) become clickable file links.
    root.querySelectorAll("code").forEach((el) => {
      if (el.closest("pre") || el.classList.contains("file-link")) return;
      const m = INLINE_FILE_RE.exec(el.textContent ?? "");
      if (!m || !isLinkablePath(m[1])) return;
      markFileLink(el, m[1], m[2]);
    });
    // Plain-text path references outside code blocks too.
    linkifyTextNodes(root);
    // 041 #9: ```diff block headers link their file path to ide.openFile.
    root.querySelectorAll("pre code.language-diff").forEach((el) => {
      linkifyDiffHeaders(el as HTMLElement);
    });
    // 047: 「复制为图片」 on the graphic render blocks.
    addImageCopyButtons(root);
    // 040 US2: mermaid blocks render to SVG in place; invalid source keeps
    // the code block (the degrade is the natural pre-render state).
    root.querySelectorAll("pre code.language-mermaid").forEach((el) => {
      const code = el as HTMLElement;
      const source = code.textContent ?? "";
      if (!source.trim() || code.dataset.mermaidDone === source) return;
      code.dataset.mermaidDone = source;
      void renderMermaid(source).then((svg) => {
        const pre = code.closest("pre");
        if (!pre || !pre.isConnected) return;
        // The rendered source must still be the block's CURRENT text: a late
        // resolution for an older streaming prefix must not paint its (wrong)
        // diagram over the grown block, nor heal a figure it does not own.
        const current = pre.querySelector("code.language-mermaid")?.textContent ?? "";
        if (current !== source) return;
        if (!svg) {
          // 047 找到的 040 流式遗留：a VALID streaming prefix rendered a
          // figure whose block later grew into a broken source — nothing
          // removed the stale figure, so the user saw a WRONG diagram with
          // the source hidden. The final (broken) render heals it: drop the
          // stale figure and show the source again (the action-bar button is
          // never appended for null renders, FR-007).
          const stale = pre.querySelector(".mermaid-figure");
          if (stale) {
            stale.remove();
            code.style.display = "";
          }
          return;
        }
        let fig = pre.querySelector<HTMLDivElement>(".mermaid-figure");
        if (!fig) {
          fig = document.createElement("div");
          fig.className = "mermaid-figure";
          pre.insertBefore(fig, code);
          code.style.display = "none";
        }
        fig.innerHTML = svg;
        // 047: the figure landed after the effect ran — ride its pre's shared
        // action bar (degraded blocks never get a figure, hence no entry).
        const actions = pre.querySelector(".code-actions");
        if (actions && !actions.querySelector(".copy-image-btn")) {
          actions.appendChild(makeImageCopyButton(i18n.t("markdown.copyAsImage"), () => fig.querySelector("svg")));
        }
      });
    });
  }, [html, openSnippet]);

  // One delegated handler covers links rendered via dangerouslySetInnerHTML.
  const onContainerClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const link = target.closest(".file-link");
    if (!(link instanceof HTMLElement)) return;
    const path = link.dataset.path;
    if (!path) return;
    e.preventDefault();
    void openFile(path, Number(link.dataset.line ?? "0"));
  };

  return (
    <div className="markdown" ref={ref} onClick={onContainerClick} dangerouslySetInnerHTML={{ __html: html }} />
  );
}

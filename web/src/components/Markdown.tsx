import { useEffect, useMemo, useRef, type MouseEvent } from "react";
import { marked } from "marked";
import markedFootnote from "marked-footnote";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { getBridge } from "../bridge";
import { usePiStore } from "../store/store";
import { i18n } from "../i18n";
import { copyText } from "../lib/clipboard";
import { rasterizeElement } from "../lib/copyAsImage";
import { parseDiffHeaderPath } from "../lib/diffPaths";
import { normalizeFootnoteDefs } from "../lib/footnotePreprocess";
import { markedKatexExtended } from "../lib/katexInline";
import { renderMermaid, mermaidBuiltInTheme } from "../lib/mermaidRender";

marked.setOptions({ gfm: true, breaks: true });
// 038 US2: marked ^15 has no GFM footnote support of its own (measured:
// `[^1]` passes through as literal text). This extension is the sanctioned
// add — one dependency, marked >=7 peer, renders sup refs + a footnotes
// section with in-page anchors.
marked.use(markedFootnote());
// 040 FR-001: LaTeX math ($…$ inline, $$…$$ block — the AI-output standard).
// throwOnError:false renders invalid input as source text instead of throwing
// (US1 degrades gracefully); output still passes DOMPurify below (FR-002).
// markedKatexExtended = upstream marked-katex-extension with ONE change: the
// closing `$` may be followed by more trailing characters (`;` `)` `、` `」`
// …), so a formula at the end of a clause actually renders. The currency
// guard is untouched — see lib/katexInline.ts.
marked.use(markedKatexExtended({ throwOnError: false }));

// Links must never navigate the SPA: the IDE (Kotlin) intercepts the click and
// opens the system browser; standalone the browser opens a new tab. The hook
// runs for every sanitize call, so it is registered exactly once at module load.
// Pure-hash links (footnote refs/backrefs, 038) are exempt: they must jump
// inside the page, and a target=_blank on them would pop a second window.
let hooksRegistered = false;
const SVG_NS = "http://www.w3.org/2000/svg";
function registerPurifyHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    // 039 修订（实测推翻旧结论）：DOMPurify 的默认 profile **不会**剥 SVG 里
    // 的远程 href / xlink:href —— 它的 ALLOWED_URI_REGEXP 放行 http/https
    // （它防 XSS，不防外链）。实测 `<svg><a xlink:href="http://evil.example">`
    // 原样留在 DOM 里，而插件的 linkHandler 会把点击交给系统浏览器 → 模型
    // 输出里的一个恶意 SVG 就能把用户带到任意外站。规格 039 写的「远程 href
    // 净化」此前只在纸面上成立，e2e 那条断言又因为选择器匹配不到命名空间
    // 属性而假绿（见 web/e2e/markdown-svg.spec.ts）。
    // 这里显式剥：SVG 命名空间下只允许纯片段引用（#id）。
    if (node.namespaceURI === SVG_NS) {
      for (const attr of ["href", "xlink:href"]) {
        const value = node.getAttribute(attr);
        if (value && !value.startsWith("#")) node.removeAttribute(attr);
      }
      return;
    }
    if (node.tagName === "A") {
      const href = node.getAttribute("href") ?? "";
      if (!href.startsWith("#")) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
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
  btn.className = "copy-image-btn block-action-btn";
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

/**
 * Wraps ONE rendered block with the hover copy-as-image button (047).
 *
 * The button lives in a `.block-actions` bar that sits **above the graphic and
 * outside it** — the graphic's own box stays clean (no pill painted over the
 * artwork), and the bar's transparent bottom padding bridges the gap so the
 * pointer can travel from the graphic up to the button without the button
 * disappearing on the way.
 */
function wrapWithImageCopy(el: Element, label: string) {
  if (el.closest(".copyable-frame")) return;
  const frame = document.createElement("span");
  frame.className = "copyable-frame";
  el.parentNode?.insertBefore(frame, el);
  frame.appendChild(el);
  const actions = document.createElement("span");
  actions.className = "block-actions";
  actions.appendChild(makeImageCopyButton(label, () => el));
  frame.insertBefore(actions, el);
  // A narrow graphic (an inline icon) cannot host the bar above itself: the
  // bar is WIDER than the graphic, so it would hang over the text on the line
  // above and hide it. Reserve a lane inside the frame for the bar instead —
  // the graphic keeps its place and nothing gets covered.
  requestAnimationFrame(() => {
    const barW = actions.offsetWidth;
    const frameW = frame.getBoundingClientRect().width;
    // A data attribute, not a class: the frame's class stays exactly
    // "copyable-frame" so existing selectors keep matching it.
    if (barW <= frameW + 8) return;
    frame.dataset.lane = "1";
    // The lane is exactly as tall as the bar (plus 2px of air), so the bar
    // sits fully ABOVE the graphic and never overlaps its top edge.
    frame.style.paddingTop = `${actions.offsetHeight + 2}px`;
    // Which way the bar may grow: the message column clips horizontally, so a
    // bar that grows past the column's edge loses its left (or right) end and
    // the button becomes unclickable. Grow towards the roomier side.
    const r = frame.getBoundingClientRect();
    let clip: Element | null = frame.parentElement;
    while (clip && getComputedStyle(clip).overflowX === "visible") clip = clip.parentElement;
    const cr = clip ? clip.getBoundingClientRect() : { left: 0, right: window.innerWidth };
    const spaceLeft = r.left - cr.left;
    const spaceRight = cr.right - r.right;
    frame.dataset.align = spaceLeft >= barW + 8 || spaceLeft >= spaceRight ? "right" : "left";
  });
  wireBlockActions(frame, actions);
}

/**
 * Last known pointer position.
 *
 * The browser's `:hover` state cannot be trusted right after React rebuilds
 * the DOM (every streaming delta replaces the whole innerHTML): the new
 * element reports no hover until the pointer moves again, so a hover-revealed
 * bar would blink out mid-stream. The pointer's coordinates are stable, so
 * the reveal is driven by them instead.
 */
let pointerAt: { x: number; y: number } | null = null;
let pointerBound = false;

function rememberPointer() {
  if (pointerBound) return;
  pointerBound = true;
  window.addEventListener(
    "mousemove",
    (e) => {
      pointerAt = { x: e.clientX, y: e.clientY };
    },
    { passive: true },
  );
}

/** Is the remembered pointer inside this element's box? */
function pointerInside(el: Element): boolean {
  if (!pointerAt) return false;
  const r = el.getBoundingClientRect();
  return pointerAt.x >= r.left && pointerAt.x <= r.right && pointerAt.y >= r.top && pointerAt.y <= r.bottom;
}

/**
 * Wires the hover behaviour of a block's action bar (041/047).
 *
 * The bar sits OUTSIDE the block (above its top-right corner), so the pointer
 * has to cross a gap on its way up — a plain `:hover` rule would hide the bar
 * the moment the pointer left the block, and the button could not be clicked.
 * Hence: show on hover, hide with a short delay, cancel the hide while the
 * pointer is on the bar (the same treatment the 044 hover preview needed).
 *
 * React rebuilds the whole innerHTML on every streaming delta, so the bar is
 * re-created too: the pointer may not have moved at all — re-check the
 * pointer's position after the rebuild, otherwise the buttons blink out
 * mid-stream.
 */
function wireBlockActions(block: HTMLElement, actions: HTMLElement) {
  rememberPointer();
  let hideTimer: number | null = null;
  const show = () => {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
    block.classList.add("is-actions-visible");
  };
  const hideSoon = () => {
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      hideTimer = null;
      block.classList.remove("is-actions-visible");
    }, 300);
  };
  block.addEventListener("mouseenter", show);
  block.addEventListener("mouseleave", hideSoon);
  actions.addEventListener("mouseenter", show);
  actions.addEventListener("mouseleave", hideSoon);
  requestAnimationFrame(() => {
    if (!pointerInside(block) && !pointerInside(actions)) return;
    show();
    // The bar was just rebuilt (React replaces the whole innerHTML on every
    // streaming delta): show it WITHOUT the fade, otherwise the buttons
    // flicker half-transparent while the reply is still streaming.
    actions.style.transition = "none";
    requestAnimationFrame(() => {
      actions.style.transition = "";
    });
  });
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
 * Adds the block action bar **above** every fenced code block: Copy + "open
 * in IDE" (041 FR-001, side by side in one container so they never overlap).
 *
 * The bar is a sibling of the `pre`, not a child: the code block scrolls
 * horizontally (`overflow-x: auto`), which would clip an absolutely
 * positioned bar reaching outside the block's box. The shell `.block-shell`
 * is the positioning context, so the bar can sit in the block's top-right
 * corner, OUTSIDE the block (the code text is no longer covered by a pill).
 *
 * The ✓/✗ feedback lives in `copiedUntil` (keyed by pre index): React
 * replaces the whole innerHTML on every streaming delta, so the freshly
 * injected button must restore the "✓" state itself until the flash window
 * expires. The IDE button reads `code.textContent` and the `language-*`
 * class at click time (041 US3: streaming, several blocks).
 */
function addCopyButtons(root: ParentNode, copiedUntil: Map<number, number>, openSnippet: (language: string, text: string) => Promise<boolean>) {
  const now = Date.now();
  const copyLabel = i18n.t("common.copy");
  const ideLabel = i18n.t("markdown.openInIde");
  for (const [idx, until] of copiedUntil) {
    if (until <= now) copiedUntil.delete(idx);
  }
  Array.from(root.querySelectorAll("pre")).forEach((pre, idx) => {
    const host = pre.parentElement;
    // Already wrapped (this effect ran twice on the same DOM).
    if (host?.classList.contains("block-shell") && host.querySelector(".code-copy-btn")) return;
    const shell = document.createElement("div");
    shell.className = "block-shell";
    host?.insertBefore(shell, pre);
    shell.appendChild(pre);
    const actions = document.createElement("div");
    actions.className = "block-actions";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy-btn block-action-btn";
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
    ideBtn.className = "code-ide-btn block-action-btn";
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
    shell.insertBefore(actions, pre);
    wireBlockActions(shell, actions);
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
          // DOMPurify 3.x: script / on* / foreignObject are already stripped —
          // this pins the guarantee at our call site.
          // 远程 href 不靠 DOMPurify（实测它放行 http/https），靠
          // registerPurifyHooks 里的 SVG 命名空间剥除。
          FORBID_TAGS: ["script", "foreignObject"],
        }),
      ),
    [text],
  );
  const ref = useRef<HTMLDivElement>(null);
  const copiedUntil = useRef<Map<number, number>>(new Map());
  const openFile = usePiStore((s) => s.openFile);
  const openSnippet = usePiStore((s) => s.openSnippet);
  // The panel theme drives the mermaid palette (2026-11-20): a diagram must
  // follow the bubble it is drawn in, not stay light in a dark IDE.
  const theme = usePiStore((s) => s.theme);

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
      // The theme is part of the marker: switching the panel theme must
      // re-render the diagram in the new palette.
      const marker = `${theme}#${source}`;
      if (!source.trim() || code.dataset.mermaidDone === marker) return;
      code.dataset.mermaidDone = marker;
      void renderMermaid(source, theme).then((svg) => {
        const pre = code.closest("pre");
        if (!pre || !pre.isConnected) return;
        // The rendered source must still be the block's CURRENT text: a late
        // resolution for an older streaming prefix must not paint its (wrong)
        // diagram over the grown block, nor heal a figure it does not own.
        const current = pre.querySelector("code.language-mermaid")?.textContent ?? "";
        if (current !== source) return;
        // Nor may a late render of the PREVIOUS theme paint over the new one:
        // a theme switch starts a second render, which then owns this block.
        if (code.dataset.mermaidDone !== marker) return;
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
        // Which mermaid theme the figure was drawn with — the diagram must
        // follow the panel, not stay a light-mode widget in a dark bubble.
        fig.dataset.mermaidTheme = mermaidBuiltInTheme() ?? "default";
        // 047: the figure landed after the effect ran — ride its pre's shared
        // action bar (degraded blocks never get a figure, hence no entry).
        const actions = pre.closest(".block-shell")?.querySelector(".block-actions");
        if (actions && !actions.querySelector(".copy-image-btn")) {
          actions.appendChild(makeImageCopyButton(i18n.t("markdown.copyAsImage"), () => fig.querySelector("svg")));
        }
      });
    });
  }, [html, openSnippet, theme]);

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

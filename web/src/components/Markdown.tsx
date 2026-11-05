import { useEffect, useMemo, useRef, type MouseEvent } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { usePiStore } from "../store/store";
import { copyText } from "../lib/clipboard";

marked.setOptions({ gfm: true, breaks: true });

// Links must never navigate the SPA: the IDE (Kotlin) intercepts the click and
// opens the system browser; standalone the browser opens a new tab. The hook
// runs for every sanitize call, so it is registered exactly once at module load.
let hooksRegistered = false;
function registerPurifyHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
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
 * Adds a Copy button in the top-right corner of every fenced code block.
 * The ✓ feedback lives in `copiedUntil` (keyed by pre index): React replaces
 * the whole innerHTML on every streaming delta, so the freshly injected button
 * must restore the "✓" state itself until the flash window expires.
 */
function addCopyButtons(root: ParentNode, copiedUntil: Map<number, number>) {
  const now = Date.now();
  for (const [idx, until] of copiedUntil) {
    if (until <= now) copiedUntil.delete(idx);
  }
  Array.from(root.querySelectorAll("pre")).forEach((pre, idx) => {
    if (pre.querySelector(".code-copy-btn")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy-btn";
    const remaining = (copiedUntil.get(idx) ?? 0) - now;
    btn.textContent = remaining > 0 ? "✓" : "Copy";
    if (remaining > 0) {
      setTimeout(() => {
        btn.textContent = "Copy";
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
          btn.textContent = "Copy";
        }, COPY_FLASH_MS);
      });
    });
    pre.appendChild(btn);
  });
}

export default function Markdown({ text }: { text: string }) {
  registerPurifyHooks();
  const html = useMemo(
    () => stripDecorativeNewlines(DOMPurify.sanitize(marked.parse(text, { async: false }) as string)),
    [text],
  );
  const ref = useRef<HTMLDivElement>(null);
  const copiedUntil = useRef<Map<number, number>>(new Map());
  const openFile = usePiStore((s) => s.openFile);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll("pre code:not(.hljs)").forEach((el) => {
      hljs.highlightElement(el as HTMLElement);
    });
    addCopyButtons(root, copiedUntil.current);
    // Inline code tokens (`path.ts:12`) become clickable file links.
    root.querySelectorAll("code").forEach((el) => {
      if (el.closest("pre") || el.classList.contains("file-link")) return;
      const m = INLINE_FILE_RE.exec(el.textContent ?? "");
      if (!m || !isLinkablePath(m[1])) return;
      markFileLink(el, m[1], m[2]);
    });
    // Plain-text path references outside code blocks too.
    linkifyTextNodes(root);
  }, [html]);

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

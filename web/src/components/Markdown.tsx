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
import { renderMermaid, mermaidBuiltInTheme, type MermaidTheme } from "../lib/mermaidRender";

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
 * 048/049: 每块的状态（换行开关、渲染/源码模式）。
 *
 * **不能**放在组件的 ref 里：pi 的 `message_end` 会用权威消息整条替换
 * assistant item（新的 item id → React 重挂载 → ref 归零），流式结束的那
 * 一刻状态就丢了。所以状态放在模块级，键取「语言 + 块序号 + 源码开头」——
 * 与消息、与组件实例都无关，重挂载后照样认得。
 */
const wrapStates = new Map<string, boolean>();
/** 049: 每块的显示模式——`render`（渲染成图）或 `source`（看源码）。 */
const viewModes = new Map<string, ViewMode>();
/** 状态条目的上限（防止长会话无限增长）。 */
const WRAP_STATE_MAX = 200;
const VIEW_STATE_MAX = 200;

/**
 * 块状态键：`lang#index:源码开头`。
 *
 * **带块序号**是为了让「前缀回溯」安全：源码在流式增长，键会变，早先记下的
 * 键是当前键的前缀 —— 但只有**同一个块**（同样的语言与序号）才该继承。
 * 没有序号时，源码还空着的块（键 = `mermaid:`）会匹配到消息里**每一个**
 * mermaid 块 → 用户在一个块上的选择会跑到别的块上。
 */
function blockStateKey(lang: string, index: number, text: string): string {
  // marked 给围栏内容补了一个结尾换行（渲染出来的 textContent 比原始源码多
  // 一个 "\n"）。**必须去掉它**：否则流式中途的源码前缀与下一段不再成前缀
  // （"...\n  \n" vs "...\n  A[Start] \n"），前缀回溯就认不出同一个块，
  // 用户在流式中途做的选择会丢。
  return `${lang}#${index}:${text.replace(/\n$/, "").slice(0, 48)}`;
}

/** 键里「lang#index:」前缀的长度 —— 比它短的键不算是同一个块。 */
function stateKeyPrefixLen(key: string): number {
  const hash = key.indexOf("#");
  if (hash < 0) return 0;
  const colon = key.indexOf(":", hash + 1);
  return colon < 0 ? 0 : colon + 1;
}

function readWrapState(key: string): boolean {
  const exact = wrapStates.get(key);
  if (exact !== undefined) return exact;
  // 流式期间源码在增长：源码没写满 48 字时键会变，早先记下的键是当前键的
  // 前缀 → 沿用它（用户在源码还没写完时就切了换行，那个状态不能丢）。
  const min = stateKeyPrefixLen(key);
  for (const [k, v] of wrapStates) {
    if (v && k.length >= min && key.startsWith(k)) return true;
  }
  return false;
}

function writeWrapState(key: string, on: boolean) {
  if (!wrapStates.has(key) && wrapStates.size >= WRAP_STATE_MAX) {
    const oldest = wrapStates.keys().next();
    if (!oldest.done) wrapStates.delete(oldest.value);
  }
  wrapStates.set(key, on);
}

/**
 * 049: 块的显示模式。
 *
 * - `render`：默认。```svg / ```mermaid 这类块渲染成图，源码隐藏。
 * - `source`：看源码。图形收起、源码显示、换行开关恢复可用。
 *
 * 状态存在模块级（理由同 `wrapStates`）：`message_end` 会整条替换 assistant
 * item，组件 ref 会被冲掉；键取「语言 + 块序号 + 源码开头」，流式中源码变长
 * 时按前缀回溯（用户在源码还没写完时切的模式不能丢）。
 */
type ViewMode = "render" | "source";

function readViewMode(key: string): ViewMode {
  const exact = viewModes.get(key);
  if (exact) return exact;
  // 流式期间源码在增长 → 当前键比早先记下的键长，且早先的键是它的前缀
  // → 沿用最长的那个前缀（用户切了模式，那个选择不能丢）。
  const min = stateKeyPrefixLen(key);
  let bestLen = 0;
  let best: ViewMode = "render";
  for (const [k, v] of viewModes) {
    if (k.length >= min && key.startsWith(k) && k.length > bestLen) {
      bestLen = k.length;
      best = v;
    }
  }
  return best;
}

function writeViewMode(key: string, mode: ViewMode) {
  if (!viewModes.has(key) && viewModes.size >= VIEW_STATE_MAX) {
    const oldest = viewModes.keys().next();
    if (!oldest.done) viewModes.delete(oldest.value);
  }
  viewModes.set(key, mode);
}

/**
 * 049: 把状态跟着增长的源码一起往前带。
 *
 * 键随源码变长 → 早先记下的键只能靠前缀回溯认出来；认出来之后顺手记到
 * **当前**键上，下一次就不用再靠回溯了（源码还没写满 4 个字就点开关的
 * 那种情况，早先的键短到认不出来 —— 记到当前键上就稳了）。
 *
 * 只带「非默认」的状态：默认的「渲染 / 不换行」不写，免得盖掉用户更晚
 * 做的选择。
 */
function carryForwardState(key: string) {
  if (readViewMode(key) === "source") writeViewMode(key, "source");
  if (readWrapState(key)) writeWrapState(key, true);
}

/** 围栏语言（`language-*`）——多个地方要用，抽一个。 */
function langOf(code: Element | null): string {
  return /language-([\w+#-]+)/.exec(code?.className ?? "")?.[1] ?? "";
}

/** 049: 哪些语言的代码块默认渲染成图（因而需要「渲染 ⇄ 源码」切换）。 */
const RENDERABLE_LANGS = new Set(["svg", "mermaid"]);

/**
 * 048: 代码块标题栏 —— 左侧语言类型、右侧操作按钮。
 *
 * 语言名不翻译：它是代码块的属性（跟 IDE 的代码块标题一致），不是界面文案。
 * 未标注语言的围栏按 `text` 处理（对齐 IDE 的 "Plain Text"）。
 */
const LANG_LABELS: Record<string, string> = {
  bash: "Shell",
  c: "C",
  cpp: "C++",
  css: "CSS",
  diff: "Diff",
  go: "Go",
  html: "HTML",
  java: "Java",
  javascript: "JavaScript",
  json: "JSON",
  kotlin: "Kotlin",
  markdown: "Markdown",
  mermaid: "Mermaid",
  python: "Python",
  rust: "Rust",
  shell: "Shell",
  sql: "SQL",
  svg: "SVG",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML",
};

function languageLabel(code: Element | null): string {
  const lang = /language-([\w+#-]+)/.exec(code?.className ?? "")?.[1] ?? "";
  if (!lang) return "text";
  return LANG_LABELS[lang.toLowerCase()] ?? lang;
}

/**
 * 048: 换行开关。默认**不换行**（保持横向滚动），开关按块保存状态。
 *
 * 两种状态都显式写死 `white-space`：窄屏媒体查询里的 `pre-wrap` 兜底不得
 * 盖过用户的开关——否则窄窗口下点开关看不到任何变化。
 */
function applyWrap(pre: HTMLElement, on: boolean) {
  pre.style.whiteSpace = on ? "pre-wrap" : "pre";
  pre.style.overflowWrap = on ? "anywhere" : "";
}

/** 代码的行盒高度（px）——行号槽按它对齐。 */
function codeLineHeight(code: HTMLElement): number {
  const rects = Array.from(code.getClientRects());
  // 一个 inline 元素跨 N 行时，浏览器按行盒返回多个 rect；相邻行盒顶边
  // 的间距就是行高（含 line-height 的额外间距，比字体内容高更准）。
  const tops = Array.from(new Set(rects.map((r) => Math.round(r.top * 2) / 2))).sort((a, b) => a - b);
  if (tops.length >= 2) return (tops[tops.length - 1] - tops[0]) / (tops.length - 1);
  const cs = getComputedStyle(code);
  const lh = Number.parseFloat(cs.lineHeight);
  if (Number.isFinite(lh)) return lh;
  return rects[0]?.height ?? Number.parseFloat(cs.fontSize) * 1.2;
}

/** 逻辑行数：结尾的换行不另起一行。 */
function codeLineCount(text: string): number {
  if (!text) return 0;
  let n = text.split("\n").length;
  if (text.endsWith("\n")) n -= 1;
  return Math.max(0, n);
}

/**
 * 换行模式下每个逻辑行占了几个视觉行——用 Range 量真实排版，不估算。
 * 不换行时每行恒为 1 行，不必量（省掉流式期间每增量的 O(行数) 开销）。
 */
function measureWrappedLineHeights(code: HTMLElement, text: string, count: number, lineHeight: number): number[] {
  const nodes: { node: Text; start: number }[] = [];
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  let acc = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    nodes.push({ node: t, start: acc });
    acc += t.data.length;
  }
  const locate = (offset: number): { node: Text; offset: number } | null => {
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const entry = nodes[mid];
      const len = entry.node.data.length;
      if (offset < entry.start) hi = mid - 1;
      else if (offset > entry.start + len) lo = mid + 1;
      else return { node: entry.node, offset: offset - entry.start };
    }
    const last = nodes[nodes.length - 1];
    return last ? { node: last.node, offset: last.node.data.length } : null;
  };
  const heights: number[] = [];
  let start = 0;
  for (let i = 0; i < count; i++) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl;
    const from = locate(start);
    const to = locate(end);
    let rows = 1;
    if (from && to) {
      const range = document.createRange();
      try {
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
        const h = range.getBoundingClientRect().height;
        if (h > 0) rows = Math.max(1, Math.round(h / lineHeight));
      } catch {
        rows = 1;
      }
    }
    heights.push(rows * lineHeight);
    start = end + 1;
  }
  return heights;
}

/**
 * 048: 行号槽。
 *
 * 槽在 `pre` **之外**（`pre` 横向滚动，越界元素会被裁掉），并且
 * `user-select: none` + `aria-hidden` —— 鼠标框选代码时行号既不会被选中、
 * 也不会被复制进剪贴板。源码本身一个字节都没动（复制 / 在 IDE 打开读到的
 * 仍是纯代码文本）。
 */
function syncGutter(pre: HTMLElement) {
  const shell = pre.closest<HTMLElement>(".block-shell");
  const gutter = shell?.querySelector<HTMLElement>(":scope > .code-gutter");
  if (!shell || !gutter) return;
  const code = pre.querySelector("code");
  const text = code?.textContent ?? "";
  const count = code && code.style.display !== "none" ? codeLineCount(text) : 0;
  if (!count) {
    gutter.replaceChildren();
    gutter.hidden = true;
    return;
  }
  const cs = getComputedStyle(code!);
  const lineHeight = codeLineHeight(code!);
  gutter.style.fontFamily = cs.fontFamily;
  gutter.style.fontSize = cs.fontSize;
  gutter.style.lineHeight = `${lineHeight}px`;
  // 与 pre 的上内边距一致：代码的第一行盒才和第一行行号齐平。
  gutter.style.paddingTop = getComputedStyle(pre).paddingTop;
  const wrapped = shell.dataset.wrap === "on";
  const heights = wrapped ? measureWrappedLineHeights(code!, text, count, lineHeight) : null;
  while (gutter.childElementCount > count) gutter.lastElementChild?.remove();
  while (gutter.childElementCount < count) {
    const span = document.createElement("span");
    span.className = "code-line-no";
    gutter.appendChild(span);
  }
  for (let i = 0; i < count; i++) {
    const span = gutter.children[i] as HTMLElement;
    const label = String(i + 1);
    if (span.textContent !== label) span.textContent = label;
    span.style.height = `${heights ? heights[i] : lineHeight}px`;
  }
  gutter.hidden = false;
}

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

/**
 * 047/049: 把「复制为图片」入口挂到代码块标题栏的**最左**（复制按钮之前）。
 *
 * 入口是等图形渲染出来后才有的（图形没画出来就没有可复制的图），所以它天然
 * 是「后到」的——append 就会掉到操作栏最右边。改成 insertBefore(firstChild)
 * 才能让它稳定待在最左：图形后到、按钮先到，顺序不受到达时机影响。
 */
function addImageCopyEntry(actions: Element | null | undefined, getTarget: () => Element | null) {
  if (!actions) return;
  if (actions.querySelector(".copy-image-btn")) return;
  actions.insertBefore(
    makeImageCopyButton(i18n.t("markdown.copyAsImage"), getTarget),
    actions.firstChild,
  );
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
function addCopyButtons(
  root: ParentNode,
  copiedUntil: Map<number, number>,
  openSnippet: (language: string, text: string) => Promise<boolean>,
  theme: MermaidTheme,
) {
  const now = Date.now();
  const copyLabel = i18n.t("common.copy");
  const ideLabel = i18n.t("markdown.openInIde");
  const wrapLabel = i18n.t("markdown.wrap");
  const sourceLabel = i18n.t("markdown.source");
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

    // ── 048 标题栏：左侧语言类型，右侧操作按钮（常驻，不再悬浮出现）──
    const header = document.createElement("div");
    header.className = "block-header";
    const langLabel = document.createElement("span");
    langLabel.className = "block-lang";
    langLabel.textContent = languageLabel(pre.querySelector("code"));
    const actions = document.createElement("div");
    actions.className = "block-actions";
    header.appendChild(langLabel);
    header.appendChild(actions);

    // ── 048 行号槽：在 pre 之外（pre 横向滚动会裁掉越界的元素）──
    const gutter = document.createElement("div");
    gutter.className = "code-gutter";
    gutter.setAttribute("aria-hidden", "true");

    shell.appendChild(header);
    shell.appendChild(gutter);
    shell.appendChild(pre);

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
      const lang = langOf(code);
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

    const codeEl = pre.querySelector("code");
    const lang = langOf(codeEl);
    const stateKey = blockStateKey(lang, idx, codeEl?.textContent ?? "");

    // ── 049 模式开关：只有「默认渲染成图」的块才有（svg / mermaid）。
    //    普通代码块本来就是源码，没有可切的模式 ──
    if (RENDERABLE_LANGS.has(lang.toLowerCase())) {
      const modeBtn = document.createElement("button");
      modeBtn.type = "button";
      modeBtn.className = "code-source-btn block-action-btn";
      modeBtn.textContent = sourceLabel;
      modeBtn.setAttribute("aria-pressed", "false");
      modeBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        // 意图取反：源码模式锁定 ⇄ 回到渲染。
        const next: ViewMode = modeBtn.getAttribute("aria-pressed") === "true" ? "render" : "source";
        // 键按**当前**源码算（流式中源码在长，键跟着长）。
        writeViewMode(blockStateKey(lang, idx, codeEl?.textContent ?? ""), next);
        void applyBlockViewMode(codeEl as HTMLElement, theme, next, idx).then((ok) => {
          if (ok) return;
          // 这个块渲染不出来（语法错的 Mermaid / 画不出的 SVG）：告诉用户
          // 「切不过去」，而不是让按钮灰着、点了没反应。
          modeBtn.textContent = "✗";
          setTimeout(() => {
            modeBtn.textContent = i18n.t("markdown.source");
          }, COPY_FLASH_MS);
        });
      });
      actions.appendChild(modeBtn);
    }

    // ── 048 换行开关：默认不换行；状态存在模块级（组件会被 message_end
    //    重挂载，见 wrapStates 的注释）──
    const wrapBtn = document.createElement("button");
    wrapBtn.type = "button";
    wrapBtn.className = "code-wrap-btn block-action-btn";
    wrapBtn.textContent = wrapLabel;
    const setWrap = (on: boolean) => {
      writeWrapState(stateKey, on);
      shell.dataset.wrap = on ? "on" : "off";
      applyWrap(pre, on);
      wrapBtn.setAttribute("aria-pressed", on ? "true" : "false");
      wrapBtn.classList.toggle("is-on", on);
      syncGutter(pre);
    };
    wrapBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      setWrap(!readWrapState(stateKey));
    });
    actions.appendChild(wrapBtn);
    setWrap(readWrapState(stateKey));
  });
}

/**
 * 048: ```svg 围栏渲染成图。
 *
 * 与 Mermaid 同构：围栏里的 SVG 源码被净化后渲染成图形，源码隐藏但**仍然
 * 可复制、可在 IDE 中打开**（复制按钮读的是 `code.textContent`，与图形无关）。
 * 净化走 DOMPurify 的 svg profile（039 FR-002/003：单一净化入口），远程
 * href / xlink:href 由 registerPurifyHooks 的 SVG 命名空间钩子剥除。
 *
 * 画不出东西的（空壳、畸形、只剩 <script>）降级回源码显示，不给「复制为图片」
 * 入口（047 FR-007）。
 */
function renderSvgFence(code: HTMLElement): boolean {
  const pre = code.closest("pre");
  if (!pre) return false;
  const source = code.textContent ?? "";
  const clean = DOMPurify.sanitize(source, {
    USE_PROFILES: { svg: true },
    // <style> 里的 @import / url(http…) 是外链向量（039 FR-002 要求移除），
    // DOMPurify 不清洗 style 的文本内容，只能在这里禁掉标签本身。
    FORBID_TAGS: ["script", "foreignObject", "style"],
  });
  let fig = pre.querySelector<HTMLDivElement>(".svg-figure");
  const svg = clean.trim() && /^\s*<svg[\s>]/i.test(clean) ? clean : "";
  if (!svg) {
    fig?.remove();
    code.style.display = "";
    syncGutter(pre);
    return false;
  }
  if (!fig) {
    fig = document.createElement("div");
    fig.className = "svg-figure";
    pre.insertBefore(fig, code);
  }
  fig.innerHTML = svg;
  const painted = fig.querySelector("svg");
  let ok = true;
  if (painted) {
    try {
      const bbox = (painted as SVGGraphicsElement).getBBox();
      ok = bbox.width > 0 && bbox.height > 0;
    } catch {
      // getBBox needs a rendered tree — wrap anyway and let the click report.
      ok = true;
    }
  } else {
    ok = false;
  }
  if (!ok) {
    // 画不出东西 → 降级回源码（和 Mermaid 的空图同构处理）。
    fig.remove();
    code.style.display = "";
    syncGutter(pre);
    return false;
  }
  code.style.display = "none";
  syncGutter(pre);
  const actions = pre.closest(".block-shell")?.querySelector(".block-actions");
  addImageCopyEntry(actions, () => fig?.querySelector("svg") ?? null);
  return true;
}

/**
 * 049: 源码模式 —— 收起图形、显示源码、撤掉「复制为图片」入口。
 *
 * 这是「源码模式」的唯一入口（渲染失败降级也走这里），保证两种模式互斥：
 * 图形在，源码就不在；源码在，图形就不在。
 */
function showSourceBlock(pre: HTMLElement, code: HTMLElement) {
  pre.querySelector(".mermaid-figure")?.remove();
  pre.querySelector(".svg-figure")?.remove();
  code.style.display = "";
  // 渲染标记作废：切回渲染模式时必须重新渲染（否则会被「已渲染过」跳过）。
  delete code.dataset.mermaidDone;
  pre.closest(".block-shell")?.querySelector(".copy-image-btn")?.remove();
  syncGutter(pre);
}

/**
 * 049: Mermaid 渲染（040 的渲染路径，提到模块级以便模式切换复用）。
 *
 * 返回 `true` 表示图形已就位；`false` 表示渲染失败（降级回源码）。
 *
 * **图形必须记住自己是从哪份源码画出来的**（`data-mermaid-marker`）：流式
 * 期间同一个块会被反复重建，同一份源码可能同时有多个渲染请求在飞，而
 * `renderMermaid` 的并发保护会让后来的请求直接返回 `null`。`null` 只说明
 * 「这次没画成」，**不代表屏幕上那张图是错的** —— 只有当图属于**另一份**
 * 源码（流式里源码变长了）时才能把它撤掉，否则刚画好的图会被后来的
 * `null` 请求拆掉，块永远停在源码上。
 */
async function renderMermaidBlock(code: HTMLElement, theme: MermaidTheme): Promise<boolean> {
  const pre = code.closest("pre");
  if (!pre) return false;
  const source = code.textContent ?? "";
  if (!source.trim()) return false;
  // The theme is part of the marker: switching the panel theme must
  // re-render the diagram in the new palette.
  const marker = `${theme}#${source}`;

  // 已经画好、且就是这份源码画出来的 → 认它，不必重画。
  const existing = pre.querySelector<HTMLDivElement>(".mermaid-figure");
  if (existing?.dataset.mermaidMarker === marker) {
    code.style.display = "none";
    syncGutter(pre);
    return true;
  }

  code.dataset.mermaidDone = marker;
  const svg = await renderMermaid(source, theme);
  if (!pre.isConnected) return false;
  // The rendered source must still be the block's CURRENT text: a late
  // resolution for an older streaming prefix must not paint its (wrong)
  // diagram over the grown block, nor heal a figure it does not own.
  const current = pre.querySelector("code.language-mermaid")?.textContent ?? "";
  if (current !== source) return false;
  // Nor may a late render of the PREVIOUS theme paint over the new one:
  // a theme switch starts a second render, which then owns this block.
  if (code.dataset.mermaidDone !== marker) return false;
  // 049: 用户在渲染途中切到了源码模式 → 这张图已经没人要了，不能再画出来。
  if (code.dataset.viewMode !== "render") return false;
  if (!svg) {
    // 047 找到的 040 流式遗留：a VALID streaming prefix rendered a
    // figure whose block later grew into a broken source — nothing
    // removed the stale figure, so the user saw a WRONG diagram with
    // the source hidden. The final (broken) render heals it: drop the
    // stale figure and show the source again (the action-bar button is
    // never appended for null renders, FR-007).
    const stale = pre.querySelector<HTMLDivElement>(".mermaid-figure");
    if (stale) {
      // 同一份源码的图已经画好了 → 这次只是撞上了并发保护，认它。
      if (stale.dataset.mermaidMarker === marker) {
        code.style.display = "none";
        syncGutter(pre);
        return true;
      }
      stale.remove();
      code.style.display = "";
      syncGutter(pre);
    }
    return false;
  }
  let fig = pre.querySelector<HTMLDivElement>(".mermaid-figure");
  if (!fig) {
    fig = document.createElement("div");
    fig.className = "mermaid-figure";
    pre.insertBefore(fig, code);
  }
  fig.innerHTML = svg;
  // 这张图属于哪份源码（换源码 / 换主题都要重画，见上面的说明）。
  fig.dataset.mermaidMarker = marker;
  code.style.display = "none";
  // 048: 源码隐藏了，行号槽也一起收起（槽量的是隐藏源码的行数）。
  syncGutter(pre);
  // Which mermaid theme the figure was drawn with — the diagram must
  // follow the panel, not stay a light-mode widget in a dark bubble.
  fig.dataset.mermaidTheme = mermaidBuiltInTheme() ?? "default";
  // 047: the figure landed after the effect ran — ride its pre's shared
  // action bar (degraded blocks never get a figure, hence no entry).
  const actions = pre.closest(".block-shell")?.querySelector(".block-actions");
  addImageCopyEntry(actions, () => fig!.querySelector("svg"));
  return true;
}

/**
 * 049: 模式按钮的状态。
 *
 * - `aria-pressed=true` ⇔ **源码模式已锁定**（按钮高亮 = 「源码模式开着」，
 *   与「换行」按钮同构：文案是状态名，aria-pressed 表示该状态是否开启）。
 * - 按钮**永不置灰**：切到源码必须永远可用 —— 流式期间源码还没写完、
 *   渲染不出来是常态，把按钮灰掉等于「用户想看源码却不让看」。
 *   切不到渲染的情形（语法错的 Mermaid / 画不出的 SVG）由点击时闪 ✗ 告知。
 */
function setModeButton(shell: HTMLElement | null, source: boolean) {
  const btn = shell?.querySelector<HTMLButtonElement>(".code-source-btn");
  if (!btn) return;
  btn.setAttribute("aria-pressed", source ? "true" : "false");
  btn.classList.toggle("is-on", source);
}

/** 049: 换行开关只在「代码真的显示着」时有效（渲染成图时没有行可换）。 */
function setWrapEnabled(shell: HTMLElement | null, enabled: boolean) {
  const btn = shell?.querySelector<HTMLButtonElement>(".code-wrap-btn");
  if (btn) btn.disabled = !enabled;
}

/**
 * 049: 把一个块切到指定模式。
 *
 * `intent` 是**用户意图**（不是当前显示）：
 * - `render`：渲染成图（```svg / ```mermaid）；渲染不出来（降级）就落到源码，
 *   但**不**改写意图 —— 流式中源码还没写完时渲染失败是常态，等源码合法了
 *   自然会出图。
 * - `source`：显示源码、收起图形、换行开关可用。
 *
 * 返回值：请求的渲染模式是否真的渲染出来了（`false` = 这个块渲染不出来）。
 */
async function applyBlockViewMode(
  code: HTMLElement,
  theme: MermaidTheme,
  intent: ViewMode,
  index: number,
): Promise<boolean> {
  const pre = code.closest("pre");
  if (!pre) return false;
  const shell = pre.closest<HTMLElement>(".block-shell");
  const lang = langOf(code);
  // 渲染途中的竞态守卫：切走之后这张图就不该再画出来。
  code.dataset.viewMode = intent;
  let rendered = false;
  if (intent === "render") {
    rendered = lang.toLowerCase() === "svg" ? renderSvgFence(code) : await renderMermaidBlock(code, theme);
    // 用户在渲染途中切到了源码 → 渲染结果作废（renderMermaidBlock 自查）。
    if (code.dataset.viewMode !== "render") return false;
  }
  if (!rendered) {
    // 源码模式，或渲染失败降级 —— 代码在屏幕上，换行开关就该可用。
    showSourceBlock(pre, code);
    applyWrap(pre, readWrapState(blockStateKey(lang, index, code.textContent ?? "")));
  }
  // 按钮显示的是**意图**：源码模式锁定 = 高亮。
  setModeButton(shell, intent === "source");
  setWrapEnabled(shell, !rendered);
  return intent === "source" ? true : rendered;
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
          // DOMPurify's default svg profile; these are forbidden even if
          // a future DOMPurify default ever loosened them. Measured with
          // DOMPurify 3.x: script / on* / foreignObject are already stripped —
          // this pins the guarantee at our call site.
          // <style> 也禁掉：DOMPurify 不清洗 style 的文本内容，里面的
          // @import / url(http…) 是外链向量（039 FR-002 要求移除）。
          // 远程 href 不靠 DOMPurify（实测它放行 http/https），靠
          // registerPurifyHooks 里的 SVG 命名空间剥除。
          FORBID_TAGS: ["script", "foreignObject", "style"],
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
    // 049: 状态跟着增长的源码往前带（键随源码变长，早先的键只能靠前缀回溯
    // 认出来 —— 认出来后记到当前键上，下一次就不用再靠回溯）。
    const pres = Array.from(root.querySelectorAll("pre"));
    pres.forEach((pre, idx) => {
      const code = pre.querySelector("code");
      if (!code) return;
      carryForwardState(blockStateKey(langOf(code), idx, code.textContent ?? ""));
    });
    addCopyButtons(root, copiedUntil.current, openSnippet, theme);
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
    // 049: 默认渲染成图的块（```svg / ```mermaid）按当前模式呈现：
    // 渲染模式 → 出图、源码隐藏；源码模式 → 出源码、图形收起。
    // 渲染不出来（语法错的 mermaid / 画不出的 svg）落到源码，但不改写意图 ——
    // 流式中源码还没写完时渲染失败是常态，源码合法了自然出图。
    pres.forEach((pre, idx) => {
      const code = pre.querySelector("code");
      if (!code) return;
      const lang = langOf(code);
      if (!RENDERABLE_LANGS.has(lang.toLowerCase())) return;
      const mode = readViewMode(blockStateKey(lang, idx, code.textContent ?? ""));
      void applyBlockViewMode(code, theme, mode, idx);
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

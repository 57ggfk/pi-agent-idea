import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePiStore, type SendMode } from "../store/store";
import { needsRefresh } from "../store/sources";
import { autosize, autosizeAndReveal, clampComposerHeight, resetComposerHeight } from "../lib/autosize";
import { collectPathRefs, type PathRef } from "../lib/clipboardRefs";
import { findTokens, removeRange, tokenBackspaceAt } from "../lib/inlineChips";
import { useT } from "../i18n/useT";
import ModelPicker from "./ModelPicker";
import SendButton from "./SendButton";
import ThinkingPicker from "./ThinkingPicker";
import OptionsPopover from "./OptionsPopover";
import { tip } from "./Tooltip";
import Icon from "./Icon";

interface PendingImage {
  data: string; // base64 without data: prefix
  mimeType: string;
  name: string;
}

const FILE_MENU_MAX = 20;

/** Human-readable byte estimate from a base64 payload (no size field exists). */
function estimateSize(base64: string): string {
  const bytes = Math.round((base64.length * 3) / 4);
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${bytes} B`;
}

/**
 * True when a drag carries files or file URIs — drives the drop hint only.
 * A plain-text drag (dragged code) shows no hint and is inserted as text.
 */
function dragCarriesFiles(dt: DataTransfer | null): boolean {
  const types = Array.from(dt?.types ?? []);
  return types.includes("Files") || types.includes("text/uri-list");
}

/**
 * Bottom-bar Fork is hidden in 0.5.2 (spec 007 US2): the capability moved to
 * the per-message toolbar, and two entry points made it unclear which one to
 * use. The code is kept — flip this to `true` to bring the button back. It must
 * stay a render-level switch (not CSS `display:none`), because `measureDensity`
 * walks the rendered children and would still count a hidden button's width.
 */
const SHOW_COMPOSER_FORK = false;

// Control-row density. Dropping a label always beats wrapping the row onto a
// second line, and how much room the row needs depends on the model name, the
// streaming abort button and the action-button labels — not on width alone.
//   0 = everything labelled
//   1 = action buttons icon-only
//   2 = pickers icon-only too (values stay in tooltip / aria-label)
type Density = 0 | 1 | 2;
// The @-token being typed: "@" at the start of the text or after any character
// that cannot end a word (whitespace, CJK, punctuation), then the query (no
// whitespace) up to the end of the input. `[^\w@]` instead of `\s` so typing
// `看@src` works — requiring a space broke the menu for CJK input — while
// `user@example.com` still reads as an email, not as a file token.
const AT_QUERY_RE = /(?:^|[^\w@])@([^\s@]*)$/;

type MenuState = "list" | "loading" | "failed" | "empty";

/**
 * What a completion menu shows when it has no row to offer.
 *
 * The three non-list states must be distinguishable at a glance (spec 003
 * FR-002): "loading" is in progress, "empty" is an answer, "failed" is a fault
 * — and only the last one offers a retry. Sharing one text for all three is
 * exactly the bug this replaces.
 */
function MenuNotice({
  state,
  testId,
  label,
  error,
  busy,
  onRetry,
}: {
  state: Exclude<MenuState, "list">;
  testId: string;
  label: string;
  error?: string;
  busy?: boolean;
  onRetry: () => void;
}) {
  const { t } = useT();
  const what = t(label === "files" ? "composer.menu.files" : "composer.menu.commands");
  if (state === "loading") {
    return (
      <div className="menu-empty menu-loading" data-testid={`${testId}-loading`} data-state="loading">
        {t("composer.menu.loading", { what })}
      </div>
    );
  }
  if (state === "failed") {
    return (
      <div className="menu-empty menu-failed" data-testid={`${testId}-failed`} data-state="failed">
        <div className="menu-failed-title">{t("composer.menu.failed", { what })}</div>
        {error ? (
          <div className="menu-failed-detail" data-testid={`${testId}-failed-detail`}>
            {error}
          </div>
        ) : null}
        <button
          type="button"
          className="menu-action"
          data-testid={`${testId}-retry`}
          disabled={busy}
          // mousedown, not click: the textarea must not lose focus first.
          onMouseDown={(e) => {
            e.preventDefault();
            onRetry();
          }}
        >
          {busy ? t("composer.retrying") : t("composer.retry")}
        </button>
      </div>
    );
  }
  return (
    <div className="menu-empty" data-testid={`${testId}-empty`} data-state="empty">
      {t("composer.menu.empty", { what })}
    </div>
  );
}

export default function Composer() {
  const { t } = useT();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<SendMode>("auto");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  // Menus dismissed with Escape stay closed until the text changes.
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [fileDismissed, setFileDismissed] = useState(false);
  const [fileHighlight, setFileHighlight] = useState(0);
  const send = usePiStore((s) => s.sendImages);
  const abort = usePiStore((s) => s.abort);
  const forkSession = usePiStore((s) => s.forkSession);
  const isStreaming = usePiStore((s) => s.isStreaming);
  // 021 T304: a session switch owns the composer until the target lands —
  // typing stays allowed (Q2), sending does not.
  const pendingSwitch = usePiStore((s) => s.pendingSwitch);
  const commands = usePiStore((s) => s.commands);
  const files = usePiStore((s) => s.files);
  const filesSource = usePiStore((s) => s.sources.files);
  const commandsSource = usePiStore((s) => s.sources.commands);
  const loadFiles = usePiStore((s) => s.loadFiles);
  const retrySource = usePiStore((s) => s.retrySource);
  const compact = usePiStore((s) => s.compact);
  const pendingPrompt = usePiStore((s) => s.pendingPrompt);
  const composerResetSeq = usePiStore((s) => s.composerResetSeq);
  const clearPendingPrompt = usePiStore((s) => s.clearPendingPrompt);
  const resolveRefs = usePiStore((s) => s.resolveRefs);
  const takeDroppedRefs = usePiStore((s) => s.takeDroppedRefs);
  const openComposerPreview = usePiStore((s) => s.openComposerPreview);
  const editing = usePiStore((s) => s.editing);
  const cancelEditMessage = usePiStore((s) => s.cancelEditMessage);
  const sendEdited = usePiStore((s) => s.sendEdited);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  // 025 FR-003/004: the injection measured before the layout existed (hidden
  // tool window, tab not yet painted) and clamped to the 34px floor. Holds the
  // pendingPrompt id of the most recent suspect injection; the `.app`
  // ResizeObserver consumes it exactly once, when the app has a real height.
  const revealPendingRef = useRef<number | null>(null);
  // 025: the length the injected draft SHOULD have once React commits — the
  // rAF below can fire before that commit and would size the box from the
  // stale value (the "sometimes it works" flake this spec fixes).
  const expectedLenRef = useRef<number | null>(null);
  // IME composition (spec 010 FR-009): while the user is mid-composition the
  // browser mutates the textarea freely; measuring in between makes the box
  // bounce under the candidate window. Resizing resumes on compositionend.
  const composingRef = useRef(false);
  const [density, setDensity] = useState<Density>(0);

  /** The single growth entry point: every path that puts text into the box —
   *  typing, IDE injection, quote, queue take-back, `@` completion — ends
   *  here so the height is recomputed after React commits the new value. */
  const applyText = useCallback((next: string) => {
    setText(next);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta && !composingRef.current) autosize(ta, ta.closest(".app") as HTMLElement | null);
    });
  }, []);

  /** Shrinks the box back to one line once the draft is gone (FR-008).
   *  Deliberately deferred: `setText("")` only takes effect after React
   *  commits, so measuring in the same tick still reads the old scrollHeight
   *  and leaves the box at its previous height. */
  const collapseComposer = useCallback(() => {
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) resetComposerHeight(ta, ta.closest(".app") as HTMLElement | null);
    });
  }, []);

  // Spec 018 US1: the text is the single source of truth — a reference is the
  // `@path` text itself, and the mirror overlay paints a pill over each token.
  const tokens = useMemo(() => findTokens(text), [text]);
  /** The mirror's children: the full text (identical flow → identical
   *  wrapping), with each token span styled as a pill whose padding is
   *  cancelled by negative margins so line-break decisions stay byte-equal
   *  to the textarea's. A trailing newline gets a visible extra line. */
  const mirrorContent = useMemo(() => {
    const parts: ReactNode[] = [];
    let pos = 0;
    for (const tok of tokens) {
      if (tok.start > pos) parts.push(text.slice(pos, tok.start));
      parts.push(
        <span
          key={`tok-${tok.start}`}
          className="ref-token"
          data-testid="ref-token"
          data-path={tok.path}
          // Click selects the whole token (then Backspace/typing replaces it).
          onMouseDown={(e) => {
            e.preventDefault();
            const ta = taRef.current;
            if (ta) {
              ta.focus();
              ta.setSelectionRange(tok.start, tok.end);
            }
          }}
        >
          {`@${tok.path}`}
        </span>,
      );
      pos = tok.end;
    }
    parts.push(text.slice(pos));
    if (text.endsWith("\n")) parts.push("\n");
    return parts;
  }, [text, tokens]);

  /** Keeps the mirror aligned when the capped textarea scrolls internally. */
  const syncMirrorScroll = useCallback(() => {
    const ta = taRef.current;
    const mirror = mirrorRef.current;
    if (ta && mirror) {
      mirror.scrollTop = ta.scrollTop;
      mirror.scrollLeft = ta.scrollLeft;
    }
  }, []);

  /** Picks the densest level that still fits on one line — measured, so a long
   *  model name collapses the pickers instead of pushing the row to wrap. */
  const measureDensity = useCallback(() => {
    const el = controlsRef.current;
    if (!el) return;
    const prev = el.dataset.density ?? "0";
    // Measure at natural widths: children must not shrink into an ellipsis
    // first, otherwise "does it fit" would always answer yes.
    el.setAttribute("data-measuring", "");
    const gap = parseFloat(getComputedStyle(el).columnGap || "0") || 0;
    const natural = (level: Density) => {
      el.dataset.density = String(level);
      const kids = Array.from(el.children) as HTMLElement[];
      const used = kids.reduce((sum, k) => sum + k.getBoundingClientRect().width, 0);
      return used + gap * Math.max(0, kids.length - 1);
    };
    const avail = el.clientWidth;
    // Demand half a pixel of slack: fractional text widths otherwise land
    // exactly on the edge and the browser wraps where the sum said "fits".
    const limit = avail - 0.5;
    let next: Density = 0;
    if (natural(0) > limit) next = natural(1) > limit ? 2 : 1;
    el.removeAttribute("data-measuring");
    el.dataset.density = prev;
    setDensity((cur) => (cur === next ? cur : next));
  }, []);

  useLayoutEffect(() => {
    measureDensity();
  }, [measureDensity, density]);

  // Window resizes (ResizeObserver) and label changes — a new model, the abort
  // button appearing while streaming (MutationObserver) — both move the need.
  useEffect(() => {
    const el = controlsRef.current;
    if (!el) return;
    const remeasure = () => measureDensity();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(remeasure);
    ro?.observe(el);
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(remeasure);
    mo?.observe(el, { childList: true, subtree: true, characterData: true });
    void document.fonts?.ready.then(remeasure).catch(() => {});
    return () => {
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [measureDensity]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  // Keep the cap and the CSS variable current: the textarea's cap is
  // `min(320, 45% × app height)` (FR-007), so a tool-window resize re-derives
  // both. Fonts finishing loading changes metrics, so re-measure once then.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const app = ta.closest(".app") as HTMLElement | null;
    const remeasure = () => {
      if (composingRef.current) return;
      // 025 FR-003: a suspect injection waits for exactly this moment — the
      // app regaining a real height. Re-measure WITH the reveal (the injected
      // tail becomes visible), then drop the flag so later resizes never
      // scroll (FR-004/FR-005).
      if (revealPendingRef.current !== null && app && app.clientHeight > 0) {
        revealPendingRef.current = null;
        autosizeAndReveal(ta, app);
        return;
      }
      autosize(ta, app);
    };
    remeasure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(remeasure);
    if (app) ro?.observe(app);
    void document.fonts?.ready.then(remeasure).catch(() => {});
    return () => {
      ro?.disconnect();
    };
  }, []);

  // Editor actions ("Explain with Pi" etc.) push a pre-filled prompt through
  // the ide event; quote / edit reuse the same channel with a different mode.
  //   replace — overwrite the draft (the original behaviour)
  //   quote   — append after the draft, never overwriting typing (FR-006)
  //   edit    — overwrite, and the store's `editing` flag marks the mode
  useEffect(() => {
    if (!pendingPrompt) return;
    const value = pendingPrompt.text;
    const promptMode = pendingPrompt.mode ?? "replace";
    setSlashDismissed(false);
    setFileDismissed(false);
    // An injected prompt ends with exactly one newline: the caret lands on a
    // fresh line and the user starts typing *below* the prompt, not glued to
    // it (0.5.6 real-machine feedback). restore/edit stay verbatim — the user
    // is getting their own draft back.
    const withNewline = (s: string) => `${s.replace(/\s+$/, "")}\n`;
    // Every updater reports the length the value will have once committed, so
    // the rAF below can tell a stale frame from the real result. React may
    // run the updater *after* the first rAF (concurrent rendering defers the
    // render pass), so the effect body plants the -1 sentinel meaning "an
    // updater is queued but has not reported yet".
    let textUpdateQueued = false;
    const note = (next: string) => {
      expectedLenRef.current = next.length;
      return next;
    };
    if (promptMode === "quote") {
      textUpdateQueued = true;
      setText((prev) =>
        note(
          prev.trim().length > 0 ? `${prev.replace(/\s+$/, "")}\n\n${withNewline(value)}` : withNewline(value),
        ),
      );
    } else if (promptMode === "restore") {
      // Queue take-back (spec 005 US3): the user's own draft comes back
      // verbatim — spacing matches quote, but no blockquote prefix.
      textUpdateQueued = true;
      setText((prev) => note(prev.trim().length > 0 ? `${prev.replace(/\s+$/, "")}\n\n${value}` : value));
    } else if (promptMode === "edit") {
      textUpdateQueued = true;
      setText(note(value));
    } else if (value.length > 0) {
      // replace — but a refs-only push (spec 015) arrives with an empty text
      // and must not wipe a draft the user is typing.
      textUpdateQueued = true;
      setText(note(withNewline(value)));
    }
    if (pendingPrompt.images && pendingPrompt.images.length > 0) {
      setImages(
        pendingPrompt.images.map((img, i) => ({
          data: img.data,
          mimeType: img.mimeType,
          name: `image-${i + 1}`,
        })),
      );
    }
    if (pendingPrompt.refs && pendingPrompt.refs.length > 0) {
      // Spec 018 US1: injected references become tokens at the tail of
      // whatever the modes above produced (no caret semantics on injection).
      // Each token carries a trailing space so a finished token never
      // re-opens the @ menu (AT_QUERY_RE only matches a query at the very
      // end); a draft not ending in whitespace gets a separator space, since
      // a `word@src` glue would not even read as a token.
      const toks = pendingPrompt.refs.map((r) => `@${r.path} `).join("");
      textUpdateQueued = true;
      setText((prev) => {
        const next = prev.length === 0 ? toks : /\s$/.test(prev) ? `${prev}${toks}` : `${prev} ${toks}`;
        return note(next);
      });
    }
    // No text updater queued (images-only push): no expectation to wait for.
    if (!textUpdateQueued) expectedLenRef.current = null;
    else if (expectedLenRef.current === null) expectedLenRef.current = -1;
    clearPendingPrompt();
    // The caret has to land at the end of the *new* value, which is only
    // readable from the DOM after React commits it.
    const promptId = pendingPrompt.id;
    // 025: the rAF can fire before React commits the setState calls above —
    // sizing the box from the stale value is exactly the "sometimes it
    // works" flake (reproduced: a deferred updater left the box at 38px with
    // 168 committed chars). Wait (bounded by frames, no timers) until the
    // committed value matches the expected length, then grow + reveal.
    let frames = 0;
    const settle = () => {
      const ta = taRef.current;
      if (!ta) return;
      const expected = expectedLenRef.current;
      const stale = expected === -1 || (expected !== null && ta.value.length !== expected);
      if (stale && frames++ < 60) {
        requestAnimationFrame(settle);
        return;
      }
      expectedLenRef.current = null;
      const app = ta.closest(".app") as HTMLElement | null;
      ta.focus();
      const end = ta.value.length;
      ta.setSelectionRange(end, end);
      // 025: grow AND reveal — the caret alone never scrolls (FR-002).
      autosizeAndReveal(ta, app);
      // FR-003: did this measurement happen before the layout existed? The
      // policy says the box must be clamp(scrollHeight, appHeight) — a box
      // smaller than that (0-height app, stale 38px from a lost race) is
      // wrong until something re-measures; flag the prompt id so the app
      // ResizeObserver redoes it (with the reveal) exactly once. A healthy
      // measurement clears any stale flag — an older injection must not
      // scroll over the user's later manual adjustments (FR-004).
      const should = clampComposerHeight(ta.scrollHeight, app?.clientHeight ?? 0);
      const suspect = !app || app.clientHeight === 0 || parseFloat(ta.style.height) < should - 1;
      revealPendingRef.current = suspect ? promptId : null;
    };
    requestAnimationFrame(settle);
  }, [pendingPrompt, clearPendingPrompt]);

  // 007 FR-013: a branch (fork / new session) must not carry the old draft or
  // its images into the new conversation. Those live in local state, so the
  // store bumps a counter instead of reaching into the component.
  useEffect(() => {
    if (composerResetSeq === 0) return;
    setText("");
    setImages([]);
    setSlashDismissed(false);
    setFileDismissed(false);
    if (taRef.current) {
      resetComposerHeight(taRef.current, taRef.current.closest(".app") as HTMLElement | null);
    }
  }, [composerResetSeq]);

  const slashQuery = /^\//.test(text) && !text.includes(" ") ? text.slice(1).toLowerCase() : null;
  // The menus no longer require matches to show up: a query with no result used
  // to close the menu silently, which is indistinguishable from "broken".
  const slashOpen = slashQuery !== null && !slashDismissed;
  const slashMatches = slashOpen
    ? commands.filter((c) => c.name.toLowerCase().includes(slashQuery)).slice(0, 8)
    : [];

  const atMatch = AT_QUERY_RE.exec(text);
  const atQuery = atMatch ? atMatch[1] : null;
  const atOpen = atQuery !== null && !fileDismissed;
  const fileMatches = atOpen
    ? files.filter((f) => f.toLowerCase().includes(atQuery.toLowerCase())).slice(0, FILE_MENU_MAX)
    : [];

  // "No matching files" is only the truth once the list has actually loaded.
  // Before, an empty menu meant one of four things and looked identical in all
  // of them (spec 003 US1).
  const fileMenuState: MenuState =
    fileMatches.length > 0
      ? "list"
      : filesSource.status === "failed"
        ? "failed"
        : filesSource.status === "ready"
          ? "empty"
          : "loading";
  const slashMenuState: MenuState =
    slashMatches.length > 0
      ? "list"
      : commandsSource.status === "failed"
        ? "failed"
        : commandsSource.status === "ready"
          ? "empty"
          : "loading";
  // A bridge that does not implement the call at all gets no menu: showing a
  // permanent "failed" badge for a feature that cannot exist is noise.
  const fileMenuShown = atOpen && filesSource.status !== "unsupported";
  const slashMenuShown = slashOpen && commandsSource.status !== "unsupported";

  // Opening `@` re-reads the file list once it is stale (FR-006). Keyed on
  // *opening* the menu, not on every keystroke: the old code fired a request
  // per character and had to back off to survive it.
  useEffect(() => {
    if (!atOpen) return;
    if (needsRefresh(usePiStore.getState().sources.files)) void loadFiles();
  }, [atOpen, loadFiles]);

  const doSend = () => {
    // 021: the send path is gated on the switch, not just the button (a
    // keyboard shortcut must not slip through a disabled button).
    if (pendingSwitch != null) return;
    const body = text.trim();
    // Tokens live inline in the text (018 US1) — a message of only references
    // is non-empty text, so "text or images" is the whole sendability rule.
    if (!body && images.length === 0) return;
    // Read the mode before clearing: an edit owns the composer, and sending it
    // must branch the old version off rather than append to it.
    const isEditing = editing != null;
    setText("");
    setImages([]);
    setHighlightIndex(0);
    setFileHighlight(0);
    // Back to a single line immediately (FR-008) — not a slow collapse, no
    // leftover blank space. Measured after the empty value lands.
    collapseComposer();
    if (isEditing) {
      void sendEdited(body);
      return;
    }
    void send(body, images.map((img) => ({ data: img.data, mimeType: img.mimeType })), mode);
  };

  /** Drops the edit target and the draft it filled in — no RPC, no history change. */
  const cancelEdit = () => {
    cancelEditMessage();
    setText("");
    collapseComposer();
  };

  const applySlashCommand = (name: string) => {
    applyText(`/${name} `);
    taRef.current?.focus();
  };

  /** Replaces the trailing "@query" token with "@path " and moves the caret. */
  const insertFile = (path: string) => {
    const m = AT_QUERY_RE.exec(text);
    if (!m) return;
    const atIdx = m.index + m[0].indexOf("@");
    const next = text.slice(0, atIdx) + `@${path} `;
    applyText(next);
    setFileHighlight(0);
    const caret = next.length;
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(caret, caret);
      }
    });
  };

  const addFiles = async (fileList: FileList | File[]) => {
    const added: PendingImage[] = [];
    for (const file of Array.from(fileList)) {
      if (!file.type.startsWith("image/")) continue;
      try {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = String(reader.result);
            resolve(result.slice(result.indexOf(",") + 1));
          };
          reader.onerror = () => reject(reader.error ?? new Error(`failed to read ${file.name}`));
          reader.readAsDataURL(file);
        });
        added.push({ data, mimeType: file.type, name: file.name });
      } catch (e) {
        // A single unreadable file must not reject the whole batch.
        console.warn("skipping unreadable image", file.name, e);
      }
    }
    if (added.length) setImages((prev) => [...prev, ...added]);
  };

  /** Synchronous sweep of a DataTransfer's file items — the object is
   *  neutered once the handler yields, so this must run before any await.
   *  Classification (images out, single-segment `fullPath` degradation) lives
   *  in the pure `clipboardRefs` helpers (018 US3). */
  const sweepFiles = (dt: DataTransfer) =>
    Array.from(dt.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => {
        const file = item.getAsFile?.();
        const entry = item.webkitGetAsEntry?.();
        return {
          name: file?.name ?? entry?.name ?? "",
          fullPath: entry?.fullPath ?? null,
          isDirectory: entry?.isDirectory === true,
          isImage: !!file && file.type.startsWith("image/"),
        };
      });

  /** Inserts `@path ` tokens at the caret (at the end when unfocused) and
   *  leaves the caret after the last one. The trailing space keeps a finished
   *  token from re-opening the @ menu (AT_QUERY_RE needs the query at the
   *  very end of the text). Uses the functional update so a resolve that
   *  resolved after more typing cannot clobber the newer draft. */
  const insertRefTokens = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      const toks = paths.map((p) => `@${p} `).join("");
      const ta = taRef.current;
      const focused = !!ta && document.activeElement === ta;
      let caretTo = -1;
      setText((prev) => {
        const at = focused ? Math.min(ta?.selectionStart ?? prev.length, prev.length) : prev.length;
        const end = focused ? Math.min(ta?.selectionEnd ?? at, prev.length) : prev.length;
        caretTo = at + toks.length;
        return prev.slice(0, at) + toks + prev.slice(end);
      });
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (!el) return;
        el.focus();
        if (caretTo >= 0) el.setSelectionRange(caretTo, caretTo);
        if (!composingRef.current) autosize(el, el.closest(".app") as HTMLElement | null);
      });
    },
    [],
  );

  /** Drop/paste file items → tokens: the bridge converts absolute paths to
   *  project-relative ones; a bridge without the RPC (older IDE side) still
   *  yields usable absolute paths. Resolve failure must not eat the drop. */
  const resolveAndInsert = useCallback(
    async (raw: PathRef[]) => {
      if (raw.length === 0) return;
      let paths: string[];
      try {
        paths = (await resolveRefs(raw)).map((r) => r.path);
      } catch {
        paths = raw.map((r) => r.path);
      }
      insertRefTokens(paths);
    },
    [insertRefTokens, resolveRefs],
  );

  /**
   * Drop → inline reference tokens (spec 015 + 016, 018 US1). Channel order
   * is deliberate:
   *
   * 1. The IDE side (`files.takeDrop`) — CEF's drag handler and an AWT
   *    DropTarget listener are the only places a native or project-tree drag
   *    exposes real absolute paths; the page only ever sees bare file names.
   *    Asked unconditionally (spec 016 real-machine fix): an IDEA project-tree
   *    drag may carry no `Files` flavour at all. This is what makes a token say
   *    `src/store/store.ts` instead of `store.ts`.
   * 2. The DataTransfer itself — uri-list / whole-payload text rules
   *    (`collectPathRefs`) when the IDE had nothing (older IDE side, or a
   *    drag from another browser window).
   *
   * Images keep their image chips and never become references. A drag that
   * carries no files at all is text: it is inserted at the caret like the
   * browser would have done, because `preventDefault()` on dragover claimed it.
   */
  const handleDrop = (dt: DataTransfer) => {
    // Everything read from `dt` must be read synchronously — the object is
    // neutered as soon as the handler yields.
    const files = Array.from(dt.files ?? []);
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    const hasNonImages = files.some((f) => !f.type.startsWith("image/"));
    const plain = dt.getData("text/plain") ?? "";
    const dropped = collectPathRefs(sweepFiles(dt), dt.getData("text/uri-list") ?? "", plain);
    // 真机诊断：这一行会由 JCEF 的 console handler 写进 idea.log，用来判断
    // 页面到底有没有收到 HTML5 drop、以及它看到的 flavour 是什么。
    console.log(
      `[pi-agent] drop: types=${Array.from(dt.types ?? []).join(",")} files=${files.length} plain=${plain.length}`,
    );

    if (imageFiles.length > 0) void addFiles(imageFiles);
    void (async () => {
      // 无条件先问 IDE（spec 016 真机修复）：CEF 与 AWT 两条通道任一记下真路径
      // 都算数。IDEA 项目树拖拽常常只带 text/uri-list 或纯文本、没有 Files，
      // 旧实现只在 dt.files 非空时才问，真路径通道就被整条跳过了。
      const fromIde = await takeDroppedRefs();
      if (fromIde.length > 0) {
        insertRefTokens(fromIde.map((r) => r.path));
        return;
      }
      // IDE 已经兜底推送过这批文件：再解析 DataTransfer 只会插出第二个
      // （往往只有文件名的）chip。
      if (Date.now() - usePiStore.getState().lastIdeDropAt < 1500) return;
      if (hasNonImages || dropped.length > 0) {
        await resolveAndInsert(dropped);
        return;
      }
      if (imageFiles.length === 0) insertDroppedText(plain);
    })();
  };

  /** Inserts dragged text where the caret is (the drop default we suppressed). */
  const insertDroppedText = (insert: string) => {
    if (!insert) return;
    const ta = taRef.current;
    const start = ta?.selectionStart ?? text.length;
    const end = ta?.selectionEnd ?? start;
    applyText(text.slice(0, start) + insert + text.slice(end));
    const caret = start + insert.length;
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(caret, caret);
    });
  };

  return (
    <div
      className="composer"
      data-testid="composer"
      data-drop-active={dropActive ? "true" : "false"}
      onDragOver={(e) => {
        // Claim every drag: dropping files from the OS / the Project View must
        // reach onDrop, and a text drag is inserted by handleDrop itself.
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      }}
      onDragEnter={(e) => {
        if (dragCarriesFiles(e.dataTransfer)) setDropActive(true);
      }}
      onDragLeave={(e) => {
        // dragleave also fires when moving between children — only clear when
        // the pointer really leaves the composer.
        const next = e.relatedTarget as Node | null;
        if (!next || !e.currentTarget.contains(next)) setDropActive(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDropActive(false);
        // The DataTransfer must be read synchronously — handleDrop does the
        // sweep before its first await.
        handleDrop(e.dataTransfer);
      }}
    >
      <div className="composer-inner">
      {fileMenuShown ? (
        <div className="file-menu" data-testid="file-menu" data-state={fileMenuState}>
          {fileMenuState === "list" ? (
            fileMatches.map((f, i) => (
              <div
                key={f}
                className={`file-item ${i === fileHighlight ? "file-active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertFile(f);
                }}
              >
                @{f}
              </div>
            ))
          ) : (
            <MenuNotice
              state={fileMenuState}
              testId="file-menu"
              label="files"
              error={filesSource.error}
              busy={filesSource.inflight}
              onRetry={() => void retrySource("files")}
            />
          )}
          {/* FR-006 does not require waiting for the TTL: a file created a
              minute ago should be findable now. */}
          <div className="menu-footer">
            <span className="menu-footer-hint">{t("composer.menu.footerHint")}</span>
            <button
              type="button"
              className="menu-action"
              data-testid="file-menu-refresh"
              aria-label={t("composer.menu.refreshAria")}
              disabled={filesSource.inflight}
              onMouseDown={(e) => {
                e.preventDefault();
                void loadFiles();
              }}
            >
              {t("composer.menu.refresh")}
            </button>
          </div>
        </div>
      ) : null}
      {slashMenuShown ? (
        <div className="slash-menu" data-testid="slash-menu" data-state={slashMenuState}>
          {slashMenuState === "list" ? (
            slashMatches.map((c, i) => (
              <div
                key={c.name}
                className={`slash-item ${i === highlightIndex ? "slash-active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applySlashCommand(c.name);
                }}
              >
                <span className="slash-name">/{c.name}</span>
                <span className="slash-desc">{c.description ?? c.source}</span>
              </div>
            ))
          ) : (
            <MenuNotice
              state={slashMenuState}
              testId="slash-menu"
              label="commands"
              error={commandsSource.error}
              busy={commandsSource.inflight}
              onRetry={() => void retrySource("commands")}
            />
          )}
        </div>
      ) : null}
      {images.length > 0 ? (
        <div className="image-chips" data-testid="image-chips">
          {images.map((img, i) => {
            const label = img.name || t("composer.image.fallback");
            const src = `data:${img.mimeType};base64,${img.data}`;
            const size = estimateSize(img.data);
            return (
              <span key={i} className="image-card" data-testid="image-card">
                {/* 018 US2: the thumbnail opens the shared preview modal; the
                    list is handed over with the click (composer images never
                    enter the transcript). */}
                <img
                  className="image-card-thumb"
                  src={src}
                  alt={label}
                  title={size ? `${label} · ${size}` : label}
                  onClick={() =>
                    openComposerPreview(
                      images.map((im) => ({
                        src: `data:${im.mimeType};base64,${im.data}`,
                        label: im.name || t("composer.image.fallback"),
                      })),
                      i,
                    )
                  }
                />
                <span className="image-card-name">{label}</span>
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={t("composer.image.remove", { name: label })}
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Icon name="x" className="ic-sm" />
                </button>
              </span>
            );
          })}
        </div>
      ) : null}
      {/* Reference chips moved inline (018 US1): tokens are rendered by the
          mirror overlay inside the textarea wrap below, so nothing occupies a
          separate row above the box anymore. */}
      {/* The old "N queued messages" note is replaced by QueueBar (spec 005 US1):
          it shows what is queued, not just how many. */}
      {editing ? (
        <div className="edit-mode-note" data-testid="edit-mode-note">
          <Icon name="pencil" className="ic-sm" />
          <span>{t("composer.editNote")}</span>
          <button
            type="button"
            className="edit-mode-cancel"
            data-testid="edit-mode-cancel"
            aria-label={t("composer.editCancel")}
            onClick={cancelEdit}
          >
            Esc
          </button>
        </div>
      ) : null}
      <div className="composer-box">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <div className="composer-input-wrap">
          {/* Mirror overlay (018 US1): paints the token pills over the raw
              text. It is non-interactive except the pills themselves; the
              textarea below owns the caret, selection and IME. */}
          <div className="composer-mirror" data-testid="composer-mirror" aria-hidden="true" ref={mirrorRef}>
            {mirrorContent}
          </div>
          <textarea
          ref={taRef}
          data-testid="composer-input"
          className="composer-input"
          placeholder={t("composer.placeholder")}
          rows={1}
          value={text}
          onScroll={syncMirrorScroll}
          onChange={(e) => {
            setText(e.target.value);
            setHighlightIndex(0);
            setSlashDismissed(false);
            setFileDismissed(false);
            if (!composingRef.current) autosize(e.target, e.target.closest(".app") as HTMLElement | null);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(e) => {
            composingRef.current = false;
            // One final resize now that the composition is committed.
            autosize(e.currentTarget, e.currentTarget.closest(".app") as HTMLElement | null);
          }}
          onPaste={(e) => {
            const cb = e.clipboardData;
            const pasted = Array.from(cb.files).filter((f) => f.type.startsWith("image/"));
            if (pasted.length > 0) {
              e.preventDefault();
              void addFiles(pasted);
              return;
            }
            // A copied file / project-tree node still pastes as a reference
            // (015), but 018 US3 tightened the text flavour: only a whole
            // payload of one whitespace-free path counts. Multi-line markdown
            // pastes are text now — the default browser insertion runs.
            const dropped = collectPathRefs(
              sweepFiles(cb),
              cb.getData("text/uri-list") ?? "",
              cb.getData("text/plain") ?? "",
            );
            if (dropped.length > 0) {
              e.preventDefault();
              void resolveAndInsert(dropped);
            }
          }}
          onKeyDown={(e) => {
            if (atOpen) {
              if (fileMatches.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setFileHighlight((i) => Math.min(i + 1, fileMatches.length - 1));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setFileHighlight((i) => Math.max(i - 1, 0));
                  return;
                }
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                  e.preventDefault();
                  insertFile(fileMatches[Math.min(fileHighlight, fileMatches.length - 1)]);
                  return;
                }
              }
              if (e.key === "Escape") {
                // Close the menu (empty or not) — the typed text stays.
                e.preventDefault();
                setFileDismissed(true);
                return;
              }
            }
            if (slashOpen) {
              if (slashMatches.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHighlightIndex((i) => Math.min(i + 1, slashMatches.length - 1));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHighlightIndex((i) => Math.max(i - 1, 0));
                  return;
                }
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                  e.preventDefault();
                  applySlashCommand(slashMatches[highlightIndex].name);
                  return;
                }
              }
              if (e.key === "Escape") {
                // Close the menu only — the typed text stays.
                e.preventDefault();
                setSlashDismissed(true);
                return;
              }
            }
            // One Backspace at a pill's right edge removes the whole token
            // (018 US1, separator space included). Skipped while the @ menu
            // is open: the trailing token is then a query being typed, which
            // must edit character-wise.
            if (e.key === "Backspace" && !atOpen && !slashOpen) {
              const ta = taRef.current;
              if (ta && ta.selectionStart === ta.selectionEnd) {
                const span = tokenBackspaceAt(tokens, text, ta.selectionStart);
                if (span) {
                  e.preventDefault();
                  applyText(removeRange(text, span.start, span.end));
                  requestAnimationFrame(() => {
                    const el = taRef.current;
                    if (el) {
                      el.focus();
                      el.setSelectionRange(span.start, span.start);
                    }
                  });
                  return;
                }
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              doSend();
            }
            if (editing && e.key === "Escape") {
              // Esc leaves edit mode without touching the transcript. The
              // menus above consume Escape first: closing a menu is the
              // smaller, more expected action.
              e.preventDefault();
              cancelEdit();
            }
          }}
        />
        </div>
        <div
          className="composer-controls"
          data-testid="composer-controls"
          data-density={density}
          ref={controlsRef}
        >
          <div className="tools-left">
            <button
              type="button"
              className="icon-btn"
              {...tip(t("composer.attach"))}
              aria-label={t("composer.attach")}
              onClick={() => fileRef.current?.click()}
            >
              <Icon name="paperclip" />
            </button>
            <span className="divider" aria-hidden="true" />
            <ModelPicker />
            <ThinkingPicker />
            <OptionsPopover />
          </div>
          <div className="spacer" />
          <div className="tools-right">
            {isStreaming ? (
              <button
                type="button"
                className="icon-btn icon-btn-danger"
                data-testid="abort-btn"
                aria-label={t("composer.stopAria")}
                {...tip(t("composer.stop"))}
                onClick={() => void abort()}
              >
                <Icon name="stop" />
              </button>
            ) : null}
            <button
              className="btn btn-tool btn-ghost"
              data-testid="compact-btn"
              onClick={() => void compact()}
              disabled={isStreaming}
              {...tip(t("composer.compact"))}
            >
              <Icon name="compact" className="ic-sm" />
              <span className="btn-lbl">{t("composer.compactLabel")}</span>
            </button>
            {SHOW_COMPOSER_FORK ? (
              <button
                className="btn btn-tool btn-ghost"
                data-testid="fork-btn"
                onClick={() => void forkSession()}
                disabled={isStreaming}
                {...tip(t("composer.forkTitle"))}
              >
                <Icon name="fork" className="ic-sm" />
                <span className="btn-lbl">{t("composer.forkLabel")}</span>
              </button>
            ) : null}
            <SendButton
              mode={mode}
              setMode={(m: SendMode) => setMode(m)}
              onMain={doSend}
              disabled={(!text.trim() && images.length === 0) || pendingSwitch != null}
              isStreaming={isStreaming}
              blockedHint={pendingSwitch != null ? t("session.switching") : undefined}
            />
          </div>
        </div>
      </div>
      </div>
      {dropActive ? (
        <div className="composer-drop" data-testid="composer-drop">
          <Icon name="file" className="ic-sm" />
          <span>{t("composer.dropHint")}</span>
        </div>
      ) : null}
    </div>
  );
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePiStore, type PendingRef, type SendMode } from "../store/store";
import { needsRefresh } from "../store/sources";
import { autosize, resetComposerHeight } from "../lib/autosize";
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

/** Raw paths collected from a drop/paste, before the bridge resolves them. */
interface DroppedPath {
  path: string;
  dir: boolean;
}

/** Merges two ref lists, keeping the first occurrence of every path (015). */
function mergeRefs(prev: PendingRef[], next: PendingRef[]): PendingRef[] {
  const seen = new Set(prev.map((r) => r.path));
  const out = [...prev];
  for (const r of next) {
    if (r.path && !seen.has(r.path)) {
      seen.add(r.path);
      out.push(r);
    }
  }
  return out;
}

/**
 * Synchronous sweep of a DataTransfer during drop/paste (the object is
 * neutered once the handler yields, so everything must be read here).
 *
 * Images stay on the image-chip path (existing behaviour); everything else
 * becomes a file/directory reference (spec 015). Desktop drags are read via
 * `webkitGetAsEntry()` — Chromium reports the absolute path of a native drag
 * in `fullPath`, which a plain `File` object never exposes. IDEA project-tree
 * drags and copied files that arrive as uri-list / plain text are parsed from
 * their `file://` lines instead.
 */
function collectDroppedRefs(dt: DataTransfer): DroppedPath[] {
  const out: DroppedPath[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile?.();
    if (file && file.type.startsWith("image/")) continue; // images → image chips
    const entry = item.webkitGetAsEntry?.();
    if (entry) {
      const p = entry.fullPath;
      if (p && p.length > 1) {
        out.push({ path: p, dir: entry.isDirectory });
        continue;
      }
    }
    if (file) out.push({ path: file.name, dir: false }); // best effort: name only
  }
  if (out.length > 0) return out;
  // No usable file items — try the uri-list / plain-text flavours
  // (IDEA project-tree drags, files copied in a file manager).
  const text = dt.getData("text/uri-list") || dt.getData("text/plain") || "";
  for (const line of text.split(/\r?\n/)) {
    const token = line.trim().split(/\s+/)[0];
    if (!token || token.startsWith("#")) continue; // uri-list comment lines
    if (token.startsWith("file://")) {
      try {
        const u = new URL(token);
        const p = decodeURIComponent(u.pathname);
        if (p.length > 1) out.push({ path: p, dir: p.endsWith("/") });
      } catch {
        // Malformed URI — skip the line rather than the whole drop.
      }
    } else if (!token.includes("://") && !token.startsWith("data:")) {
      // A bare path (some drag sources only offer plain text).
      out.push({ path: token, dir: token.endsWith("/") });
    }
  }
  return out;
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
  const [refs, setRefs] = useState<PendingRef[]>([]);
  const [highlightIndex, setHighlightIndex] = useState(0);
  // Menus dismissed with Escape stay closed until the text changes.
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [fileDismissed, setFileDismissed] = useState(false);
  const [fileHighlight, setFileHighlight] = useState(0);
  const send = usePiStore((s) => s.sendImages);
  const abort = usePiStore((s) => s.abort);
  const forkSession = usePiStore((s) => s.forkSession);
  const isStreaming = usePiStore((s) => s.isStreaming);
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
  const editing = usePiStore((s) => s.editing);
  const cancelEditMessage = usePiStore((s) => s.cancelEditMessage);
  const sendEdited = usePiStore((s) => s.sendEdited);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
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
      if (!composingRef.current) autosize(ta, app);
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
    if (promptMode === "quote") {
      setText((prev) =>
        prev.trim().length > 0 ? `${prev.replace(/\s+$/, "")}\n\n${withNewline(value)}` : withNewline(value),
      );
    } else if (promptMode === "restore") {
      // Queue take-back (spec 005 US3): the user's own draft comes back
      // verbatim — spacing matches quote, but no blockquote prefix.
      setText((prev) => (prev.trim().length > 0 ? `${prev.replace(/\s+$/, "")}\n\n${value}` : value));
    } else if (promptMode === "edit") {
      setText(value);
    } else if (value.length > 0) {
      // replace — but a refs-only push (spec 015) arrives with an empty text
      // and must not wipe a draft the user is typing.
      setText(withNewline(value));
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
      setRefs((prev) => mergeRefs(prev, pendingPrompt.refs!));
    }
    clearPendingPrompt();
    // The caret has to land at the end of the *new* value, which is only
    // readable from the DOM after React commits it.
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      const end = ta.value.length;
      ta.setSelectionRange(end, end);
      autosize(ta, ta.closest(".app") as HTMLElement | null);
    });
  }, [pendingPrompt, clearPendingPrompt]);

  // 007 FR-013: a branch (fork / new session) must not carry the old draft or
  // its images into the new conversation. Those live in local state, so the
  // store bumps a counter instead of reaching into the component.
  useEffect(() => {
    if (composerResetSeq === 0) return;
    setText("");
    setImages([]);
    setRefs([]);
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
    const body = text.trim();
    if (!body && images.length === 0 && refs.length === 0) return;
    // Read the mode before clearing: an edit owns the composer, and sending it
    // must branch the old version off rather than append to it.
    const isEditing = editing != null;
    // References (spec 015) ride as `@path` tokens on their own line — pi
    // resolves them itself, so only the path ever travels.
    const refToken = refs.map((r) => `@${r.path}`).join(" ");
    const outgoing = refToken ? (body ? `${refToken}\n${body}` : refToken) : body;
    setText("");
    setImages([]);
    setRefs([]);
    setHighlightIndex(0);
    setFileHighlight(0);
    // Back to a single line immediately (FR-008) — not a slow collapse, no
    // leftover blank space. Measured after the empty value lands.
    collapseComposer();
    if (isEditing) {
      void sendEdited(outgoing);
      return;
    }
    void send(outgoing, images.map((img) => ({ data: img.data, mimeType: img.mimeType })), mode);
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

  /** Turns raw dropped paths into references: the bridge converts absolute
   *  paths to project-relative ones and confirms the directory flag. A bridge
   *  without the RPC (older IDE side) still yields usable absolute paths. */
  const addRefs = async (dropped: DroppedPath[]) => {
    if (dropped.length === 0) return;
    try {
      const resolved = await resolveRefs(dropped);
      setRefs((prev) => mergeRefs(prev, resolved));
    } catch {
      // Resolve is cosmetic (relative vs absolute) — a failure must not eat
      // the drop; the paths stay as the drag source reported them.
      setRefs((prev) => mergeRefs(prev, dropped));
    }
  };

  return (
    <div
      className="composer"
      data-testid="composer"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        // Images keep their chips; every other file/directory becomes a
        // reference (spec 015). The DataTransfer must be read synchronously —
        // collectDroppedRefs does the sweep before any await.
        const dropped = collectDroppedRefs(e.dataTransfer);
        const imageFiles = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
        if (imageFiles.length > 0) void addFiles(imageFiles);
        if (dropped.length > 0) void addRefs(dropped);
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
          {images.map((img, i) => (
            <span key={i} className="image-chip">
              <Icon name="image" className="ic-sm" />
              {img.name || t("composer.image.fallback")}
              <button
                type="button"
                className="chip-remove"
                aria-label={t("composer.image.remove", { name: img.name || "image" })}
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
              >
                <Icon name="x" className="ic-sm" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {refs.length > 0 ? (
        <div className="image-chips" data-testid="ref-chips">
          {refs.map((r, i) => (
            <span key={r.path} className="image-chip ref-chip" data-dir={r.dir ? "true" : "false"}>
              <Icon name={r.dir ? "folder" : "file"} className="ic-sm" />
              <span className="ref-path">{r.path}</span>
              <button
                type="button"
                className="chip-remove"
                aria-label={t("composer.ref.remove", { path: r.path })}
                onClick={() => setRefs((prev) => prev.filter((_, j) => j !== i))}
              >
                <Icon name="x" className="ic-sm" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
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
        <textarea
          ref={taRef}
          data-testid="composer-input"
          className="composer-input"
          placeholder={t("composer.placeholder")}
          rows={1}
          value={text}
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
            const pasted = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
            if (pasted.length > 0) {
              e.preventDefault();
              void addFiles(pasted);
              return;
            }
            // A copied file / project-tree node pastes as a reference (015).
            // Plain-text paste must be left alone — collectDroppedRefs only
            // reports file items and file:// / path-looking text.
            const dropped = collectDroppedRefs(e.clipboardData);
            if (dropped.length > 0) {
              e.preventDefault();
              void addRefs(dropped);
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
              disabled={!text.trim() && images.length === 0 && refs.length === 0}
              isStreaming={isStreaming}
            />
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

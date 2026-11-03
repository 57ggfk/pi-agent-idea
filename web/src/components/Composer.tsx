import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePiStore, type SendMode } from "../store/store";
import { getBridge } from "../bridge";
import ModelPicker from "./ModelPicker";
import SendButton from "./SendButton";
import ThinkingPicker from "./ThinkingPicker";
import OptionsPopover from "./OptionsPopover";
import Icon from "./Icon";

interface PendingImage {
  data: string; // base64 without data: prefix
  mimeType: string;
  name: string;
}

const FILE_MENU_MAX = 20;

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

// Project files for @ completion. Cached only after a successful answer: an
// empty list is a legitimate result, but a failed request (pi still starting,
// project index still building) must not be remembered — that used to leave @
// permanently dead for the rest of the UI session.
let filesCache: string[] | null = null;
let filesInFlight: Promise<string[]> | null = null;
let filesFailedAt = 0;
/** Back-off after a failure so a racing bridge is not hammered per keystroke. */
const FILES_RETRY_MS = 2000;

async function loadProjectFiles(force = false): Promise<string[]> {
  if (filesCache && !force) return filesCache;
  if (filesInFlight) return filesInFlight;
  if (!force && filesFailedAt > 0 && Date.now() - filesFailedAt < FILES_RETRY_MS) {
    return filesCache ?? [];
  }
  const request = (async () => {
    const bridge = await getBridge();
    const resp = await bridge.request<{ files?: string[] }>("files.list");
    filesCache = resp.files ?? [];
    filesFailedAt = 0;
    return filesCache;
  })();
  filesInFlight = request;
  try {
    return await request;
  } catch (e) {
    filesFailedAt = Date.now();
    console.warn("files.list failed", e);
    return filesCache ?? [];
  } finally {
    if (filesInFlight === request) filesInFlight = null;
  }
}

/** Grows the textarea to its content, capped so it cannot eat the message list. */
function autosize(ta: HTMLTextAreaElement) {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
}

export default function Composer() {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<SendMode>("auto");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  // Menus dismissed with Escape stay closed until the text changes.
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [fileDismissed, setFileDismissed] = useState(false);
  const [fileHighlight, setFileHighlight] = useState(0);
  const send = usePiStore((s) => s.sendImages);
  const abort = usePiStore((s) => s.abort);
  const forkSession = usePiStore((s) => s.forkSession);
  const isStreaming = usePiStore((s) => s.isStreaming);
  const queue = usePiStore((s) => s.queue);
  const commands = usePiStore((s) => s.commands);
  const refreshCommands = usePiStore((s) => s.refreshCommands);
  const compact = usePiStore((s) => s.compact);
  const newSession = usePiStore((s) => s.newSession);
  const pendingPrompt = usePiStore((s) => s.pendingPrompt);
  const clearPendingPrompt = usePiStore((s) => s.clearPendingPrompt);
  const editing = usePiStore((s) => s.editing);
  const cancelEditMessage = usePiStore((s) => s.cancelEditMessage);
  const sendEdited = usePiStore((s) => s.sendEdited);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const [density, setDensity] = useState<Density>(0);

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
    void loadProjectFiles().then(setFiles);
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
    if (promptMode === "quote") {
      setText((prev) => (prev.trim().length > 0 ? `${prev.replace(/\s+$/, "")}\n\n${value}` : value));
    } else {
      setText(value);
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
      autosize(ta);
    });
  }, [pendingPrompt, clearPendingPrompt]);

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

  // init() fetches the command list once, which can race the pi process: the
  // RPC fails, the error is swallowed and the list stays empty forever. Retry
  // every time the menu is opened on an empty list instead.
  useEffect(() => {
    if (!slashOpen || commands.length > 0) return;
    void refreshCommands();
  }, [slashOpen, commands.length, refreshCommands]);

  // Same for the project files — the first load may run before the index has
  // anything to report.
  useEffect(() => {
    if (!atOpen || files.length > 0) return;
    let cancelled = false;
    void loadProjectFiles(true).then((list) => {
      if (!cancelled) setFiles(list);
    });
    return () => {
      cancelled = true;
    };
  }, [atOpen, files.length]);

  const doSend = () => {
    const t = text.trim();
    if (!t && images.length === 0) return;
    // Read the mode before clearing: an edit owns the composer, and sending it
    // must branch the old version off rather than append to it.
    const isEditing = editing != null;
    setText("");
    setImages([]);
    setHighlightIndex(0);
    setFileHighlight(0);
    if (taRef.current) taRef.current.style.height = "auto";
    if (isEditing) {
      void sendEdited(t);
      return;
    }
    void send(t, images.map((img) => ({ data: img.data, mimeType: img.mimeType })), mode);
  };

  /** Drops the edit target and the draft it filled in — no RPC, no history change. */
  const cancelEdit = () => {
    cancelEditMessage();
    setText("");
    if (taRef.current) taRef.current.style.height = "auto";
  };

  const applySlashCommand = (name: string) => {
    setText(`/${name} `);
    taRef.current?.focus();
  };

  /** Replaces the trailing "@query" token with "@path " and moves the caret. */
  const insertFile = (path: string) => {
    const m = AT_QUERY_RE.exec(text);
    if (!m) return;
    const atIdx = m.index + m[0].indexOf("@");
    const next = text.slice(0, atIdx) + `@${path} `;
    setText(next);
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

  const queuedCount = queue.steering.length + queue.followUp.length;

  return (
    <div
      className="composer"
      data-testid="composer"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length > 0) void addFiles(e.dataTransfer.files);
      }}
    >
      <div className="composer-inner">
      {atOpen ? (
        <div className="file-menu" data-testid="file-menu">
          {fileMatches.length === 0 ? (
            <div className="menu-empty" data-testid="file-menu-empty">
              No matching files
            </div>
          ) : (
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
          )}
        </div>
      ) : null}
      {slashOpen ? (
        <div className="slash-menu" data-testid="slash-menu">
          {slashMatches.length === 0 ? (
            <div className="menu-empty" data-testid="slash-menu-empty">
              No matching commands
            </div>
          ) : (
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
          )}
        </div>
      ) : null}
      {images.length > 0 ? (
        <div className="image-chips" data-testid="image-chips">
          {images.map((img, i) => (
            <span key={i} className="image-chip">
              <Icon name="image" className="ic-sm" />
              {img.name || "image"}
              <button
                type="button"
                className="chip-remove"
                aria-label={`Remove ${img.name || "image"}`}
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
              >
                <Icon name="x" className="ic-sm" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {queuedCount > 0 ? (
        <div className="queue-note" data-testid="queue-note">
          {queuedCount} queued message{queuedCount > 1 ? "s" : ""}
        </div>
      ) : null}
      {editing ? (
        <div className="edit-mode-note" data-testid="edit-mode-note">
          <Icon name="pencil" className="ic-sm" />
          <span>Editing message · sending replaces it and the reply below</span>
          <button
            type="button"
            className="edit-mode-cancel"
            data-testid="edit-mode-cancel"
            aria-label="Cancel editing"
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
          placeholder="Message pi… (/ for commands, @ for files)"
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setHighlightIndex(0);
            setSlashDismissed(false);
            setFileDismissed(false);
            autosize(e.target);
          }}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
            if (pasted.length > 0) {
              e.preventDefault();
              void addFiles(pasted);
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
              title="Attach images"
              aria-label="Attach images"
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
                aria-label="Stop"
                title="Stop the current run"
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
              title="Compact the conversation context"
            >
              <Icon name="compact" className="ic-sm" />
              <span className="btn-lbl">Compact</span>
            </button>
            <button
              className="btn btn-tool btn-ghost"
              data-testid="fork-btn"
              onClick={() => void forkSession()}
              disabled={isStreaming}
              title="Fork the conversation at the last user message into a new session"
            >
              <Icon name="fork" className="ic-sm" />
              <span className="btn-lbl">Fork</span>
            </button>
            <button
              className="btn btn-tool btn-ghost"
              data-testid="new-session"
              onClick={() => {
                // new_session drops the running conversation silently, so a
                // mis-click used to throw away an in-flight answer.
                if (
                  isStreaming &&
                  !window.confirm("Pi is still working. Start a new session and discard the current run?")
                ) {
                  return;
                }
                void newSession();
              }}
              title={
                isStreaming
                  ? "New session (the current run will be discarded)"
                  : "Start a new session"
              }
            >
              <Icon name="plus" className="ic-sm" />
              <span className="btn-lbl">New</span>
            </button>
            <SendButton
              mode={mode}
              setMode={(m: SendMode) => setMode(m)}
              onMain={doSend}
              disabled={!text.trim() && images.length === 0}
              isStreaming={isStreaming}
            />
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { usePiStore, type SendMode } from "../store/store";
import { getBridge } from "../bridge";
import ModelPicker from "./ModelPicker";
import SendButton from "./SendButton";
import ThinkingPicker from "./ThinkingPicker";
import OptionsPopover from "./OptionsPopover";

interface PendingImage {
  data: string; // base64 without data: prefix
  mimeType: string;
  name: string;
}

const FILE_MENU_MAX = 20;
// The @-token being typed: start-of-text or whitespace, "@" then the query
// (no whitespace) up to the caret end of the input.
const AT_QUERY_RE = /(?:^|\s)@([^\s@]*)$/;

// Project files for @ completion — fetched once per UI session.
let filesCache: string[] | null = null;
async function loadProjectFiles(): Promise<string[]> {
  if (filesCache) return filesCache;
  try {
    const bridge = await getBridge();
    const resp = await bridge.request<{ files?: string[] }>("files.list");
    filesCache = resp.files ?? [];
  } catch {
    filesCache = [];
  }
  return filesCache;
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
  const compact = usePiStore((s) => s.compact);
  const newSession = usePiStore((s) => s.newSession);
  const pendingPrompt = usePiStore((s) => s.pendingPrompt);
  const clearPendingPrompt = usePiStore((s) => s.clearPendingPrompt);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadProjectFiles().then(setFiles);
  }, []);

  // Editor actions ("Explain with Pi" etc.) push a pre-filled prompt through
  // the ide event; the store lands it here for the composer to pick up.
  useEffect(() => {
    if (!pendingPrompt) return;
    const value = pendingPrompt.text;
    setText(value);
    setSlashDismissed(false);
    setFileDismissed(false);
    clearPendingPrompt();
    const ta = taRef.current;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(value.length, value.length);
    }
  }, [pendingPrompt, clearPendingPrompt]);

  const slashQuery = /^\//.test(text) && !text.includes(" ") ? text.slice(1).toLowerCase() : null;
  const slashMatches = slashQuery !== null && !slashDismissed
    ? commands.filter((c) => c.name.toLowerCase().includes(slashQuery)).slice(0, 8)
    : [];

  const atMatch = AT_QUERY_RE.exec(text);
  const atQuery = atMatch ? atMatch[1] : null;
  const fileMatches = atQuery !== null && !fileDismissed
    ? files.filter((f) => f.toLowerCase().includes(atQuery.toLowerCase())).slice(0, FILE_MENU_MAX)
    : [];

  const doSend = () => {
    const t = text.trim();
    if (!t && images.length === 0) return;
    setText("");
    setImages([]);
    setHighlightIndex(0);
    setFileHighlight(0);
    if (taRef.current) taRef.current.style.height = "auto";
    void send(t, images.map((img) => ({ data: img.data, mimeType: img.mimeType })), mode);
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
      {fileMatches.length > 0 ? (
        <div className="file-menu" data-testid="file-menu">
          {fileMatches.map((f, i) => (
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
          ))}
        </div>
      ) : null}
      {slashMatches.length > 0 ? (
        <div className="slash-menu" data-testid="slash-menu">
          {slashMatches.map((c, i) => (
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
          ))}
        </div>
      ) : null}
      {images.length > 0 ? (
        <div className="image-chips" data-testid="image-chips">
          {images.map((img, i) => (
            <span key={i} className="image-chip">
              🖼 {img.name || "image"}
              <button className="chip-remove" onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}>
                ×
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
      <div className="composer-row">
        <button className="btn btn-icon" title="Attach images" onClick={() => fileRef.current?.click()}>
          📎
        </button>
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
            e.target.style.height = "auto";
            e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
          }}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
            if (pasted.length > 0) {
              e.preventDefault();
              void addFiles(pasted);
            }
          }}
          onKeyDown={(e) => {
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
              if (e.key === "Escape") {
                e.preventDefault();
                setFileDismissed(true);
                return;
              }
            }
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
          }}
        />
        {isStreaming ? (
          <button className="btn btn-abort" data-testid="abort-btn" onClick={() => void abort()}>
            ■ Stop
          </button>
        ) : null}
        <SendButton
          mode={mode}
          setMode={(m: SendMode) => setMode(m)}
          onMain={doSend}
          disabled={!text.trim() && images.length === 0}
          isStreaming={isStreaming}
        />
      </div>
      <div className="composer-controls" data-testid="composer-controls">
        <div className="tools-left">
          <ModelPicker />
          <ThinkingPicker />
          <OptionsPopover />
        </div>
        <div className="spacer" />
        <div className="tools-right">
          <button
            className="btn btn-tool"
            data-testid="compact-btn"
            onClick={() => void compact()}
            disabled={isStreaming}
            title="Compact the conversation context"
          >
            <span className="btn-ico">⏏</span>
            <span className="btn-lbl">Compact</span>
          </button>
          <button
            className="btn btn-tool"
            data-testid="fork-btn"
            onClick={() => void forkSession()}
            disabled={isStreaming}
            title="Fork the conversation at the last user message into a new session"
          >
            <span className="btn-ico">⑂</span>
            <span className="btn-lbl">Fork</span>
          </button>
          <button
            className="btn btn-tool"
            data-testid="new-session"
            onClick={() => void newSession()}
            title="Start a new session"
          >
            <span className="btn-ico">＋</span>
            <span className="btn-lbl">New</span>
          </button>
        </div>
      </div>
      </div>
    </div>
  );
}

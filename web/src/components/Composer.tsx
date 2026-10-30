import { useRef, useState } from "react";
import { usePiStore, type SendMode } from "../store/store";
import ModelPicker from "./ModelPicker";
import SendButton from "./SendButton";

interface PendingImage {
  data: string; // base64 without data: prefix
  mimeType: string;
  name: string;
}

export default function Composer() {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<SendMode>("auto");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const send = usePiStore((s) => s.sendImages);
  const abort = usePiStore((s) => s.abort);
  const isStreaming = usePiStore((s) => s.isStreaming);
  const queue = usePiStore((s) => s.queue);
  const commands = usePiStore((s) => s.commands);
  const compact = usePiStore((s) => s.compact);
  const newSession = usePiStore((s) => s.newSession);
  const thinkingLevel = usePiStore((s) => s.thinkingLevel);
  const thinkingLevels = usePiStore((s) => s.thinkingLevels);
  const setThinkingLevel = usePiStore((s) => s.setThinkingLevel);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const slashQuery = /^\//.test(text) && !text.includes(" ") ? text.slice(1).toLowerCase() : null;
  const matches = slashQuery !== null
    ? commands.filter((c) => c.name.toLowerCase().includes(slashQuery)).slice(0, 8)
    : [];

  const doSend = () => {
    const t = text.trim();
    if (!t && images.length === 0) return;
    setText("");
    setImages([]);
    setHighlightIndex(0);
    if (taRef.current) taRef.current.style.height = "auto";
    void send(t, images.map((img) => ({ data: img.data, mimeType: img.mimeType })), mode);
  };

  const applySlashCommand = (name: string) => {
    setText(`/${name} `);
    taRef.current?.focus();
  };

  const addFiles = async (files: FileList | File[]) => {
    const added: PendingImage[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result);
          resolve(result.slice(result.indexOf(",") + 1));
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      added.push({ data, mimeType: file.type, name: file.name });
    }
    if (added.length) setImages((prev) => [...prev, ...added]);
  };

  const queuedCount = queue.steering.length + queue.followUp.length;

  return (
    <div className="composer" data-testid="composer">
      {matches.length > 0 ? (
        <div className="slash-menu" data-testid="slash-menu">
          {matches.map((c, i) => (
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
          placeholder="Message pi… (/ for commands)"
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setHighlightIndex(0);
            e.target.style.height = "auto";
            e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
            if (files.length > 0) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (matches.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlightIndex((i) => Math.min(i + 1, matches.length - 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlightIndex((i) => Math.max(i - 1, 0));
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                applySlashCommand(matches[highlightIndex].name);
                return;
              }
              if (e.key === "Escape") {
                setText("");
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
        <ModelPicker />
        <select
          className="select"
          data-testid="thinking-select"
          value={thinkingLevel}
          onChange={(e) => void setThinkingLevel(e.target.value)}
          title="Thinking level"
        >
          {thinkingLevels.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <div className="spacer" />
        <button
          className="btn"
          data-testid="compact-btn"
          onClick={() => void compact()}
          disabled={isStreaming}
          title="Compact the conversation context"
        >
          Compact
        </button>
        <button className="btn" data-testid="new-session" onClick={() => void newSession()} title="Start a new session">
          + New
        </button>
      </div>
    </div>
  );
}

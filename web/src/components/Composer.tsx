import { useRef, useState } from "react";
import { usePiStore, type SendMode } from "../store/store";

export default function Composer() {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<SendMode>("auto");
  const send = usePiStore((s) => s.send);
  const abort = usePiStore((s) => s.abort);
  const isStreaming = usePiStore((s) => s.isStreaming);
  const queue = usePiStore((s) => s.queue);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const doSend = () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    if (taRef.current) taRef.current.style.height = "auto";
    void send(t, mode);
  };

  const queuedCount = queue.steering.length + queue.followUp.length;

  return (
    <div className="composer" data-testid="composer">
      {queuedCount > 0 ? (
        <div className="queue-note" data-testid="queue-note">
          {queuedCount} queued message{queuedCount > 1 ? "s" : ""}
        </div>
      ) : null}
      <div className="composer-row">
        {isStreaming ? (
          <select
            className="select"
            data-testid="send-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as SendMode)}
            title="How to deliver messages while the agent is running"
          >
            <option value="steer">Steer</option>
            <option value="followUp">Follow-up</option>
          </select>
        ) : null}
        <textarea
          ref={taRef}
          data-testid="composer-input"
          className="composer-input"
          placeholder="Message pi… (/ for commands)"
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
          }}
          onKeyDown={(e) => {
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
        ) : (
          <button className="btn btn-send" data-testid="send-btn" onClick={doSend} disabled={!text.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}

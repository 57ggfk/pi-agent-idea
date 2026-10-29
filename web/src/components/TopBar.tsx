import { usePiStore } from "../store/store";

export default function TopBar() {
  const model = usePiStore((s) => s.model);
  const models = usePiStore((s) => s.models);
  const setModel = usePiStore((s) => s.setModel);
  const thinkingLevel = usePiStore((s) => s.thinkingLevel);
  const thinkingLevels = usePiStore((s) => s.thinkingLevels);
  const setThinkingLevel = usePiStore((s) => s.setThinkingLevel);
  const newSession = usePiStore((s) => s.newSession);
  const compact = usePiStore((s) => s.compact);
  const sessionName = usePiStore((s) => s.sessionName);
  const isStreaming = usePiStore((s) => s.isStreaming);

  return (
    <div className="topbar" data-testid="topbar">
      <select
        className="select"
        data-testid="model-select"
        value={model ? `${model.provider}/${model.id}` : ""}
        onChange={(e) => {
          const [provider, id] = e.target.value.split("/");
          void setModel(provider, id);
        }}
        title="Model"
      >
        {models.map((m) => (
          <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
            {m.name ?? m.id}
          </option>
        ))}
        {models.length === 0 && model ? (
          <option value={`${model.provider}/${model.id}`}>{model.name ?? model.id}</option>
        ) : null}
      </select>

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

      {sessionName ? <span className="session-badge">{sessionName}</span> : null}

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
  );
}

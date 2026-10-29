import { useCallback, useEffect, useState } from "react";
import { OutcomeBanner } from "../ManageView";
import type { manageApi, McpListResult } from "../../manage";

export default function McpPanel({ api }: { api: ReturnType<typeof manageApi> }) {
  const [result, setResult] = useState<McpListResult | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; error?: string; output?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", command: "", args: "", url: "" });

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setResult(await api.mcpList());
    } catch (e) {
      setOutcome({ ok: false, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const servers = result?.raw?.servers ?? [];

  const act = async (action: Promise<{ ok: boolean; error?: string; output?: string }>) => {
    setBusy(true);
    setOutcome(null);
    try {
      const res = await action;
      setOutcome(res);
      await refresh();
    } catch (e) {
      setOutcome({ ok: false, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!form.name.trim()) return;
    const payload: Record<string, unknown> = { name: form.name.trim() };
    if (form.url.trim()) {
      payload["url"] = form.url.trim();
    } else if (form.command.trim()) {
      payload["command"] = form.command.trim();
      payload["args"] = form.args.trim() ? form.args.trim().split(/\s+/) : [];
    } else {
      return;
    }
    await act(api.mcpAdd(payload as { name: string }));
    setShowForm(false);
    setForm({ name: "", command: "", args: "", url: "" });
  };

  return (
    <div data-testid="mcp-panel">
      <OutcomeBanner outcome={outcome} />
      <div className="panel-toolbar">
        <button className="btn" data-testid="mcp-refresh" onClick={() => void refresh()} disabled={busy}>
          Refresh
        </button>
        <button className="btn" data-testid="mcp-add-toggle" onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Cancel" : "+ Add server"}
        </button>
      </div>

      {showForm ? (
        <div className="panel-form" data-testid="mcp-add-form">
          <input
            className="select"
            placeholder="name (letters, digits, _ -)"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            className="select"
            placeholder="command (stdio), e.g. npx"
            value={form.command}
            onChange={(e) => setForm({ ...form, command: e.target.value })}
          />
          <input
            className="select"
            placeholder="args (space separated)"
            value={form.args}
            onChange={(e) => setForm({ ...form, args: e.target.value })}
          />
          <input
            className="select"
            placeholder="or URL (streamable HTTP)"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
          />
          <button className="btn btn-send" data-testid="mcp-add-submit" onClick={() => void submit()}>
            Add
          </button>
        </div>
      ) : null}

      {servers.length === 0 && !showForm ? (
        <div className="panel-empty" data-testid="mcp-empty">
          No MCP servers configured.
        </div>
      ) : null}

      {servers.map((s, i) => {
        const name = String(s.name ?? `server-${i}`);
        return (
          <div className="panel-row" key={name + i} data-testid="mcp-server-row">
            <div className="panel-row-main">
              <span className="panel-row-title">{name}</span>
              <span className="panel-row-sub">
                {s.state ? String(s.state) : ""}
                {typeof s["toolCount"] === "number" ? ` · ${s["toolCount"]} tools` : ""}
                {s.enabled === false ? " · disabled" : ""}
              </span>
            </div>
            <div className="panel-row-actions">
              <button className="btn" onClick={() => void act(api.mcpLogin({ name }))} title="OAuth sign-in">
                Login
              </button>
              <button className="btn" onClick={() => void act(api.mcpLogout({ name }))}>
                Logout
              </button>
              <button
                className="btn btn-abort"
                data-testid={`mcp-remove-${name}`}
                onClick={() => void act(api.mcpRemove({ name }))}
              >
                Remove
              </button>
            </div>
          </div>
        );
      })}

      {result?.text ? <pre className="panel-raw">{result.text}</pre> : null}
    </div>
  );
}

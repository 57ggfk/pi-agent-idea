import { useCallback, useEffect, useState } from "react";
import { OutcomeBanner } from "../ManageView";
import type { manageApi, McpListResult } from "../../manage";

export default function McpPanel({ api }: { api: ReturnType<typeof manageApi> }) {
  const [result, setResult] = useState<McpListResult | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; error?: string; output?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
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
    setNotice(null);
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

  /**
   * Toggles a server without touching its configuration.
   *
   * Two things the UI must not hide: a project override can keep the server
   * running after a user-level disable, and a server that is already connected
   * stays connected until the session restarts (spec 001 FR-004).
   */
  const toggle = async (args: {
    name: string;
    scope: string;
    enabled: boolean;
    wasConnected: boolean;
  }) => {
    setBusy(true);
    setOutcome(null);
    setNotice(null);
    try {
      const res = await api.mcpSetEnabled({
        name: args.name,
        scope: args.scope,
        enabled: args.enabled,
      });
      if (!res.ok) {
        setOutcome({ ok: false, error: res.error || "could not change the server state" });
      } else if (res.warning) {
        setNotice(res.warning);
      } else if (!args.enabled && args.wasConnected) {
        setNotice(
          `"${args.name}" is off from the next session on. This session stays connected to it.`,
        );
      }
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
      {notice ? (
        <div className="panel-note" data-testid="mcp-notice">
          {notice}
        </div>
      ) : null}
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
        const enabled = s.enabled !== false;
        // pi calls the user-level file "global"; the badge says "user" because
        // that is the layer the spec talks about. The value sent back to the
        // bridge stays pi's own word — that is what PiMcpConfig accepts, and
        // translating it on the way out made every write fail as "unknown scope".
        const scope = s.scope === "project" ? "project" : "global";
        const scopeLabel = scope === "project" ? "project" : "user";
        return (
          <div
            className={`panel-row ${enabled ? "" : "mcp-row-disabled"}`}
            key={name + i}
            data-testid="mcp-server-row"
            data-enabled={enabled ? "true" : "false"}
          >
            <div className="panel-row-main">
              <span className="panel-row-title">
                {name}
                <span
                  className="scope-tag"
                  data-testid={`mcp-scope-${name}`}
                  data-inert="false"
                  title={
                    scope === "project"
                      ? "Defined in this project's .pi/mcp.json"
                      : "Defined in the user-level mcp.json"
                  }
                >
                  {scopeLabel}
                </span>
              </span>
              <span className="panel-row-sub">
                {enabled
                  ? [s.state ? String(s.state) : "", typeof s["toolCount"] === "number" ? `${s["toolCount"]} tools` : ""]
                      .filter(Boolean)
                      .join(" · ")
                  : "disabled · configuration kept"}
                {s.override ? " · overridden in this project" : ""}
              </span>
            </div>
            <div className="panel-row-actions">
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={`${enabled ? "Disable" : "Enable"} ${name}`}
                className={`btn mcp-toggle ${enabled ? "mcp-toggle-on" : "mcp-toggle-off"}`}
                data-testid={`mcp-toggle-${name}`}
                disabled={busy}
                onClick={() => void toggle({ name, scope, enabled: !enabled, wasConnected: s.state === "connected" })}
              >
                {enabled ? "Enabled" : "Disabled"}
              </button>
              <button
                className="btn"
                onClick={() => void act(api.mcpLogin({ name }))}
                title="OAuth sign-in"
                disabled={!enabled}
              >
                Login
              </button>
              <button className="btn" onClick={() => void act(api.mcpLogout({ name }))} disabled={!enabled}>
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
      {result?.raw?.note ? (
        <div className="panel-note" data-testid="mcp-note">
          {result.raw.note}
        </div>
      ) : null}
    </div>
  );
}

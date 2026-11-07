import { useCallback, useEffect, useState } from "react";
import { useT } from "../../i18n/useT";
import { OutcomeBanner } from "../ManageView";
import type { CliOutcome, manageApi, PackagesListResult } from "../../manage";

export default function PackagesPanel({ api }: { api: ReturnType<typeof manageApi> }) {
  const { t } = useT();
  const [result, setResult] = useState<PackagesListResult | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; error?: string; output?: string } | null>(null);
  const [updateResult, setUpdateResult] = useState<CliOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState("");

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setResult(await api.packagesList());
    } catch (e) {
      setOutcome({ ok: false, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const lines = result?.lines ?? [];
  const installed = lines.filter(
    (l) => l.startsWith("npm:") || l.startsWith("git:") || l.startsWith("http") || /^[~./]/.test(l),
  );

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

  /**
   * `pi update <source>` — the CLI reports the outcome in its own output, so
   * the raw text is shown verbatim (spec 001 FR-007); the plugin does not
   * diff install state to decide whether anything actually changed.
   */
  const update = async (pkg: string) => {
    setBusy(true);
    setOutcome(null);
    setUpdateResult(null);
    try {
      const res = await api.packageUpdate({ source: pkg });
      setUpdateResult(res);
      await refresh();
    } catch (e) {
      setUpdateResult({ ok: false, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="packages-panel">
      <OutcomeBanner outcome={outcome} />
      {updateResult ? (
        <div
          className={`outcome-banner ${updateResult.ok ? "outcome-ok" : "outcome-fail"}`}
          data-testid="update-result"
        >
          {updateResult.ok ? "✓ " : "✗ "}
          {updateResult.exitCode !== undefined ? `exit code ${updateResult.exitCode} · ` : ""}
          {updateResult.output || updateResult.error}
          {!updateResult.ok ? (
            <div>The installed version may still be the old one.</div>
          ) : null}
        </div>
      ) : null}
      <div className="panel-toolbar">
        <input
          className="select packages-input"
          placeholder="npm:@scope/pkg · git:github.com/user/repo · ./local/path"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
        <button
          className="btn btn-send"
          data-testid="package-install"
          disabled={busy || !source.trim()}
          onClick={() => {
            void act(api.packageInstall({ source: source.trim() }));
            setSource("");
          }}
        >
          {t("package.install")}
        </button>
        <button className="btn" data-testid="packages-refresh" onClick={() => void refresh()} disabled={busy}>
          {t("package.refresh")}
        </button>
      </div>

      {installed.length === 0 ? (
        <div className="panel-empty" data-testid="packages-empty">
          {lines.length > 0 ? lines.join("\n") : "No packages installed."}
        </div>
      ) : (
        installed.map((line, i) => {
          const pkg = line.replace(/^[-*]\s*/, "").trim();
          return (
            <div className="panel-row" key={i} data-testid="package-row">
              <div className="panel-row-main">
                <span className="panel-row-title mono">{pkg}</span>
              </div>
              <div className="panel-row-actions">
                <button
                  className="btn"
                  data-testid={`package-update-${i}`}
                  disabled={busy}
                  onClick={() => void update(pkg)}
                >
                  {t("package.update")}
                </button>
                <button className="btn btn-abort" onClick={() => void act(api.packageRemove({ source: pkg }))}>
                  {t("package.remove")}
                </button>
              </div>
            </div>
          );
        })
      )}
      {result?.error ? <pre className="panel-raw">{result.error}</pre> : null}
    </div>
  );
}

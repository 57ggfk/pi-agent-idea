import { useCallback, useEffect, useState } from "react";
import { getBridge } from "../bridge";
import { manageApi, type EnvDetectResult, type ToolStatus } from "../manage";
import { usePiStore } from "../store/store";
import { useT } from "../i18n/useT";

/**
 * First-run setup card.
 *
 * Before this existed, a machine without pi showed "pi process is not running"
 * and nothing else: no hint that a node runtime is required, no way to install
 * pi, no indication of which path the plugin was looking for. The card answers
 * the three questions a first-time user actually has — what do I have, what am
 * I missing, how do I get it — and offers both routes: install through npm
 * (npm's own configured registry by default, the official one, the China
 * mirror, or a URL the user pastes) or point at an existing binary.
 *
 * It hides itself as soon as detection reports a working pi, so it never
 * becomes permanent furniture.
 */
export default function SetupCard() {
  const { t } = useT();
  const [env, setEnv] = useState<EnvDetectResult | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [source, setSource] = useState("default");
  const [customRegistry, setCustomRegistry] = useState("");
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [log, setLog] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const piStatus = usePiStore((s) => s.piStatus);
  const restartPi = usePiStore((s) => s.restartPi);

  // A cold install downloads a large tree; on a slow mirror that is minutes,
  // not seconds. A ticking counter is the difference between "still working"
  // and "hung" — the button alone says nothing while it waits.
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [busy]);

  const detect = useCallback(async () => {
    const api = manageApi(await getBridge());
    const result = await api.envDetect().catch((e: Error) => ({
      ok: false,
      error: e.message,
      needsSetup: false,
    }) as EnvDetectResult);
    setEnv(result);
    if (result.defaultSource) setSource(result.defaultSource);
    if (result.customPath) setManual(result.customPath);
  }, []);

  useEffect(() => {
    void detect();
  }, [detect]);

  const customId = env?.customSource ?? "custom";
  const isCustom = source === customId;
  const customBlank = isCustom && customRegistry.trim() === "";

  const install = async () => {
    if (customBlank) {
      setError(t("setup.errBlank"));
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    setLog("");
    try {
      const api = manageApi(await getBridge());
      // No deadline on this call: npm is stopped by the Stop button, not by a
      // timer. A cold install on a slow mirror legitimately takes a long time.
      const result = await api.envInstall({
        source,
        registry: isCustom ? customRegistry.trim() : undefined,
      });
      setLog(result.output ?? "");
      if (!result.ok) {
        // A stop is the user's own decision: report it, do not shout.
        if (result.cancelled) setNotice(result.error ?? t("setup.noticeStopped"));
        else setError(result.error ?? "install failed");
        return;
      }
      await restartPi();
      setEnv((prev) => (prev ? { ...prev, needsSetup: false } : prev));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setStopping(true);
    try {
      const api = manageApi(await getBridge());
      const result = await api.envCancelInstall();
      if (!result.ok) setError(result.error ?? "nothing to stop");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStopping(false);
    }
  };

  const useManual = async () => {
    setBusy(true);
    setError("");
    try {
      const api = manageApi(await getBridge());
      const result = await api.envSetPath({ path: manual.trim() });
      if (!result.ok) {
        setError(result.error ?? "pi could not be started from that path");
        return;
      }
      await restartPi();
      setEnv((prev) => (prev ? { ...prev, needsSetup: false } : prev));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (dismissed || !env?.needsSetup || piStatus === "running") return null;

  return (
    <div className="setup-card" data-testid="setup-card">
      <div className="setup-head">
        <div className="setup-title">{t("setup.title")}</div>
        <button className="setup-dismiss" onClick={() => setDismissed(true)} title={t("setup.laterHint")}>
          {t("setup.later")}
        </button>
      </div>
      <div className="setup-sub">
        {t("setup.subPrefix")} <span className="mono">{env.piPackage}</span> {t("setup.subSuffix")}
      </div>

      <div className="setup-tools">
        <ToolRow label="Node.js" tool={env.node} hint={t("setup.nodeHint", { min: env.minNodeMajor ?? 18 })} />
        <ToolRow label="npm" tool={env.npm} hint={t("setup.npmHint")} />
        <ToolRow label="pi" tool={env.pi} hint={t("setup.piHint")} />
      </div>

      {!env.nodeOk ? (
        <div className="setup-warn" data-testid="setup-node-warning">
          {t("setup.nodeWarn1", { min: env.minNodeMajor ?? 18 })}{" "}
          <a href="https://nodejs.org/en/download" target="_blank" rel="noreferrer">
            nodejs.org
          </a>{" "}
          {t("setup.nodeWarnMid")}{" "}
          <a href="https://npmmirror.com/mirrors/node/" target="_blank" rel="noreferrer">
            {t("setup.nodeWarnMirror")}
          </a>
          , {t("setup.nodeWarnEnd")}
        </div>
      ) : null}

      {env.canInstall ? (
        <div className="setup-block">
          <div className="setup-label">{t("setup.installLabel")}</div>
          <div className="setup-sources">
            {(env.sources ?? []).map((s) => (
              <label
                key={s.id}
                className={`setup-source ${source === s.id ? "setup-source-on" : ""}`}
                data-testid={`setup-source-${s.id}`}
              >
                <input
                  type="radio"
                  name="setup-source"
                  value={s.id}
                  checked={source === s.id}
                  onChange={() => setSource(s.id)}
                  disabled={busy}
                />
                <span>{sourceLabel(s.id, t)}</span>
                <span className="mono setup-registry">
                  {s.registry || env.npmRegistry || "from npm config"}
                </span>
              </label>
            ))}
            <label
              className={`setup-source ${isCustom ? "setup-source-on" : ""}`}
              data-testid="setup-source-custom"
            >
              <input
                type="radio"
                name="setup-source"
                value={customId}
                checked={isCustom}
                onChange={() => setSource(customId)}
                disabled={busy}
              />
              <span>{t("setup.custom")}</span>
            </label>
          </div>
          {isCustom ? (
            <div className="setup-custom">
              <input
                className="setup-input"
                data-testid="setup-registry-input"
                value={customRegistry}
                placeholder="https://registry.example.com"
                onChange={(e) => setCustomRegistry(e.target.value)}
                disabled={busy}
                spellCheck={false}
              />
              <div className="setup-hint">{t("setup.customHint")}</div>
            </div>
          ) : null}
          <div className="setup-actions">
            <button
              className="btn"
              data-testid="setup-install"
              onClick={install}
              disabled={busy || customBlank}
            >
              {busy
                ? t("setup.installing", { seconds: elapsed })
                : t("setup.install", { pkg: env.piPackage ?? "" })}
            </button>
            {busy ? (
              <button
                className="btn setup-stop"
                data-testid="setup-cancel"
                onClick={cancel}
                disabled={stopping}
                title={t("setup.stopHint")}
              >
                {stopping ? t("setup.stopping") : t("setup.stop")}
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="setup-warn" data-testid="setup-no-npm">
          {t("setup.noNpm")}
        </div>
      )}

      <div className="setup-block">
        <div className="setup-label">{t("setup.manualLabel")}</div>
        <div className="setup-manual">
          <input
            className="setup-input"
            data-testid="setup-path-input"
            value={manual}
            placeholder={navigator.platform.startsWith("Win") ? "C:\\Users\\you\\AppData\\Roaming\\npm\\pi.cmd" : "/usr/local/bin/pi"}
            onChange={(e) => setManual(e.target.value)}
            disabled={busy}
          />
          <button className="btn" data-testid="setup-path-save" onClick={useManual} disabled={busy || manual.trim() === ""}>
            {t("setup.usePath")}
          </button>
        </div>
      </div>

      {notice ? (
        <div className="setup-notice" data-testid="setup-notice">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="setup-error" data-testid="setup-error">
          {error}
        </div>
      ) : null}
      {log ? (
        <pre className="setup-log" data-testid="setup-log">
          {log}
        </pre>
      ) : null}
    </div>
  );
}

function sourceLabel(
  id: string,
  t: (key: "setup.source.default" | "setup.source.china" | "setup.source.official") => string,
): string {
  switch (id) {
    case "default":
      return t("setup.source.default");
    case "china":
      return t("setup.source.china");
    case "official":
      return t("setup.source.official");
    default:
      return id;
  }
}

function ToolRow({ label, tool, hint }: { label: string; tool?: ToolStatus; hint: string }) {
  const { t } = useT();
  const found = Boolean(tool?.found);
  return (
    <div className={`setup-tool ${found ? "setup-tool-ok" : "setup-tool-missing"}`}>
      <span className="setup-tool-mark">{found ? "✓" : "✕"}</span>
      <span className="setup-tool-name">{label}</span>
      <span className="setup-tool-version mono">{found ? tool?.version || "?" : t("setup.notFound")}</span>
      <span className="setup-tool-path mono" title={tool?.path || hint}>
        {found ? tool?.path : hint}
      </span>
    </div>
  );
}

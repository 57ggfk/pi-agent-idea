import { useCallback, useEffect, useState } from "react";
import { useT } from "../../i18n/useT";
import { usePiStore } from "../../store/store";
import { OutcomeBanner } from "../ManageView";
import MarketplacePanel from "./MarketplacePanel";
import type {
  CliOutcome,
  manageApi,
  PackageCheckResult,
  PackageEntry,
  PackagesListResult,
} from "../../manage";
import type { TFunction } from "i18next";

/**
 * Package management, rebuilt on the structured contract (033): an operable
 * list with versions, status and per-row check / upgrade / reinstall actions,
 * plus the official-marketplace tab. The upgrade path is a version-pinned
 * install — pi 1.5.0's `pi update <source>` is broken for every notation
 * (spec 033 evidence P8), so this panel never calls it.
 *
 * History: install / per-row update+remove came with 001; 018 added
 * "update all", remove confirmation and i18n; 033 reworked the list onto
 * `pi list` parsing, the registry chain, version checks and the marketplace.
 */

/** Registries offered as one-click presets (mirrors PiEnvironment.SOURCES). */
export const OFFICIAL_REGISTRY = "https://registry.npmjs.org";
export const CHINA_REGISTRY = "https://registry.npmmirror.com";

type RegistryMode = "follow" | "official" | "china" | "custom";

/** npm name out of a source string — the TS twin of PiPackages.npmName. */
export function npmNameOf(source: string): string | null {
  if (!source.startsWith("npm:")) return null;
  const spec = source.slice(4).trim();
  if (!spec) return null;
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    if (slash < 0) return spec;
    const rest = spec.slice(slash + 1);
    const at = rest.indexOf("@");
    return at > 0 && /^[\w.+-]+$/.test(rest.slice(at + 1))
      ? spec.slice(0, slash + 1) + rest.slice(0, at)
      : spec;
  }
  const at = spec.indexOf("@");
  return at > 0 && /^[\w.+-]+$/.test(spec.slice(at + 1)) ? spec.slice(0, at) : spec;
}

/**
 * Loose registry-URL vetting (the TS twin of PiEnvironment.normalizeCustomRegistry):
 * bare hosts get https (http for loopback), anything with a scheme other than
 * http(s), whitespace or credentials is refused.
 */
export function normalizeRegistryInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: string;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    url = trimmed;
  } else if (trimmed.includes("://")) {
    return null;
  } else {
    const host = trimmed.split("/")[0];
    const loopback = host.startsWith("localhost") || host.startsWith("127.") || host.startsWith("[::1]");
    url = `${loopback ? "http" : "https"}://${trimmed}`;
  }
  const body = url.slice(url.indexOf("://") + 3);
  const host = body.split("/")[0];
  if (/\s/.test(body) || host.includes("@")) return null;
  if (!host.includes(".") && !host.includes(":")) return null;
  return url.replace(/\/+$/, "");
}

interface CheckState {
  loading?: boolean;
  result?: PackageCheckResult | null;
}

export default function PackagesPanel({ api }: { api: ReturnType<typeof manageApi> }) {
  const { t } = useT();
  const askConfirm = usePiStore((s) => s.askConfirm);
  const [tab, setTab] = useState<"installed" | "market">("installed");
  const [result, setResult] = useState<PackagesListResult | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; error?: string; output?: string } | null>(null);
  const [updateResult, setUpdateResult] = useState<CliOutcome | null>(null);
  const [upgradeStale, setUpgradeStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState("");
  const [checks, setChecks] = useState<Record<number, CheckState>>({});
  // null = follow npm config (FR-016); a URL = explicit override.
  const [registry, setRegistry] = useState<string | null>(null);
  const [registryLoaded, setRegistryLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .prefsGet()
      .then((prefs) => {
        if (!alive) return;
        if (prefs.registryOverride) setRegistry(prefs.registryOverride);
        setRegistryLoaded(true);
      })
      .catch(() => setRegistryLoaded(true));
    return () => {
      alive = false;
    };
  }, [api]);

  const refresh = useCallback(async (): Promise<PackagesListResult | null> => {
    setBusy(true);
    try {
      const res = await api.packagesList();
      setResult(res);
      return res;
    } catch (e) {
      setOutcome({ ok: false, error: (e as Error).message });
      return null;
    } finally {
      setBusy(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const entries = result?.entries ?? [];
  const installedNames = new Set(
    entries.map((e) => npmNameOf(e.source)).filter((n): n is string => n !== null),
  );

  /** Runs a CLI action, shows its verbatim output, then refreshes the list. */
  const act = async (action: Promise<CliOutcome>) => {
    setBusy(true);
    setOutcome(null);
    setUpdateResult(null);
    setUpgradeStale(false);
    try {
      const res = await action;
      setUpdateResult(res);
      await refresh();
    } catch (e) {
      setUpdateResult({ ok: false, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const changeRegistry = (mode: RegistryMode, customText: string) => {
    const next =
      mode === "follow"
        ? null
        : mode === "official"
          ? OFFICIAL_REGISTRY
          : mode === "china"
            ? CHINA_REGISTRY
            : normalizeRegistryInput(customText);
    if (mode === "custom" && next === null) return; // invalid paste: keep the old value
    setRegistry(next);
    void api.prefsSet({ registryOverride: next }).catch(() => undefined);
  };

  const check = async (entry: PackageEntry, index: number) => {
    setChecks((c) => ({ ...c, [index]: { loading: true } }));
    try {
      const res = await api.packageCheck({ source: entry.source, registry: registry ?? undefined });
      setChecks((c) => ({ ...c, [index]: { result: res } }));
    } catch {
      setChecks((c) => ({ ...c, [index]: { result: { ok: false, state: "unknown", reason: "offline" } } }));
    }
  };

  /**
   * The upgrade itself is `pi install npm:<name>@<latest>` (033 FR-004). After
   * it reports success the list is re-read and the version verified — the
   * lock-file no-op trap (probe P9) must not pass silently.
   */
  const upgrade = async (entry: PackageEntry, index: number) => {
    const checkState = checks[index]?.result;
    if (!checkState?.latest) return;
    const name = npmNameOf(entry.source);
    if (!name) return;
    setBusy(true);
    setOutcome(null);
    setUpdateResult(null);
    setUpgradeStale(false);
    try {
      const res = await api.packageInstall({
        source: `npm:${name}@${checkState.latest}`,
        registry: registry ?? undefined,
      });
      setUpdateResult(res);
      const fresh = res.ok ? await refresh() : null;
      if (res.ok && fresh) {
        const row = fresh.entries?.find((e) => npmNameOf(e.source) === name);
        if (row?.version !== checkState.latest) setUpgradeStale(true);
      }
    } catch (e) {
      setUpdateResult({ ok: false, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="packages-panel">
      <div className="panel-tabs" data-testid="packages-tabs">
        <button
          className={`panel-tab ${tab === "installed" ? "panel-tab-on" : ""}`}
          data-testid="packages-tab-installed"
          onClick={() => setTab("installed")}
        >
          {t("package.tabInstalled")}
        </button>
        <button
          className={`panel-tab ${tab === "market" ? "panel-tab-on" : ""}`}
          data-testid="packages-tab-market"
          onClick={() => setTab("market")}
        >
          {t("package.tabMarket")}
        </button>
      </div>

      {tab === "market" ? (
        <MarketplacePanel
          api={api}
          registry={registry}
          installedNames={installedNames}
          onInstallDone={() => void refresh()}
          busy={busy}
          setBusy={setBusy}
          setOutcome={setOutcome}
        />
      ) : (
        <>
          <RegistryPref
            t={t}
            registry={registry}
            registryLoaded={registryLoaded}
            onChange={changeRegistry}
            busy={busy}
          />

          <OutcomeBanner outcome={outcome} />
          {updateResult ? (
            <div
              className={`outcome-banner ${updateResult.ok ? "outcome-ok" : "outcome-fail"}`}
              data-testid="update-result"
            >
              <span data-testid="update-result-headline">
                {updateResult.ok ? "✓ " : "✗ "}
                {updateResult.ok
                  ? t("package.actionDone")
                  : updateResult.error?.includes("offline") || updateResult.output?.includes("offline")
                    ? t("package.offline")
                    : t("package.actionFailed")}
              </span>
              {upgradeStale ? <div data-testid="upgrade-stale">{t("package.upgradeStale")}</div> : null}
              {updateResult.output || updateResult.error ? (
                <details className="cli-details" data-testid="cli-details">
                  <summary>{t("package.details")}</summary>
                  <pre>{updateResult.output || updateResult.error}</pre>
                </details>
              ) : null}
            </div>
          ) : null}

          <div className="panel-toolbar">
            <input
              className="select packages-input"
              placeholder={t("package.placeholder")}
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
            <button
              className="btn btn-send"
              data-testid="package-install"
              disabled={busy || !source.trim()}
              onClick={() => {
                void act(api.packageInstall({ source: source.trim(), registry: registry ?? undefined }));
                setSource("");
              }}
            >
              {t("package.install")}
            </button>
            <button
              className="btn"
              data-testid="packages-update-all"
              disabled={busy || entries.length === 0}
              onClick={() => void act(api.packageUpdateAll({ registry: registry ?? undefined }))}
            >
              {t("package.updateAll")}
            </button>
            <button className="btn" data-testid="packages-refresh" onClick={() => void refresh()} disabled={busy}>
              {t("package.refresh")}
            </button>
          </div>

          {entries.length === 0 ? (
            <div className="panel-empty" data-testid="packages-empty">
              {result?.error ? result.error : t("package.empty")}
            </div>
          ) : (
            entries.map((entry, i) => (
              <PackageRow
                key={`${entry.source}-${i}`}
                t={t}
                entry={entry}
                index={i}
                busy={busy}
                checkState={checks[i]}
                onCheck={() => void check(entry, i)}
                onUpgrade={() => void upgrade(entry, i)}
                onReinstall={() =>
                  void act(api.packageInstall({ source: entry.source, registry: registry ?? undefined }))
                }
                onRemove={() =>
                  askConfirm({
                    title: t("package.removeTitle"),
                    message: t("package.removeMessage", { pkg: entry.source }),
                    confirmLabel: t("package.remove"),
                    danger: true,
                    onConfirm: () => {
                      void act(api.packageRemove({ source: entry.source }));
                    },
                  })
                }
              />
            ))
          )}
        </>
      )}
    </div>
  );
}

function checkReasonText(t: TFunction, reason: string): string {
  switch (reason) {
    case "offline":
      return t("package.checkOffline");
    case "auth":
      return t("package.checkAuth");
    case "not-found":
      return t("package.checkNotFound");
    case "bad-response":
      return t("package.checkBadResponse");
    case "git-ref":
      return t("package.checkGitRef");
    case "local":
      return t("package.checkLocal");
    default:
      return t("package.checkBadResponse");
  }
}

function PackageRow({
  t,
  entry,
  index,
  busy,
  checkState,
  onCheck,
  onUpgrade,
  onReinstall,
  onRemove,
}: {
  t: TFunction;
  entry: PackageEntry;
  index: number;
  busy: boolean;
  checkState?: CheckState;
  onCheck: () => void;
  onUpgrade: () => void;
  onReinstall: () => void;
  onRemove: () => void;
}) {
  const checkResult = checkState?.result;
  const upgradable = checkResult?.state === "upgradable" && !!checkResult.latest;
  return (
    <div className="panel-row package-row" data-testid="package-row">
      <div className="panel-row-main">
        <span className="panel-row-title mono">{entry.source}</span>
        <span className="panel-row-sub package-row-sub">
          <span className="pkg-version mono" data-testid={`package-version-${index}`}>
            {entry.version ? `v${entry.version}` : t("package.versionUnknown")}
          </span>
          <span className="pkg-scope">
            {entry.scope === "project" ? t("package.scopeProject") : t("package.scopeUser")}
          </span>
          {entry.broken ? (
            <span className="pkg-status-broken" data-testid={`package-broken-${index}`}>
              {t("package.statusBroken")}
            </span>
          ) : null}
          {checkState?.loading ? (
            <span data-testid={`package-checking-${index}`}>{t("package.checking")}</span>
          ) : null}
          {checkResult ? (
            <span className="pkg-check" data-testid={`package-check-verdict-${index}`}>
              {checkResult.state === "up-to-date"
                ? t("package.upToDate", { latest: checkResult.latest ?? "" })
                : checkResult.state === "upgradable"
                  ? t("package.upgradable", {
                      from: checkResult.installed ?? t("package.versionUnknown"),
                      to: checkResult.latest ?? "",
                    })
                  : checkReasonText(t, checkResult.reason ?? "")}
            </span>
          ) : null}
        </span>
      </div>
      <div className="panel-row-actions">
        {!entry.broken ? (
          <>
            <button className="btn" data-testid={`package-check-${index}`} disabled={busy} onClick={onCheck}>
              {t("package.check")}
            </button>
            <button
              className="btn"
              data-testid={`package-upgrade-${index}`}
              disabled={busy || !upgradable}
              onClick={onUpgrade}
            >
              {t("package.upgrade")}
            </button>
          </>
        ) : (
          <button className="btn" data-testid={`package-reinstall-${index}`} disabled={busy} onClick={onReinstall}>
            {t("package.reinstall")}
          </button>
        )}
        <button className="btn btn-abort" data-testid={`package-remove-${index}`} disabled={busy} onClick={onRemove}>
          {t("package.remove")}
        </button>
      </div>
    </div>
  );
}

function RegistryPref({
  t,
  registry,
  registryLoaded,
  onChange,
  busy,
}: {
  t: TFunction;
  registry: string | null;
  registryLoaded: boolean;
  onChange: (mode: RegistryMode, customText: string) => void;
  busy: boolean;
}) {
  const [customText, setCustomText] = useState(
    registry && registry !== OFFICIAL_REGISTRY && registry !== CHINA_REGISTRY ? registry : "",
  );
  const [invalid, setInvalid] = useState(false);
  const mode: RegistryMode =
    registry == null
      ? "follow"
      : registry === OFFICIAL_REGISTRY
        ? "official"
        : registry === CHINA_REGISTRY
          ? "china"
          : "custom";

  const pick = (next: RegistryMode) => {
    setInvalid(false);
    if (next === "custom" && !normalizeRegistryInput(customText)) {
      setInvalid(customText.trim().length > 0);
      return;
    }
    onChange(next, customText);
  };

  return (
    <div className="package-registry" data-testid="package-registry">
      <span className="package-registry-title">{t("package.registryTitle")}</span>
      <label className="package-registry-option">
        <input
          type="radio"
          name="package-registry"
          data-testid="package-registry-follow"
          checked={registryLoaded && mode === "follow"}
          disabled={busy}
          onChange={() => pick("follow")}
        />
        <span>{t("package.registryFollow")}</span>
      </label>
      <label className="package-registry-option">
        <input
          type="radio"
          name="package-registry"
          data-testid="package-registry-official"
          checked={mode === "official"}
          disabled={busy}
          onChange={() => pick("official")}
        />
        <span className="mono">{OFFICIAL_REGISTRY}</span>
      </label>
      <label className="package-registry-option">
        <input
          type="radio"
          name="package-registry"
          data-testid="package-registry-china"
          checked={mode === "china"}
          disabled={busy}
          onChange={() => pick("china")}
        />
        <span className="mono">{CHINA_REGISTRY}</span>
      </label>
      <label className="package-registry-option">
        <input
          type="radio"
          name="package-registry"
          data-testid="package-registry-custom"
          checked={mode === "custom"}
          disabled={busy}
          onChange={() => pick("custom")}
        />
        <span>{t("package.registryCustom")}</span>
      </label>
      <input
        className="select package-registry-input"
        data-testid="package-registry-custom-input"
        placeholder={t("package.registryCustomPlaceholder")}
        value={customText}
        disabled={busy}
        onChange={(e) => setCustomText(e.target.value)}
        onBlur={() => mode === "custom" && pick("custom")}
        onKeyDown={(e) => {
          if (e.key === "Enter" && mode === "custom") pick("custom");
        }}
      />
      {invalid ? (
        <span className="pkg-status-broken" data-testid="package-registry-invalid">
          {t("package.registryInvalid")}
        </span>
      ) : null}
    </div>
  );
}

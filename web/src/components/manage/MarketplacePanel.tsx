import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/useT";
import { usePiStore } from "../../store/store";
import { formatNumber, formatRelativeDay } from "../../i18n/format";
import { ProgressLine } from "./PackagesPanel";
import type { manageApi, MarketPackage, MarketSearchResult } from "../../manage";
import type { TFunction } from "i18next";

/**
 * The official-marketplace tab (033 US4): the pi.dev/packages gallery, fed by
 * the same source npm's registry search API (`keywords:pi-package`) — never
 * scraped. Browsing degrades per registry (npmmirror answers plain-text
 * matching; some Nexus setups have no search endpoint at all), and every
 * failure is a fast, friendly one: the panel refuses to work without the
 * preflight the backend runs before each request.
 */

const PAGE_SIZE = 50;

export default function MarketplacePanel({
  api,
  registry,
  installedNames,
  onInstall,
  installingName,
  busy,
}: {
  api: ReturnType<typeof manageApi>;
  /** Explicit registry override; null = follow npm config. */
  registry: string | null;
  /** npm names already installed — those cards show a disabled "installed". */
  installedNames: Set<string>;
  /**
   * One-click install, executed by the parent (single-flight + the shared
   * outcome banner live there); this card renders its own progress while
   * [installingName] matches (033 FR-020).
   */
  onInstall: (pkg: MarketPackage) => void;
  installingName: string | null;
  busy: boolean;
}) {
  const { t, language } = useT();
  const askConfirm = usePiStore((s) => s.askConfirm);
  const [appliedQuery, setAppliedQuery] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<MarketSearchResult | null>(null);
  const [failed, setFailed] = useState<{ code: string; raw?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setFailed(null);
    try {
      const res = await api.marketSearch({
        query: appliedQuery || undefined,
        page,
        pageSize: PAGE_SIZE,
        registry: registry ?? undefined,
      });
      if (seq !== loadSeq.current) return; // a newer load superseded this one
      if (!res.ok) {
        setFailed({ code: res.code ?? "offline", raw: res.error });
        setData(null);
      } else {
        setData(res);
      }
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setFailed({ code: "offline", raw: (e as Error).message });
      setData(null);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [api, appliedQuery, page, registry]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = (nextQuery: string) => {
    setAppliedQuery(nextQuery);
    setPage(1);
  };

  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const packages = data?.packages ?? [];

  return (
    <div data-testid="market-panel">
      <div className="panel-toolbar">
        <input
          className="select packages-input"
          placeholder={t("package.marketSearchPlaceholder")}
          value={query}
          data-testid="market-search"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") run(query);
          }}
        />
        <button className="btn" data-testid="market-search-btn" disabled={busy && !loading} onClick={() => run(query)}>
          {t("package.marketSearch")}
        </button>
        {/* pi.dev sorts (downloads/recent/A-Z) live behind its own server-side
            index — the npm registry API cannot sort, so we hand the user a
            direct link instead of faking a sort over paginated relevance. */}
        <a
          className="btn market-pidev-link"
          data-testid="market-open-pidev"
          href="https://pi.dev/packages"
          target="_blank"
          rel="noreferrer"
        >
          {t("package.marketOpenPidev")}
        </a>
      </div>

      {data?.degraded ? (
        <div className="panel-row-sub market-degraded" data-testid="market-degraded">
          {t("package.marketDegraded")}
        </div>
      ) : null}

      {loading ? (
        <div className="panel-empty" data-testid="market-loading">
          {t("package.marketLoading")}
        </div>
      ) : null}

      {!loading && failed ? (
        <div
          className={`outcome-banner outcome-fail`}
          data-testid="market-error"
        >
          ✗ {failed.code === "unavailable" ? t("package.marketUnavailable") : failed.code === "auth" ? t("package.marketAuth") : t("package.offline")}
          {failed.raw ? (
            <details className="cli-details" data-testid="market-error-details">
              <summary>{t("package.details")}</summary>
              <pre>{failed.raw}</pre>
            </details>
          ) : null}
        </div>
      ) : null}

      {!loading && !failed && packages.length === 0 ? (
        <div className="panel-empty" data-testid="market-empty">
          {t("package.marketEmpty")}
        </div>
      ) : null}

      {packages.map((pkg) => (
        <MarketCard
          key={pkg.name}
          t={t}
          language={language}
          pkg={pkg}
          installed={installedNames.has(pkg.name)}
          installing={installingName === pkg.name}
          busy={busy}
          onInstall={() =>
            askConfirm({
              title: t("package.marketInstallTitle"),
              message: t("package.marketInstallMessage", { pkg: `npm:${pkg.name}` }),
              confirmLabel: t("package.install"),
              onConfirm: () => onInstall(pkg),
            })
          }
        />
      ))}

      {packages.length > 0 ? (
        <div className="market-pager" data-testid="market-pager">
          <button
            className="btn"
            data-testid="market-prev"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            {t("package.marketPrev")}
          </button>
          <span data-testid="market-pageinfo">{t("package.marketPageInfo", { page, pages })}</span>
          <button
            className="btn"
            data-testid="market-next"
            disabled={page >= pages || loading}
            onClick={() => setPage((p) => Math.min(pages, p + 1))}
          >
            {t("package.marketNext")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function MarketCard({
  t,
  language,
  pkg,
  installed,
  installing,
  busy,
  onInstall,
}: {
  t: TFunction;
  language: string;
  pkg: MarketPackage;
  installed: boolean;
  installing: boolean;
  busy: boolean;
  onInstall: () => void;
}) {
  const badge = pkg.badges[0] ?? "package";
  const badgeKey =
    badge === "extension"
      ? "package.badge.extension"
      : badge === "skill"
        ? "package.badge.skill"
        : badge === "theme"
          ? "package.badge.theme"
          : badge === "prompt"
            ? "package.badge.prompt"
            : "package.badge.package";
  return (
    <div className="market-card" data-testid="market-card">
      <div className="market-card-head">
        <span className="mono market-name" data-testid="market-name">
          {pkg.name}
        </span>
        <span className="pkg-version mono">{pkg.version ? `v${pkg.version}` : ""}</span>
        <span className="pkg-badge">{t(badgeKey)}</span>
        <span className="market-card-actions">
          {installed ? (
            <span className="pkg-installed" data-testid="market-installed">
              {t("package.marketInstalled")}
            </span>
          ) : installing ? (
            <ProgressLine testid={`market-progress-${pkg.name}`} text={t("package.progressInstall")} />
          ) : (
            <button className="btn btn-send" data-testid={`market-install-${pkg.name}`} disabled={busy} onClick={onInstall}>
              {t("package.install")}
            </button>
          )}
        </span>
      </div>
      {pkg.description ? <div className="market-desc">{pkg.description}</div> : null}
      <div className="market-meta">
        {pkg.author ? <span>{pkg.author}</span> : null}
        <span data-testid="market-downloads">
          {formatNumber(pkg.downloads, language)} {t("package.perMonth")}
        </span>
        <span data-testid="market-updated">{formatRelativeDay(pkg.updated, language)}</span>
        <a href={pkg.linkNpm} target="_blank" rel="noreferrer" className="market-link">
          npm
        </a>
        {pkg.linkRepo ? (
          <a href={pkg.linkRepo} target="_blank" rel="noreferrer" className="market-link">
            {t("package.marketRepo")}
          </a>
        ) : null}
      </div>
    </div>
  );
}

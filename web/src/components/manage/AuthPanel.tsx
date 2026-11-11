import { Fragment, useCallback, useEffect, useState } from "react";
import type { manageApi, AuthOverviewResult, ProviderInfoResult } from "../../manage";
import { useT } from "../../i18n/useT";
import { tip } from "../Tooltip";
import Icon from "../Icon";
import ProviderForm from "./ProviderForm";
import CustomProviderForm from "./CustomProviderForm";
import { KNOWN_PROVIDERS } from "../../lib/knownProviders";
import { usePiStore } from "../../store/store";

type StatusMap = Record<string, string>;

/**
 * Renders one config value. Sensitive keys arrive as booleans — the raw value
 * never crosses the bridge (spec 001 T019), so a boolean simply means
 * "configured or not" and everything else is shown verbatim. Objects recurse
 * into their own rows (e.g. `headers.Authorization` gets its own flag row).
 */
function ConfigValue({ value }: { value: unknown }) {
  const { t } = useT();
  if (typeof value === "boolean") {
    return (
      <span className={`config-flag ${value ? "config-set" : "config-unset"}`} data-configured={value}>
        {value ? t("auth.configured") : t("auth.notConfigured")}
      </span>
    );
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return (
      <>
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <span className="provider-config-row" key={k} data-testid={`provider-config-${k}`}>
            <span className="mono">{k}</span>
            <span className="mono">
              <ConfigValue value={v} />
            </span>
          </span>
        ))}
      </>
    );
  }
  return <>{typeof value === "string" ? value : JSON.stringify(value)}</>;
}

export default function AuthPanel({ api }: { api: ReturnType<typeof manageApi> }) {
  const { t } = useT();
  const [overview, setOverview] = useState<AuthOverviewResult | null>(null);
  const [statuses, setStatuses] = useState<StatusMap>({});
  const [checking, setChecking] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, ProviderInfoResult | null>>({});
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [openNote, setOpenNote] = useState<string | null>(null);
  /** null = no editor; "new" = adding; otherwise = the provider being edited. */
  const [formMode, setFormMode] = useState<"new" | string | null>(null);
  /** 027: the custom-provider DEFINITION form ("new" = create, else editing). */
  const [customForm, setCustomForm] = useState<"new" | string | null>(null);
  /** Built-in ids (027): customs get edit/delete-definition entries. */
  const builtinIds = new Set(KNOWN_PROVIDERS.map((k) => k.id));

  /**
   * spec 014 real-machine finding: a running browser login pins the form
   * (single-login policy disables the picker/start), so users read "collapse"
   * as the way out — and re-expanding felt stuck. Every explicit close or
   * switch of the form therefore cancels the running login; tab switches keep
   * it alive (US4), only form dismissal cancels.
   */
  const switchForm = (next: "new" | string | null) => {
    if (next !== formMode && usePiStore.getState().authLogin.phase === "running") {
      void api.authLoginCancel().catch(() => undefined);
    }
    setFormMode(next);
  };
  /** 013 US4: pretty JSON blocks wrap (pre-wrap) instead of scrolling sideways. */
  const [wrapDetail, setWrapDetail] = useState(false);

  const refresh = useCallback(async () => {
    setOverview(await api.authOverview().catch(() => null));
  }, [api]);

  const reloadModels = usePiStore((s) => s.reloadModels);
  /**
   * Spec 016: a saved/removed credential must reach the chat tab's model
   * picker. pi re-reads auth.json by itself; models.json needs the bundled
   * extension, which the bridge triggers. [staleModels] only appears when that
   * refresh was unavailable — the credential itself is already written.
   */
  const [staleModels, setStaleModels] = useState(false);
  const afterCredentialChange = useCallback(async () => {
    await refresh();
    const refreshed = await reloadModels();
    setStaleModels(!refreshed);
  }, [refresh, reloadModels]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const check = async (provider: string) => {
    setChecking(provider);
    try {
      const res = await api.authCheck({ provider });
      setStatuses((prev) => ({ ...prev, [provider]: res.status }));
    } catch (e) {
      setStatuses((prev) => ({ ...prev, [provider]: `error: ${(e as Error).message}` }));
    } finally {
      setChecking(null);
    }
  };

  const toggleDetail = async (provider: string) => {
    setOpenNote(null);
    if (expanded === provider) {
      setExpanded(null);
      return;
    }
    setExpanded(provider);
    if (details[provider] === undefined) {
      setLoadingDetail(true);
      const res = await api.modelsReadProvider({ name: provider }).catch(
        (e: Error): ProviderInfoResult => ({ ok: false, error: e.message }),
      );
      setDetails((prev) => ({ ...prev, [provider]: res }));
      setLoadingDetail(false);
    }
  };

  const openInEditor = async (provider: string) => {
    setOpenNote(null);
    try {
      const res = await api.modelsOpenFile({ provider });
      const path = res.path ?? "";
      setOpenNote(res.created ? t("auth.createdOpened", { path }) : t("auth.opened", { path }));
    } catch (e) {
      setOpenNote(t("auth.openFailed", { msg: (e as Error).message }));
    }
  };

  const askConfirm = usePiStore((s) => s.askConfirm);

  const removeCredential = (provider: string) => {
    askConfirm({
      title: t("provider.deleteTitle"),
      message: t("provider.deleteMessage", { provider }),
      confirmLabel: t("common.delete"),
      danger: true,
      onConfirm: () => {
        void (async () => {
          try {
            const res = await api.authDelete({ provider });
            if (!res.ok) setOpenNote(res.error ?? null);
            await afterCredentialChange();
          } catch (e) {
            setOpenNote((e as Error).message);
          }
        })();
      },
    });
  };

  const providers = overview?.providers ?? [];
  const withCreds = new Set(overview?.withCredentials ?? []);
  const credentialTypes = overview?.credentialTypes ?? {};

  /** Row badge: stored credentials name their method, like /login's status. */
  const credBadge = (provider: string): string => {
    if (!withCreds.has(provider)) return t("auth.customProvider");
    const type = credentialTypes[provider];
    const method = type === "oauth" ? t("auth.credTypeOauth") : type === "api_key" ? t("auth.credTypeApiKey") : null;
    return method ? `${t("auth.credentialsStored")} · ${method}` : t("auth.credentialsStored");
  };

  return (
    <div data-testid="auth-panel">
      {/* models.json problems are announced once, up front (FR-013): a missing
          file is "nothing configured yet", a corrupt one shows the parse error
          with its position. The panel never goes silently blank. */}
      {overview && overview.modelsState !== "ok" ? (
        <div className="panel-note" data-testid="models-state" data-state={overview.modelsState}>
          {overview.modelsState === "corrupt"
            ? overview.modelsError
            : t("auth.missingModels", { path: overview.modelsPath ?? "" }) }
        </div>
      ) : null}
      <div className="panel-toolbar">
        <button className="btn" data-testid="auth-add" onClick={() => switchForm(formMode === "new" ? null : "new")}>
          {formMode === "new" ? t("provider.addClose") : t("provider.add")}
        </button>
        <button
          className="btn"
          data-testid="auth-add-custom"
          onClick={() => setCustomForm(customForm === "new" ? null : "new")}
        >
          {customForm === "new" ? t("cprov.addClose") : t("cprov.add")}
        </button>
        <button className="btn" data-testid="auth-refresh" onClick={() => void refresh()}>
          {t("auth.refresh")}
        </button>
        <span className="panel-row-sub">{t("auth.checkHint")}</span>
      </div>
      {/* Spec 016: the credential is saved either way; only the in-process
          refresh was missing, so this is an instruction, not an error. */}
      {staleModels ? (
        <div className="panel-note" data-testid="models-reload-note">
          {t("auth.modelsStale")}
        </div>
      ) : null}
      {formMode === "new" ? (
        <ProviderForm
          api={api}
          defaultCustom={false}
          testPrefix="provider-add"
          onDone={() => void afterCredentialChange()}
        />
      ) : null}
      {customForm !== null ? (
        <CustomProviderForm
          api={api}
          editing={customForm === "new" ? undefined : customForm}
          testPrefix="cprov-add"
          onDone={() => {
            setCustomForm(null);
            void afterCredentialChange();
          }}
          onCancel={() => setCustomForm(null)}
        />
      ) : null}
      {providers.length === 0 ? (
        <div className="panel-empty" data-testid="auth-empty">
          {t("auth.empty")}
        </div>
      ) : null}
      {openNote ? (
        <div className="panel-note" data-testid="models-open-note">
          {openNote}
        </div>
      ) : null}
      {providers.map((p) => {
        const detail = details[p];
        return (
          <Fragment key={p}>
            <div className="panel-row" data-testid="auth-provider-row">
              <div className="panel-row-main">
                <span className="panel-row-title">{p}</span>
                <span className="panel-row-sub">
                  {credBadge(p)}
                  {statuses[p] ? ` · ${statuses[p]}` : ""}
                </span>
              </div>
              <div className="panel-row-actions">
                <button
                  className="btn provider-toggle"
                  data-testid={`provider-toggle-${p}`}
                  aria-expanded={expanded === p}
                  aria-label={t("auth.showConfig")}
                  {...tip(t("auth.showConfig"))}
                  onClick={() => void toggleDetail(p)}
                >
                  {/* 013 US3: a real chevron with a rotation transition — the
                      bare ▸/▸ text glyphs were illegible in the dark theme. */}
                  <Icon
                    name="chev-right"
                    className={`ic-sm provider-toggle-caret ${expanded === p ? "provider-toggle-caret-open" : ""}`}
                  />
                </button>
                <button
                  className="btn"
                  data-testid={`provider-setkey-${p}`}
                  onClick={() => switchForm(formMode === p ? null : p)}
                >
                  {formMode === p ? t("provider.editClose") : t("provider.edit")}
                </button>
                {/* 027 US4: a models.json custom gets definition edit/delete on
                    its row; bundled providers only have credentials here. */}
                {!builtinIds.has(p) ? (
                  <button
                    className="btn"
                    data-testid={`provider-editdef-${p}`}
                    onClick={() => setCustomForm(customForm === p ? null : p)}
                  >
                    {customForm === p ? t("cprov.editDefClose") : t("cprov.editDef")}
                  </button>
                ) : null}
                {!builtinIds.has(p) ? (
                  <button
                    className="btn btn-abort"
                    data-testid={`provider-deldef-${p}`}
                    onClick={() => {
                      usePiStore.getState().askConfirm({
                        title: t("cprov.deleteDefTitle"),
                        message: t("cprov.deleteDefMessage", { name: p }),
                        confirmLabel: t("common.delete"),
                        danger: true,
                        onConfirm: () => {
                          void (async () => {
                            try {
                              const res = await api.providerDelete({ name: p });
                              if (!res.ok) setOpenNote(res.error ?? t("cprov.saveFailed"));
                              else setOpenNote(t("cprov.deleted", { name: p }));
                            } catch (e) {
                              setOpenNote((e as Error).message);
                            }
                            await refresh();
                          })();
                        },
                      });
                    }}
                  >
                    {t("common.delete")}
                  </button>
                ) : null}
                {withCreds.has(p) ? (
                  <button
                    className="btn btn-abort"
                    data-testid={`provider-delete-${p}`}
                    onClick={() => removeCredential(p)}
                  >
                    {t("common.delete")}
                  </button>
                ) : null}
                <button
                  className="btn"
                  data-testid={`auth-check-${p}`}
                  onClick={() => void check(p)}
                  disabled={checking === p}
                >
                  {checking === p ? "…" : t("auth.check")}
                </button>
              </div>
            </div>
            {/* 013 US5: the edit form renders directly under its row — it used
                to live inside the expanded detail block, so pressing "Set key"
                without opening the triangle first silently did nothing. */}
            {formMode === p ? (
              <ProviderForm
                api={api}
                fixedProvider={p}
                defaultCustom={!withCreds.has(p)}
                testPrefix={`provider-edit-${p}`}
                onDone={() => void afterCredentialChange()}
              />
            ) : null}
            {expanded === p ? (
              <div className="provider-detail" data-testid={`provider-detail-${p}`}>
                {loadingDetail ? <div className="panel-note">{t("common.loading")}</div> : null}
                {detail && !detail.ok ? (
                  <div className="panel-note" data-testid={`provider-detail-error-${p}`}>
                    {detail.error}
                  </div>
                ) : null}
                {detail?.ok ? (
                  <>
                    <div className="panel-row-actions provider-detail-actions">
                      <button
                        className="btn"
                        data-testid={`provider-open-file-${p}`}
                        onClick={() => void openInEditor(p)}
                      >
                        {t("auth.openInEditor")}
                      </button>
                      <button
                        className="btn"
                        data-testid="provider-wrap-toggle"
                        aria-pressed={wrapDetail}
                        onClick={() => setWrapDetail((w) => !w)}
                      >
                        {t("auth.wrapLines")}
                      </button>
                    </div>
                    {Object.entries(detail.config ?? {}).map(([k, v]) =>
                      Array.isArray(v) ? (
                        // 013 US4: arrays (models!) as formatted JSON blocks —
                        // the compact one-liner squeezed into a narrow flex
                        // cell was unreadable.
                        <div className="provider-config-block" key={k} data-testid={`provider-config-${k}`}>
                          <span className="mono provider-config-key">{k}</span>
                          <pre
                            className={`mono provider-config-json ${wrapDetail ? "provider-config-json-wrap" : ""}`}
                            data-testid={`provider-config-json-${k}`}
                          >
                            {JSON.stringify(v, null, 2)}
                          </pre>
                        </div>
                      ) : (
                        <div className="provider-config-row" key={k} data-testid={`provider-config-${k}`}>
                          <span className="mono provider-config-key">{k}</span>
                          <span className="mono provider-config-value">
                            <ConfigValue value={v} />
                          </span>
                        </div>
                      ),
                    )}
                  </>
                ) : null}
              </div>
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}

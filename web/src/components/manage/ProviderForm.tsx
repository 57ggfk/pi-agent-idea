import { useEffect, useMemo, useState } from "react";
import type { manageApi } from "../../manage";
import { useT } from "../../i18n/useT";
import { isValidProviderName } from "../../lib/provider";
import { copyText } from "../../lib/clipboard";
import { KNOWN_PROVIDERS, mergeProviderOptions } from "../../lib/knownProviders";
import type { ProviderOption } from "../../lib/knownProviders";
import ProviderPicker, { PROVIDER_CUSTOM } from "./ProviderPicker";
import { usePiStore } from "../../store/store";

const CUSTOM = PROVIDER_CUSTOM;

type Method = "account" | "key";

/**
 * The one provider-credential form (012 US5+US6, T129; /login-style rework):
 * the setup guide and the Auth panel render the same fields, validation and
 * error handling.
 *
 * Mirrors the terminal /login flow: the provider comes from a dropdown (bundled
 * pi registry ∪ the live authOverview: models.json customs join as customs,
 * stored credentials add a badge) and the method selector offers the same two
 * routes — account (OAuth) and API key.
 *
 * The account route (spec 014) drives pi's real browser OAuth in-panel: the
 * pi-login helper runs on the user's own pi installation, events stream into
 * the store's authLogin slice, interaction prompts render right here and the
 * credential is written by pi itself. The terminal guide stays below as the
 * fallback path (old pi / import failure).
 *
 * The API-key route writes exactly as before:
 *
 *  - a provider defined in models.json (custom) → `providerSetKey` fills its
 *    `apiKey`;
 *  - anything else (built-in) → `authSet` writes auth.json under pi's lock
 *    protocol.
 *
 * The key input is a password field, cleared after submit; responses carry
 * the provider name only (T127/T133).
 */
export default function ProviderForm({
  api,
  fixedProvider,
  defaultCustom = false,
  onDone,
  testPrefix = "provider",
}: {
  api: ReturnType<typeof manageApi>;
  /** When set, the provider is not editable (edit flow). */
  fixedProvider?: string;
  /** Edit flow only: the fixed provider lives in models.json, not auth.json. */
  defaultCustom?: boolean;
  onDone?: (provider: string) => void;
  testPrefix?: string;
}) {
  const { t } = useT();
  const [options, setOptions] = useState<ProviderOption[] | null>(null);
  /** Dropdown value in add mode: a provider id, [CUSTOM], or "" (none yet). */
  const [selected, setSelected] = useState("");
  const [customName, setCustomName] = useState("");
  const [method, setMethod] = useState<Method>("key");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okNote, setOkNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** Result note for the "open IDE terminal" action (US2). */
  const [termNote, setTermNote] = useState<string | null>(null);

  // spec 014: live OAuth flow state (shared across tab switches, US4).
  const authLogin = usePiStore((s) => s.authLogin);
  const loginBusy = authLogin.phase === "running";
  const [promptValue, setPromptValue] = useState("");
  // A fresh prompt clears the previous answer's text.
  useEffect(() => {
    setPromptValue("");
  }, [authLogin.prompt?.id]);

  // Edit mode: the custom flag decides the write path (models.json vs
  // auth.json) exactly like before; the dropdown just isn't rendered.
  const [editCustom] = useState(defaultCustom);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const overview = await api.authOverview().catch(() => null);
      if (!alive) return;
      // Method defaults never live here: picking a provider applies its
      // stored-credential default (pickProvider), and edit mode keeps the
      // API-key default — the row button that opens the form says "Set key".
      setOptions(mergeProviderOptions(KNOWN_PROVIDERS, overview));
    })();
    return () => {
      alive = false;
    };
  }, [api]);

  const customMode = fixedProvider === undefined && selected === CUSTOM;
  const activeOption: ProviderOption | null = useMemo(() => {
    if (customMode) return null;
    const id = fixedProvider ?? selected;
    if (!id) return null;
    return (
      options?.find((o) => o.id === id) ?? {
        // Unknown/unloaded id: stay writable via the API-key route (the old
        // form's behavior) rather than blocking the panel on the registry.
        id,
        name: id,
        custom: editCustom,
        oauth: false,
        apiKey: true,
        oauthLabel: null,
        credType: null,
      }
    );
  }, [customMode, fixedProvider, selected, options, editCustom]);

  const accountAvailable = activeOption?.oauth ?? false;

  // spec 014: latest-of renders — providers emit one auth_url/device_code per
  // attempt, progress/info lines trail the interesting events.
  const authUrl = useMemo(
    () => [...authLogin.events].reverse().find((e) => e.type === "auth_url") ?? null,
    [authLogin.events],
  );
  const deviceCode = useMemo(
    () => [...authLogin.events].reverse().find((e) => e.type === "device_code") ?? null,
    [authLogin.events],
  );
  const progressNote = useMemo(
    () => [...authLogin.events].reverse().find((e) => e.type === "progress" || e.type === "info")?.message ?? null,
    [authLogin.events],
  );

  const pickProvider = (value: string) => {
    setSelected(value);
    setError(null);
    setOkNote(null);
    if (value === CUSTOM) {
      setMethod("key");
      return;
    }
    const opt = options?.find((o) => o.id === value);
    setMethod(opt?.credType === "oauth" ? "account" : "key");
  };

  const providerId = customMode ? customName.trim() : fixedProvider ?? selected;

  const copyCommand = async () => {
    const ok = await copyText(`/login ${providerId}`);
    setCopied(ok);
    if (ok) window.setTimeout(() => setCopied(false), 1500);
  };

  /**
   * US2: OAuth cannot run inside the panel yet — hand the flow to an IDE
   * terminal that launches pi. The backend reports which path it took:
   * typed (command executed in a new terminal session) vs copied (terminal
   * opened, command on the clipboard). Both are shown verbatim; a total
   * failure is a visible error, never silence.
   */
  const openTerminal = async () => {
    setTermNote(null);
    try {
      const res = await api.openTerminal({ command: "pi" });
      if (res.typed) setTermNote(t("auth.terminalOpened"));
      else if (res.ok) setTermNote(t("auth.terminalCopied"));
      else setTermNote(t("auth.terminalFailed", { msg: res.error ?? "" }));
    } catch (e) {
      setTermNote(t("auth.terminalFailed", { msg: (e as Error).message }));
    }
  };

  /**
   * spec 014 US1: hand the login to the pi-login helper. Backend errors
   * (pi missing, node missing, concurrent login) surface verbatim; a started
   * login drives the panel through the store's authLogin slice.
   */
  const startLogin = async () => {
    setError(null);
    setOkNote(null);
    setTermNote(null);
    const id = customMode ? customName.trim() : fixedProvider ?? selected;
    if (!id) {
      setError(t("provider.pickRequired"));
      return;
    }
    const res = await api.authLoginStart({ provider: id }).catch((e) => ({
      ok: false as const,
      error: (e as Error).message,
    }));
    if (!res.ok) setError(res.error ?? t("provider.writeFailed"));
  };

  const cancelLogin = async () => {
    await api.authLoginCancel().catch(() => undefined);
  };

  /** US2: answer the pending interaction prompt (select answers with the id). */
  const submitPrompt = async (value?: string) => {
    const p = authLogin.prompt;
    if (!p) return;
    const v = value ?? promptValue;
    if (!v.trim() && p.p.type !== "manual_code") return;
    const res = await api.authLoginAnswer({ id: p.id, value: v }).catch((e) => ({
      ok: false as const,
      error: (e as Error).message,
    }));
    if (!res.ok) setError(res.error ?? t("provider.writeFailed"));
  };

  // A successful login refreshes the parent's overview (row badge → account).
  useEffect(() => {
    if (authLogin.done?.ok && authLogin.provider) onDone?.(authLogin.provider);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLogin.done?.ok, authLogin.done, authLogin.provider]);

  const submit = async () => {
    setError(null);
    setOkNote(null);
    if (customMode && !isValidProviderName(providerId)) {
      setError(t("provider.badName"));
      return;
    }
    if (!providerId) {
      setError(t("provider.pickRequired"));
      return;
    }
    if (!key.trim()) {
      setError(t("provider.missingKey"));
      return;
    }
    const custom = customMode || editCustom;
    setBusy(true);
    try {
      const res = custom
        ? await api.providerSetKey({ provider: providerId, key: key.trim() })
        : await api.authSet({ provider: providerId, key: key.trim() });
      if (!res.ok) {
        setError(res.error ?? t("provider.writeFailed"));
        return;
      }
      // Success clears the local state: the key never lingers in the form.
      setKey("");
      setOkNote(t("provider.saved", { provider: providerId }));
      onDone?.(providerId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const methodRow = (
    <div className="provider-form-row">
      <span className="provider-form-label">{t("auth.methodLabel")}</span>
      <div className="segmented" role="radiogroup" aria-label={t("auth.methodLabel")}>
        {customMode ? null : (
          <button
            type="button"
            role="radio"
            aria-checked={method === "account"}
            className={`segment ${method === "account" ? "segment-active" : ""}`}
            data-testid={`${testPrefix}-method-account`}
            disabled={!accountAvailable || loginBusy}
            title={accountAvailable ? undefined : t("auth.methodUnsupported")}
            onClick={() => setMethod("account")}
          >
            {t("auth.methodAccount")}
            {/* spec 014: OAuth runs in-panel now — the 013 "not wired yet"
                badge is gone; unsupported providers keep the disabled segment
                with its title. */}
          </button>
        )}
        <button
          type="button"
          role="radio"
          aria-checked={method === "key"}
          className={`segment ${method === "key" ? "segment-active" : ""}`}
          data-testid={`${testPrefix}-method-key`}
          disabled={loginBusy}
          onClick={() => setMethod("key")}
        >
          {t("auth.methodApiKey")}
        </button>
      </div>
      {method === "account" && !accountAvailable ? (
        <span className="panel-row-sub">{t("auth.methodUnsupported")}</span>
      ) : null}
    </div>
  );

  return (
    <div className="provider-form" data-testid={`${testPrefix}-form`}>
      {fixedProvider !== undefined ? (
        <div className="provider-form-row">
          <label htmlFor={`${testPrefix}-name`}>{t("provider.name")}</label>
          <input
            id={`${testPrefix}-name`}
            className="setup-input"
            data-testid={`${testPrefix}-name`}
            value={fixedProvider}
            disabled
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      ) : (
        <>
          <div className="provider-form-row">
            <label htmlFor={`${testPrefix}-pick`}>{t("provider.pickLabel")}</label>
              <ProviderPicker
                options={options ?? []}
                value={selected}
                onChange={pickProvider}
                disabled={busy || loginBusy}
                loading={options === null}
                testPrefix={testPrefix}
              />
          </div>
          {customMode ? (
            <div className="provider-form-row">
              <label htmlFor={`${testPrefix}-name`}>{t("provider.customName")}</label>
              <input
                id={`${testPrefix}-name`}
                className="setup-input"
                data-testid={`${testPrefix}-name`}
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                disabled={busy}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          ) : null}
        </>
      )}
      {methodRow}
      {method === "account" && !customMode ? (
        <div className="provider-account-guide" data-testid={`${testPrefix}-account-guide`}>
          <div className="provider-guide-title">{t("auth.accountGuideTitle")}</div>
          <div className="panel-row-sub">
            {t("auth.accountGuideBody", {
              provider: activeOption?.oauthLabel ?? providerId,
            })}
          </div>
          <div className="provider-oauth-row">
            <button
              className="btn btn-send"
              data-testid={`${testPrefix}-oauth-start`}
              disabled={loginBusy}
              onClick={() => void startLogin()}
            >
              {t("auth.loginStart")}
            </button>
            {loginBusy ? (
              <>
                <span className="panel-row-sub" data-testid={`${testPrefix}-oauth-running`}>
                  {/* The login outlives form re-entries (US4): name its provider
                      so a re-expanded form never looks stuck on a stale pick. */}
                  {t("auth.loginRunningProvider", { provider: authLogin.provider ?? providerId })}
                </span>
                <button
                  className="btn"
                  data-testid={`${testPrefix}-oauth-cancel`}
                  onClick={() => void cancelLogin()}
                >
                  {t("auth.loginCancel")}
                </button>
              </>
            ) : null}
          </div>
          {authUrl ? (
            <div className="provider-oauth-url" data-testid={`${testPrefix}-oauth-url`}>
              <div className="panel-row-sub">
                {authLogin.browserOpened ? t("auth.loginBrowserAuto") : t("auth.loginBrowserManual")}{" "}
                <a href={authUrl.url} target="_blank" rel="noreferrer">
                  {authUrl.url}
                </a>
              </div>
              {authUrl.instructions ? <div className="panel-row-sub">{authUrl.instructions}</div> : null}
            </div>
          ) : null}
          {deviceCode ? (
            <div className="provider-oauth-url" data-testid={`${testPrefix}-oauth-device`}>
              <div className="provider-guide-title">
                {t("auth.loginUserCode")}: <span className="mono">{deviceCode.userCode}</span>
              </div>
              <div className="panel-row-sub">
                <a href={deviceCode.verificationUri} target="_blank" rel="noreferrer">
                  {deviceCode.verificationUri}
                </a>
              </div>
            </div>
          ) : null}
          {progressNote ? (
            <div className="panel-row-sub" data-testid={`${testPrefix}-oauth-progress`}>
              {progressNote}
            </div>
          ) : null}
          {authLogin.prompt ? (
            <div className="provider-oauth-prompt" data-testid={`${testPrefix}-oauth-prompt`}>
              <div className="provider-form-row">
                <label htmlFor={`${testPrefix}-oauth-prompt-input`}>{authLogin.prompt.p.message}</label>
                {authLogin.prompt.p.type === "select" ? (
                  <div className="provider-oauth-select">
                    {authLogin.prompt.p.options?.map((opt) => (
                      <button
                        key={opt.id}
                        className="btn"
                        data-testid={`${testPrefix}-oauth-choice-${opt.id}`}
                        onClick={() => void submitPrompt(opt.id)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="provider-oauth-row">
                    <input
                      id={`${testPrefix}-oauth-prompt-input`}
                      className="setup-input"
                      data-testid={`${testPrefix}-oauth-prompt-input`}
                      type={authLogin.prompt.p.type === "secret" ? "password" : "text"}
                      value={promptValue}
                      onChange={(e) => setPromptValue(e.target.value)}
                      placeholder={authLogin.prompt.p.placeholder ?? ""}
                      spellCheck={false}
                      autoComplete="off"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void submitPrompt();
                      }}
                    />
                    <button
                      className="btn btn-send"
                      data-testid={`${testPrefix}-oauth-prompt-submit`}
                      onClick={() => void submitPrompt()}
                    >
                      {t("auth.loginSubmit")}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : null}
          {authLogin.phase === "done" && authLogin.done ? (
            <div
              className="panel-note"
              data-testid={`${testPrefix}-oauth-done`}
            >
              {authLogin.done.ok
                ? t("auth.loginDone", { provider: authLogin.provider ?? providerId })
                : authLogin.done.cancelled
                  ? t("auth.loginCancelled")
                  : (authLogin.done.error ?? t("provider.writeFailed"))}
            </div>
          ) : null}
          <div className="provider-account-command">
            <span className="mono" data-testid={`${testPrefix}-account-command`}>
              /login {providerId}
            </span>
            <button
              className="btn"
              data-testid={`${testPrefix}-account-copy`}
              onClick={() => void copyCommand()}
            >
              {copied ? "✓" : t("common.copy")}
            </button>
            <button
              className="btn btn-send"
              data-testid={`${testPrefix}-account-terminal`}
              onClick={() => void openTerminal()}
            >
              {t("auth.openTerminal")}
            </button>
          </div>
          <div className="panel-row-sub">{t("auth.accountCommandHint")}</div>
          {termNote ? (
            <div className="panel-note" data-testid={`${testPrefix}-term-note`}>
              {termNote}
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <div className="provider-form-row">
            <label htmlFor={`${testPrefix}-key`}>{t("provider.key")}</label>
            <input
              id={`${testPrefix}-key`}
              className="setup-input"
              data-testid={`${testPrefix}-key`}
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              disabled={busy}
              autoComplete="off"
            />
          </div>
          <div className="provider-form-actions">
            <button
              className="btn btn-send"
              data-testid={`${testPrefix}-submit`}
              onClick={() => void submit()}
              disabled={busy}
            >
              {t("provider.save")}
            </button>
          </div>
        </>
      )}
      {error ? (
        <div className="panel-note" data-testid={`${testPrefix}-error`}>
          {error}
        </div>
      ) : null}
      {okNote ? (
        <div className="panel-note" data-testid={`${testPrefix}-saved`}>
          {okNote}
        </div>
      ) : null}
    </div>
  );
}

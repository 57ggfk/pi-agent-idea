import { useEffect, useMemo, useState } from "react";
import type { manageApi } from "../../manage";
import { useT } from "../../i18n/useT";
import { isValidProviderName } from "../../lib/provider";
import { copyText } from "../../lib/clipboard";
import { KNOWN_PROVIDERS, mergeProviderOptions } from "../../lib/knownProviders";
import type { ProviderOption } from "../../lib/knownProviders";

/** Dropdown sentinel for the "custom provider (models.json)" option. */
const CUSTOM = "__custom__";

type Method = "account" | "key";

/**
 * The one provider-credential form (012 US5+US6, T129; /login-style rework):
 * the setup guide and the Auth panel render the same fields, validation and
 * error handling.
 *
 * Mirrors the terminal /login flow: the provider comes from a dropdown (bundled
 * pi registry ∪ the live authOverview: models.json customs join as customs,
 * stored credentials add a badge) and the method selector offers the same two
 * routes — account (OAuth) and API key. This iteration stops at guidance for
 * the account method (real browser OAuth arrives with the pi SDK login
 * helper); the API-key route writes exactly as before:
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
            disabled={!accountAvailable}
            title={accountAvailable ? undefined : t("auth.methodUnsupported")}
            onClick={() => setMethod("account")}
          >
            {t("auth.methodAccount")}
          </button>
        )}
        <button
          type="button"
          role="radio"
          aria-checked={method === "key"}
          className={`segment ${method === "key" ? "segment-active" : ""}`}
          data-testid={`${testPrefix}-method-key`}
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
            <select
              id={`${testPrefix}-pick`}
              className="setup-input"
              data-testid={`${testPrefix}-pick`}
              value={selected}
              onChange={(e) => pickProvider(e.target.value)}
              disabled={busy}
            >
              <option value="" disabled>
                {options === null ? t("common.loading") : t("provider.pickPlaceholder")}
              </option>
              {(options ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                  {o.credType
                    ? ` · ${o.credType === "oauth" ? t("auth.credTypeOauth") : t("auth.credTypeApiKey")}`
                    : ""}
                </option>
              ))}
              <option value={CUSTOM} data-testid={`${testPrefix}-custom`}>
                {t("provider.pickCustom")}
              </option>
            </select>
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
          </div>
          <div className="panel-row-sub">{t("auth.accountCommandHint")}</div>
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

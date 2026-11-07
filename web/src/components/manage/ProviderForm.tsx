import { useState } from "react";
import type { manageApi } from "../../manage";
import { useT } from "../../i18n/useT";
import { isValidProviderName } from "../../lib/provider";

/**
 * The one provider-credential form (012 US5+US6, T129): the setup guide and
 * the Auth panel render the same fields, validation and error handling.
 *
 * Two destinations, one form (T103 contract):
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
  defaultCustom?: boolean;
  onDone?: (provider: string) => void;
  testPrefix?: string;
}) {
  const { t } = useT();
  const [provider, setProvider] = useState(fixedProvider ?? "");
  const [key, setKey] = useState("");
  const [custom, setCustom] = useState(defaultCustom);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okNote, setOkNote] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setOkNote(null);
    const name = provider.trim();
    if (!isValidProviderName(name)) {
      setError(t("provider.badName"));
      return;
    }
    if (!key.trim()) {
      setError(t("provider.missingKey"));
      return;
    }
    setBusy(true);
    try {
      const res = custom
        ? await api.providerSetKey({ provider: name, key: key.trim() })
        : await api.authSet({ provider: name, key: key.trim() });
      if (!res.ok) {
        setError(res.error ?? t("provider.writeFailed"));
        return;
      }
      // Success clears the local state: the key never lingers in the form.
      setKey("");
      setOkNote(t("provider.saved", { provider: name }));
      onDone?.(name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="provider-form" data-testid={`${testPrefix}-form`}>
      <div className="provider-form-row">
        <label htmlFor={`${testPrefix}-name`}>{t("provider.name")}</label>
        <input
          id={`${testPrefix}-name`}
          className="setup-input"
          data-testid={`${testPrefix}-name`}
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          disabled={busy || fixedProvider !== undefined}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
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
      {fixedProvider === undefined ? (
        <label className="provider-form-custom">
          <input
            type="checkbox"
            data-testid={`${testPrefix}-custom`}
            checked={custom}
            onChange={(e) => setCustom(e.target.checked)}
            disabled={busy}
          />
          {t("provider.custom")}
        </label>
      ) : null}
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

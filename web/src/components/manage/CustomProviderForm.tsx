import { useEffect, useState } from "react";
import type { manageApi, CustomProviderPayload, CustomProviderModel } from "../../manage";
import { useT } from "../../i18n/useT";
import {
  API_FORMATS,
  DEFAULT_THINKING_LEVELS,
  PROVIDER_NAME_RE,
  THINKING_LEVELS,
  emptyModel,
  toPayload,
  validateCustomProvider,
  type CustomProviderFormModel,
  type CustomProviderFormState,
  type ProviderFormError,
} from "../../lib/customProvider";

/**
 * 027 — the ONE custom-provider definition form (spec FR-009): the Auth
 * panel's "new provider" entry and the setup guide's provider step render
 * this same component, so validation, wording and the write path exist once.
 *
 * The bridge owns the schema (PiModels.providerSave): this form collects the
 * fields, validates client-side for fast feedback, and refuses nothing
 * itself — a `code:"builtin"|"exists"` answer renders a confirm strip that
 * resends with `overwrite:true` (FR-005). The API key never comes back: an
 * edit fills `keyMasked` as a placeholder and a blank field means "keep the
 * stored key" (FR-007).
 */
export default function CustomProviderForm({
  api,
  editing,
  onDone,
  onCancel,
  testPrefix = "cprov",
}: {
  api: ReturnType<typeof manageApi>;
  /** Provider name being edited (fills the form from providerGet). */
  editing?: string;
  onDone?: (name: string) => void;
  onCancel?: () => void;
  testPrefix?: string;
}) {
  const { t } = useT();
  const [form, setForm] = useState<CustomProviderFormState>({
    name: "",
    displayName: "",
    api: "openai-completions",
    baseUrl: "",
    apiKey: "",
    thinkingFormat: "",
    models: [emptyModel()],
  });
  const [loaded, setLoaded] = useState(!editing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<ProviderFormError | null>(null);
  const [confirmOverwrite, setConfirmOverwrite] = useState<"builtin" | "exists" | null>(null);
  const [okNote, setOkNote] = useState<string | null>(null);
  const [reloadNote, setReloadNote] = useState<string | null>(null);
  const [keyMasked, setKeyMasked] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    if (!editing) return;
    let alive = true;
    void (async () => {
      const res = await api.providerGet({ name: editing }).catch(() => null);
      if (!alive || !res?.exists || !res.provider) {
        if (alive) setError(t("cprov.loadFailed"));
        return;
      }
      const p = res.provider;
      setForm({
        name: editing,
        displayName: p.displayName ?? "",
        api: p.api ?? "openai-completions",
        baseUrl: p.baseUrl ?? "",
        apiKey: "",
        thinkingFormat: "",
        models: (p.models.length > 0 ? p.models : [emptyModel() as unknown as CustomProviderModel]).map(
          (m: CustomProviderModel): CustomProviderFormModel => ({
            id: m.id,
            name: m.name ?? "",
            reasoning: m.reasoning,
            inputImage: m.inputImage,
            thinkingLevels: m.thinkingLevels ?? [],
            contextWindow: m.contextWindow != null ? String(m.contextWindow) : "",
            maxTokens: m.maxTokens != null ? String(m.maxTokens) : "",
          }),
        ),
      });
      setKeyMasked(p.hasKey ? (p.keyMasked ?? "•••") : null);
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const patch = (partial: Partial<CustomProviderFormState>) => setForm((f) => ({ ...f, ...partial }));
  const patchModel = (index: number, partial: Partial<CustomProviderFormModel>) =>
    setForm((f) => ({ ...f, models: f.models.map((m, i) => (i === index ? { ...m, ...partial } : m)) }));

  const submit = async (overwrite: boolean) => {
    setError(null);
    setErrorKey(null);
    setOkNote(null);
    setReloadNote(null);
    const invalid = validateCustomProvider(form);
    if (invalid) {
      setErrorKey(invalid);
      return;
    }
    setBusy(true);
    try {
      const payload = toPayload(form) as unknown as CustomProviderPayload;
      const res = await api.providerSave({ provider: payload, overwrite });
      if (!res.ok) {
        if (res.code === "builtin" || res.code === "exists") {
          setConfirmOverwrite(res.code as "builtin" | "exists");
          setError(
            res.code === "builtin" ? t("cprov.refuseBuiltin", { name: form.name }) : t("cprov.refuseExists", { name: form.name }),
          );
        } else {
          setError(res.error ?? t("cprov.saveFailed"));
        }
        return;
      }
      if (res.reloaded === false) {
        setOkNote(t("cprov.savedNoReload", { name: form.name }));
        setReloadNote(res.reloadError ?? "");
        onDone?.(form.name);
        return;
      }
      setOkNote(t("cprov.saved", { name: form.name }));
      setConfirmOverwrite(null);
      onDone?.(form.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setTestResult(null);
    if (!/^https?:\/\//.test(form.baseUrl.trim())) {
      setTestResult(t("cprov.testBadUrl"));
      return;
    }
    try {
      const res = await api.providerTest({ baseUrl: form.baseUrl.trim(), api: form.api, apiKey: form.apiKey.trim() || undefined });
      if (res.ok) setTestResult(t("cprov.testOk", { status: res.status ?? 0, ms: res.ms ?? 0 }));
      else setTestResult(t("cprov.testFail", { msg: res.error ?? `HTTP ${res.status ?? "?"}` }));
    } catch (e) {
      setTestResult(t("cprov.testFail", { msg: (e as Error).message }));
    }
  };

  if (!loaded) {
    return (
      <div className="provider-form" data-testid={`${testPrefix}-form`}>
        <div className="panel-row-sub">{t("cprov.loading")}</div>
      </div>
    );
  }

  return (
    <div className="provider-form" data-testid={`${testPrefix}-form`}>
      <div className="provider-form-row">
        <label htmlFor={`${testPrefix}-name`}>{t("provider.customName")}</label>
        <input
          id={`${testPrefix}-name`}
          className="setup-input"
          data-testid={`${testPrefix}-name`}
          value={form.name}
          onChange={(e) => patch({ name: e.target.value })}
          disabled={busy || editing != null}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div className="provider-form-row">
        <label htmlFor={`${testPrefix}-display`}>{t("cprov.displayName")}</label>
        <input
          id={`${testPrefix}-display`}
          className="setup-input"
          data-testid={`${testPrefix}-display`}
          value={form.displayName}
          onChange={(e) => patch({ displayName: e.target.value })}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div className="provider-form-row">
        <label htmlFor={`${testPrefix}-api`}>{t("cprov.apiFormat")}</label>
        <select
          id={`${testPrefix}-api`}
          className="setup-input"
          data-testid={`${testPrefix}-api`}
          value={form.api}
          onChange={(e) => patch({ api: e.target.value })}
          disabled={busy}
        >
          {API_FORMATS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </div>
      <div className="provider-form-row">
        <label htmlFor={`${testPrefix}-url`}>{t("cprov.baseUrl")}</label>
        <input
          id={`${testPrefix}-url`}
          className="setup-input"
          data-testid={`${testPrefix}-url`}
          value={form.baseUrl}
          onChange={(e) => patch({ baseUrl: e.target.value })}
          disabled={busy}
          placeholder="https://api.example.com"
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
          value={form.apiKey}
          onChange={(e) => patch({ apiKey: e.target.value })}
          disabled={busy}
          placeholder={keyMasked ? t("cprov.keyMasked", { mask: keyMasked }) : ""}
          autoComplete="off"
        />
      </div>

      <div className="cprov-models" data-testid={`${testPrefix}-models`}>
        <div className="cprov-models-head">
          <span>{t("cprov.models")}</span>
          <button
            type="button"
            className="btn"
            data-testid={`${testPrefix}-model-add`}
            disabled={busy}
            onClick={() => setForm((f) => ({ ...f, models: [...f.models, emptyModel()] }))}
          >
            {t("cprov.modelAdd")}
          </button>
        </div>
        {form.models.map((m, i) => {
          const expanded = m.reasoning;
          return (
            <div className="cprov-model" key={i} data-testid={`${testPrefix}-model-${i}`}>
              <div className="cprov-model-row">
                <input
                  className="setup-input"
                  placeholder={t("cprov.modelId")}
                  data-testid={`${testPrefix}-model-id-${i}`}
                  value={m.id}
                  onChange={(e) => patchModel(i, { id: e.target.value })}
                  disabled={busy}
                  spellCheck={false}
                  autoComplete="off"
                />
                <input
                  className="setup-input"
                  placeholder={t("cprov.modelName")}
                  data-testid={`${testPrefix}-model-name-${i}`}
                  value={m.name}
                  onChange={(e) => patchModel(i, { name: e.target.value })}
                  disabled={busy}
                  spellCheck={false}
                  autoComplete="off"
                />
                {form.models.length > 1 ? (
                  <button
                    type="button"
                    className="btn"
                    data-testid={`${testPrefix}-model-del-${i}`}
                    disabled={busy}
                    aria-label={t("cprov.modelRemove")}
                    onClick={() => setForm((f) => ({ ...f, models: f.models.filter((_, j) => j !== i) }))}
                  >
                    ✕
                  </button>
                ) : null}
              </div>
              <label className="cprov-check">
                <input
                  type="checkbox"
                  data-testid={`${testPrefix}-model-thinking-${i}`}
                  checked={m.reasoning}
                  onChange={(e) => patchModel(i, e.target.checked ? { reasoning: true, thinkingLevels: m.thinkingLevels.length ? m.thinkingLevels : DEFAULT_THINKING_LEVELS } : { reasoning: false })}
                />
                {t("cprov.supportThinking")}
              </label>
              {expanded ? (
                <div className="cprov-levels" data-testid={`${testPrefix}-levels-${i}`}>
                  {THINKING_LEVELS.map((lvl) => (
                    <label key={lvl} className="cprov-check">
                      <input
                        type="checkbox"
                        data-testid={`${testPrefix}-level-${lvl}-${i}`}
                        checked={m.thinkingLevels.includes(lvl)}
                        onChange={(e) =>
                          patchModel(i, {
                            thinkingLevels: e.target.checked
                              ? [...m.thinkingLevels, lvl]
                              : m.thinkingLevels.filter((l) => l !== lvl),
                          })
                        }
                      />
                      {lvl}
                    </label>
                  ))}
                </div>
              ) : null}
              <label className="cprov-check">
                <input
                  type="checkbox"
                  data-testid={`${testPrefix}-model-image-${i}`}
                  checked={m.inputImage}
                  onChange={(e) => patchModel(i, { inputImage: e.target.checked })}
                />
                {t("cprov.supportImage")}
              </label>
            </div>
          );
        })}
      </div>

      {form.api === "openai-completions" && form.models.some((m) => m.reasoning) ? (
        <div className="cprov-advanced">
          <button type="button" className="btn" data-testid={`${testPrefix}-advanced`} onClick={() => setAdvanced((v) => !v)}>
            {advanced ? t("cprov.advancedHide") : t("cprov.advanced")}
          </button>
          {advanced ? (
            <div className="provider-form-row">
              <label htmlFor={`${testPrefix}-tfmt`}>{t("cprov.thinkingFormat")}</label>
              <select
                id={`${testPrefix}-tfmt`}
                className="setup-input"
                data-testid={`${testPrefix}-tfmt`}
                value={form.thinkingFormat}
                onChange={(e) => patch({ thinkingFormat: e.target.value })}
                disabled={busy}
              >
                <option value="">{t("cprov.thinkingFormatNone")}</option>
                {["deepseek", "qwen", "zai", "openai"].map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="provider-form-actions">
        <button type="button" className="btn" data-testid={`${testPrefix}-test`} disabled={busy} onClick={() => void runTest()}>
          {t("cprov.test")}
        </button>
        <button
          type="button"
          className="btn btn-send"
          data-testid={`${testPrefix}-submit`}
          disabled={busy}
          onClick={() => void submit(false)}
        >
          {t("provider.save")}
        </button>
        {onCancel ? (
          <button type="button" className="btn" data-testid={`${testPrefix}-cancel`} disabled={busy} onClick={onCancel}>
            {t("common.cancel")}
          </button>
        ) : null}
      </div>
      {confirmOverwrite ? (
        <div className="panel-note" data-testid={`${testPrefix}-overwrite`}>
          <span>{t(confirmOverwrite === "builtin" ? "cprov.confirmBuiltin" : "cprov.confirmExists", { name: form.name })}</span>
          <button
            type="button"
            className="btn btn-send"
            data-testid={`${testPrefix}-overwrite-confirm`}
            disabled={busy}
            onClick={() => {
              const ov = confirmOverwrite;
              setConfirmOverwrite(null);
              void submit(true);
              void ov;
            }}
          >
            {t("cprov.confirmOverwrite")}
          </button>
        </div>
      ) : null}
      {testResult ? (
        <div className="panel-note" data-testid={`${testPrefix}-test-result`}>
          {testResult}
        </div>
      ) : null}
      {errorKey ? (
        <div className="panel-note" data-testid={`${testPrefix}-error`}>
          {t(errorKey)}
        </div>
      ) : null}
      {error ? (
        <div className="panel-note" data-testid={`${testPrefix}-bridge-error`}>
          {error}
        </div>
      ) : null}
      {okNote ? (
        <div className="panel-note" data-testid={`${testPrefix}-saved`}>
          {okNote}
          {reloadNote ? ` ${t("cprov.reloadFailed")}` : ""}
        </div>
      ) : null}
    </div>
  );
}

/** Guard used by tests: the name rule the form enforces before the bridge. */
export const FORM_NAME_RULE = PROVIDER_NAME_RE;

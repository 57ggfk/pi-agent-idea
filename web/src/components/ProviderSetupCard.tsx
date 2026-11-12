import { useEffect, useState } from "react";
import { getBridge } from "../bridge";
import { manageApi, type AuthOverviewResult } from "../manage";
import { usePiStore } from "../store/store";
import { useT } from "../i18n/useT";
import ProviderForm from "./manage/ProviderForm";
import CustomProviderForm from "./manage/CustomProviderForm";

/**
 * Post-install provider step (012 US5, T130): right after the setup gate
 * releases, offer to configure a provider — skippable, once (the skip is
 * persisted in prefs, Q8). When credentials already exist the card says so
 * and stays out of the way; it never blocks the main UI.
 */
export default function ProviderSetupCard() {
  const { t } = useT();
  const dismiss = usePiStore((s) => s.dismissProviderStep);
  const [overview, setOverview] = useState<AuthOverviewResult | null>(null);
  const [api, setApi] = useState<ReturnType<typeof manageApi> | null>(null);
  const [showCustom, setShowCustom] = useState(false);

  useEffect(() => {
    void (async () => {
      const a = manageApi(await getBridge());
      setApi(a);
      setOverview(await a.authOverview().catch(() => null));
    })();
  }, []);

  const hasCreds = (overview?.withCredentials?.length ?? 0) > 0;

  return (
    <div className="provider-setup" data-testid="provider-setup">
      <div className="provider-setup-head">
        <div className="provider-setup-title">{t("provider.setupTitle")}</div>
        <button
          className="btn"
          data-testid="provider-setup-skip"
          onClick={() => void dismiss(true)}
        >
          {t("provider.setupSkip")}
        </button>
      </div>
      {hasCreds ? (
        <div className="panel-note" data-testid="provider-setup-hint">
          {t("provider.setupAlready")}
        </div>
      ) : (
        <div className="panel-row-sub">{t("provider.setupHint")}</div>
      )}
      {api ? (
        <>
          {/* 027 FR-009: the custom-provider definition step uses the SAME
              component as the Auth panel — one validation, one wording. */}
          <button
            type="button"
            className="btn"
            data-testid="provider-setup-cprov-toggle"
            onClick={() => setShowCustom((v) => !v)}
          >
            {showCustom ? t("cprov.setupHide") : t("cprov.setupShow")}
          </button>
          {showCustom ? (
            <CustomProviderForm
              api={api}
              testPrefix="provider-setup-cprov"
              onDone={() => {
                void (async () => {
                  setOverview(await api.authOverview().catch(() => null));
                })();
              }}
            />
          ) : null}
          <ProviderForm api={api} testPrefix="provider-setup" onDone={() => void dismiss(false)} />
        </>
      ) : null}
    </div>
  );
}

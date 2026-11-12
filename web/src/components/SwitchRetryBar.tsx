import { usePiStore } from "../store/store";
import { useT } from "../i18n/useT";

/**
 * 026 FR-005: a failed switch lands the user on the session list, where the
 * transcript's error item is invisible — so the retry entry point is this
 * app-level bar, mounted on every tab above the tab content. Retry re-fires
 * the original target (the store kept the file); ✕ forgets it.
 */
export default function SwitchRetryBar() {
  const file = usePiStore((s) => s.retrySwitch);
  const retryLastSwitch = usePiStore((s) => s.retryLastSwitch);
  const clearRetrySwitch = usePiStore((s) => s.clearRetrySwitch);
  const { t } = useT();
  if (!file) return null;
  return (
    <div className="switch-retry-bar" data-testid="switch-retry-bar">
      <span className="switch-retry-text" title={file}>
        {t("switch.retryBar", { file })}
      </span>
      <button className="btn" data-testid="switch-retry-btn" onClick={() => void retryLastSwitch()}>
        {t("common.retry")}
      </button>
      <button
        className="btn switch-retry-dismiss"
        data-testid="switch-retry-dismiss"
        aria-label={t("switch.retryDismiss")}
        title={t("switch.retryDismiss")}
        onClick={clearRetrySwitch}
      >
        ✕
      </button>
    </div>
  );
}

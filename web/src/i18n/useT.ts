/**
 * The one hook components use for translations (spec 008 FR-002). react-i18next
 * is imported here and nowhere else — the library stays replaceable.
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { usePiStore } from "../store/store";

export function useT() {
  const { t } = useTranslation();
  const language = usePiStore((s) => s.language);
  return useMemo(() => ({ t, language }), [t, language]);
}

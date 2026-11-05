/**
 * Language registry (spec 008 D4) — the single source of truth for "which
 * languages exist". Adding one = a dictionary file in `locales/` + one line
 * here (+ an IDE-side properties bundle); no component ever changes (FR-016,
 * locked by i18n.test.ts).
 *
 * The label is written in the language ITSELF (`English` / `中文`) on purpose:
 * a user who switched to a language they cannot read must still find their
 * way back, so the selector never translates these names.
 */
export interface LanguageEntry {
  /** Value stored in the `language` preference. */
  code: string;
  /** BCP-47 tag for Intl formatting (PluralRules / DateTimeFormat). */
  bcp47: string;
  /** Stable identifier for a11y labels and tests — never rendered as text. */
  labelKey: string;
  /**
   * The language's name in ITSELF ("English" / "中文") — deliberately not a
   * translation key: a user stuck in a language they cannot read must still
   * find their way back (spec D4).
   */
  nativeLabel: string;
  /** The fallback language ships in the main bundle (FR-017). */
  fallback?: boolean;
}

export const LANGUAGES: LanguageEntry[] = [
  { code: "en", bcp47: "en", labelKey: "language.en", nativeLabel: "English", fallback: true },
  { code: "zh", bcp47: "zh-CN", labelKey: "language.zh", nativeLabel: "中文" },
];

export const FALLBACK = "en";

export const isRegistered = (code: string): boolean => LANGUAGES.some((l) => l.code === code);

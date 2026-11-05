/**
 * i18next wiring (spec 008 D2) — the ONLY file that touches the i18next API
 * directly. Swapping the library later means rewriting this file and useT.ts,
 * nothing else.
 *
 * Shape decisions (D2): flat keys with keySeparator/nsSeparator off (semantic
 * ids like `chat.send` stay greppable), no HTML escaping (React already
 * escapes), `useSuspense: false` (a slow zh chunk must show English fallback
 * text, never a blank tree), missing keys render `⟦key⟧` (FR-009).
 *
 * The base language ships in the main bundle; every other locale is a lazy
 * `import.meta.glob` chunk loaded on demand (FR-017).
 */
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./locales/en";
import { FALLBACK, isRegistered } from "./languages";

export type Dict = Record<string, string>;

const loaders = import.meta.glob<{ default: Dict }>("./locales/*.ts");

let initPromise: Promise<void> | null = null;

/**
 * Resolves the effective language: an explicitly chosen registered code wins;
 * `system` (or an unknown leftover code) follows the IDE's `env.locale` by
 * BCP-47 prefix; anything unmatched falls back to the base language (FR-004).
 */
export function resolveLanguage(
  pref: string | undefined | null,
  envLocale: string | undefined | null,
): string {
  if (pref && isRegistered(pref)) return pref;
  const env = (envLocale ?? "").trim().toLowerCase();
  if (env) {
    const match = LANGUAGES_BY_PREFIX.find(
      (l) =>
        env === l.bcp47 ||
        env.startsWith(`${l.bcp47}-`) ||
        env === l.code ||
        env.startsWith(`${l.code}-`),
    );
    if (match) return match.code;
  }
  return FALLBACK;
}

const LANGUAGES_BY_PREFIX = [
  { code: "zh", bcp47: "zh-cn" },
  { code: "en", bcp47: "en" },
];

/** Loads `code`'s dictionary if it is not the base language (lazy chunk). */
export async function ensureLanguage(code: string): Promise<void> {
  if (code === FALLBACK || i18next.hasResourceBundle(code, "translation")) return;
  const loader = loaders[`./locales/${code}.ts`];
  if (!loader) return;
  const mod = await loader();
  i18next.addResourceBundle(code, "translation", mod.default, true, true);
}

/**
 * Idempotent init used by the store once `env` + prefs are known. Returns the
 * resolved language so the store can keep it in state.
 */
export async function initI18n(
  pref: string | undefined | null,
  envLocale: string | undefined | null,
): Promise<string> {
  const language = resolveLanguage(pref, envLocale);
  console.info("[i18n] initI18n", { pref, envLocale, language });
  if (!initPromise) {
    initPromise = i18next
      .use(initReactI18next)
      .init({
        lng: language,
        fallbackLng: FALLBACK,
        resources: { [FALLBACK]: { translation: en } },
        keySeparator: false,
        nsSeparator: false,
        interpolation: { escapeValue: false },
        returnNull: false,
        parseMissingKeyHandler: (key) => `⟦${key}⟧`,
        saveMissing: false,
        react: { useSuspense: false },
      })
      .then(() => undefined);
  }
  await initPromise;
  await ensureLanguage(language);
  await i18next.changeLanguage(language);
  return language;
}

/** Applies a user choice at runtime; loads the chunk before switching. */
export async function setLanguage(code: string): Promise<void> {
  if (!isRegistered(code)) return;
  await ensureLanguage(code);
  await i18next.changeLanguage(code);
}

export { isRegistered, FALLBACK };
export const i18n = i18next;

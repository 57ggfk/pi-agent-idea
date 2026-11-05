/**
 * Locale-aware formatting (spec 008 FR-008): numbers and dates always go
 * through Intl — hand-rolled date strings are exactly what breaks when a
 * second language arrives. Thin wrappers on purpose; no caching, the browser
 * memoizes Intl internally well enough for this UI's volumes.
 */
import { LANGUAGES } from "./languages";

export function formatNumber(value: number, language: string): string {
  return new Intl.NumberFormat(bcp47(language)).format(value);
}

/** Short human timestamp for the session list (e.g. "11月5日 23:04"). */
export function formatDateTime(ms: number, language: string): string {
  return new Intl.DateTimeFormat(bcp47(language), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

/** Future-proofing: relative times when a session was last touched. */
export function formatRelative(ms: number, language: string, now = Date.now()): string {
  const diffSeconds = Math.round((ms - now) / 1000);
  return new Intl.RelativeTimeFormat(bcp47(language), { numeric: "auto" }).format(diffSeconds, "second");
}

function bcp47(language: string): string {
  return LANGUAGES.find((l) => l.code === language)?.bcp47 ?? language;
}

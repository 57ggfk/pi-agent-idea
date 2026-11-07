/** Provider name contract (012 US5/US6): shared by ProviderForm and the
 *  Kotlin writer — letters, digits, dash and underscore, 1–64 chars. */
export const PROVIDER_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function isValidProviderName(name: string): boolean {
  return PROVIDER_NAME_RE.test(name);
}

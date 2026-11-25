/**
 * Shortens a path under the user's home directory to `~/…` for display.
 * Matching is case-insensitive and slash-normalized (`\` ≡ `/`); paths outside
 * home, or without a known home, pass through unchanged. Display-only —
 * nothing that flows back to the backend may use the shortened form (036 US4).
 */
export function shortPath(path: string, homeDir?: string): string {
  if (!homeDir) return path;
  const home = homeDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const target = path.replace(/\\/g, "/");
  return target.toLowerCase().startsWith(home.toLowerCase()) ? "~" + target.slice(home.length) : path;
}

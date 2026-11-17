/**
 * 041 #9 (feedback batch): pi often summarizes a new/changed file as a
 * ```diff block in the message text. The path inside the block header
 * (`--- a/x`, `+++ b/x`, `diff --git a/x b/x`) was plain highlighted text —
 * nothing clickable. This parses the path out of one header line so the
 * renderer can turn it into a file link; null = the header carries no real
 * path (e.g. `/dev/null`).
 */
export function parseDiffHeaderPath(line: string): string | null {
  const m = /^(?:---|\+\+\+|diff --git)\s+(.+)$/.exec(line.trim());
  if (!m) return null;
  const tokens = m[1].split(/\s+/).filter(Boolean);
  // `diff --git a/x b/y`: the b/ token is the file being changed now.
  const b = tokens.find((t) => t.startsWith("b/") && t.length > 2);
  if (b) return b.slice(2);
  const path = tokens.map((t) => (t.startsWith("a/") && t.length > 2 ? t.slice(2) : t))[0];
  if (!path || path === "/dev/null") return null;
  return path;
}

/**
 * Path recognition for drops and pastes (spec 015 US4, tightened by 018 US3).
 *
 * Pure string/array functions live here so they are unit-testable in a node
 * environment; the DataTransfer itself must be read synchronously in the
 * component (the object is neutered once the handler yields), so Composer
 * keeps only the thin synchronous glue.
 *
 * 018 US3 rule change: the old per-line sweep of `text/plain` chipped any
 * line whose first token looked like a path, so pasting markdown turned
 * `/usr/bin/env node` and `./gradlew build` lines into bogus references. The
 * text flavour is now treated as a reference only when the WHOLE payload is a
 * single, whitespace-free, path-looking token — which still covers the legit
 * "copy a file in the IDEA project tree, paste it" case. `text/uri-list`
 * stays per-line, but only for `file://` lines (it is a file flavour).
 */

/** A raw path reference before the bridge resolves it (015). */
export interface PathRef {
  path: string;
  dir: boolean;
}

/**
 * A bare text token that plausibly names a file — not a dragged line of code.
 * Keeps a code drag from turning `fun` into a chip.
 */
export function looksLikePath(token: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(token) || // C:\…
    token.startsWith("/") ||
    token.startsWith("~/") ||
    token.startsWith("./") ||
    token.startsWith("../")
  );
}

/**
 * The whole `text/plain` payload as ONE reference — only when it is a single
 * line with no internal whitespace and looks like a path. Multi-line text
 * (pasted markdown, code, transcripts) is NEVER a reference.
 */
export function pathLikeTextRef(text: string): PathRef | null {
  const token = text.trim();
  if (!token || /\r?\n/.test(text.trimEnd()) || /\s/.test(token)) return null;
  if (!looksLikePath(token)) return null;
  return { path: token, dir: token.endsWith("/") };
}

/**
 * `text/uri-list` lines → `file://` references. Comment lines (`#`, part of
 * the uri-list spec) are skipped; malformed URIs skip the line rather than
 * the whole list. Bare path-looking lines are intentionally NOT accepted
 * here (018 US3): uri-list is a file flavour, and a path in it comes as
 * `file://` from every real source we have seen.
 */
export function parseUriList(text: string): PathRef[] {
  const out: PathRef[] = [];
  for (const line of text.split(/\r?\n/)) {
    const token = line.trim().split(/\s+/)[0];
    if (!token || token.startsWith("#") || !token.startsWith("file://")) continue;
    try {
      const u = new URL(token);
      const p = decodeURIComponent(u.pathname);
      if (p.length > 1) out.push({ path: p, dir: p.endsWith("/") });
    } catch {
      // Malformed URI — skip the line rather than the whole drop.
    }
  }
  return out;
}

/**
 * File items from a DataTransfer file list (native drags and clipboard file
 * copies). Images are excluded — they stay on the image-chip path. Desktop
 * drags are described via `webkitGetAsEntry()`, which Chromium fills with the
 * absolute path in `fullPath`; a plain `File` never exposes one. A single-
 * segment `fullPath` (`/name`) is Chromium's way of saying "name only" and is
 * NOT a path (spec 016) — those degrade to the bare name, best effort.
 */
export function fileRefsFromEntries(
  entries: Array<{ name: string; fullPath: string | null; isDirectory: boolean; isImage: boolean }>,
): PathRef[] {
  const out: PathRef[] = [];
  for (const e of entries) {
    if (e.isImage) continue;
    const segments = (e.fullPath ?? "").split("/").filter(Boolean);
    if (segments.length > 1) {
      out.push({ path: e.fullPath!, dir: e.isDirectory });
      continue;
    }
    out.push({ path: e.name, dir: e.isDirectory });
  }
  return out;
}

/**
 * Full synchronous sweep of a DataTransfer during drop/paste (015 + 018 US3):
 * real file items first, then the uri-list flavour, then the whole-payload
 * text rule. The caller must invoke this before its first `await`.
 */
export function collectPathRefs(
  files: Array<{ name: string; fullPath: string | null; isDirectory: boolean; isImage: boolean }>,
  uriList: string,
  plainText: string,
): PathRef[] {
  const fromFiles = fileRefsFromEntries(files);
  if (fromFiles.length > 0) return fromFiles;
  const fromUris = parseUriList(uriList);
  if (fromUris.length > 0) return fromUris;
  const fromText = pathLikeTextRef(plainText);
  return fromText ? [fromText] : [];
}

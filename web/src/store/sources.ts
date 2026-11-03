/**
 * Data-source state machine (spec 003).
 *
 * Every async source the UI reads at startup used to fail silently: the error
 * went to `console.warn` and the UI showed an empty list, which is
 * indistinguishable from "there is genuinely nothing here". This module is the
 * single place that decides what a failure *means*, so the menus and the
 * diagnostics panel cannot drift apart.
 *
 * Everything here is a pure function over a plain map — no zustand, no bridge —
 * because these transitions are the part worth testing exhaustively.
 */

export type SourceId =
  | "files"
  | "commands"
  | "models"
  | "thinkingLevels"
  | "policy"
  | "prefs"
  | "sessions"
  | "stats";

export type SourceStatus = "idle" | "loading" | "ready" | "failed" | "unsupported";

export interface SourceState {
  status: SourceStatus;
  /** Masked, truncated summary — what the menus show (FR-011). */
  error?: string;
  /** Masked but untruncated — only the diagnostics panel reveals this. */
  fullError?: string;
  lastSuccessAt?: number;
  lastAttemptAt?: number;
  /** A request is on the wire; a second load is refused (FR-004). */
  inflight: boolean;
  /** Failed attempts since the last success; caps automatic recovery. */
  retries: number;
}

export type Sources = Record<SourceId, SourceState>;

/** FR-011: summaries are truncated to this many characters. */
export const MAX_ERROR_CHARS = 200;

/** Automatic recovery stops here, so a dead pi cannot cause a request storm. */
export const AUTO_RETRY_LIMIT = 5;

/** Project files are re-read when the `@` menu opens on data older than this. */
export const FILES_TTL_MS = 30_000;

/** Display order in the diagnostics panel; also the "all sources" list. */
export const SOURCE_IDS: readonly SourceId[] = [
  "files",
  "commands",
  "models",
  "thinkingLevels",
  "policy",
  "prefs",
  "sessions",
  "stats",
] as const;

export const SOURCE_LABELS: Record<SourceId, string> = {
  files: "Project files",
  commands: "Slash commands",
  models: "Models",
  thinkingLevels: "Thinking levels",
  policy: "Approval policy",
  prefs: "Preferences",
  sessions: "Sessions",
  stats: "Session stats",
};

export function emptySourceState(): SourceState {
  return { status: "idle", inflight: false, retries: 0 };
}

export function emptySources(): Sources {
  const out = {} as Sources;
  for (const id of SOURCE_IDS) out[id] = emptySourceState();
  return out;
}

export function isSourceId(value: unknown): value is SourceId {
  return typeof value === "string" && (SOURCE_IDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Error shaping
// ---------------------------------------------------------------------------

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

/**
 * FR-009: a method the bridge does not implement is *not* a failure. Without
 * this distinction the mock environment (which deliberately supports a subset)
 * would paint the whole diagnostics view red and teach users to ignore it.
 *
 * Deliberately narrow: only explicit wording counts, never a fuzzy guess.
 */
export const UNSUPPORTED_RE = /not[_\s-]?implemented|unsupported/i;

export function classifyFailure(error: unknown): SourceStatus {
  return UNSUPPORTED_RE.test(errorText(error)) ? "unsupported" : "failed";
}

/** Cuts to `max` characters, ellipsis included, so the result never exceeds it. */
export function truncate(text: string, max: number = MAX_ERROR_CHARS): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + "…";
}

/**
 * FR: error text lands in the UI, so credentials must not ride along. Shapes
 * only — a bare word that happens to look like a key is left alone.
 */
export function maskSecrets(text: string): string {
  return text
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{6,}/g, (_m, kind: string) => `${kind}-***`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{6,}=*/gi, (_m, scheme: string) => `${scheme} ***`)
    // Keep the key and the separator, drop the value — including the quoted
    // JSON shape `"apiKey":"…"`, where the separator wears quotes on both sides.
    .replace(
      /(\b(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password)\b"?\s*[:=]\s*"?)([^\s",;}]{6,})/gi,
      (_m, lead: string) => `${lead}***`,
    );
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

function patch(sources: Sources, id: SourceId, next: Partial<SourceState>): Sources {
  return { ...sources, [id]: { ...sources[id], ...next } };
}

export function beginLoad(sources: Sources, id: SourceId, now: number = Date.now()): Sources {
  return patch(sources, id, { status: "loading", inflight: true, lastAttemptAt: now });
}

export function resolveLoad(sources: Sources, id: SourceId, now: number = Date.now()): Sources {
  // Clearing the error matters (FR-010): a recovered source must not keep a
  // red badge, otherwise the diagnostics view lies about the present.
  return patch(sources, id, {
    status: "ready",
    inflight: false,
    error: undefined,
    fullError: undefined,
    lastSuccessAt: now,
    lastAttemptAt: now,
    retries: 0,
  });
}

export function rejectLoad(
  sources: Sources,
  id: SourceId,
  error: unknown,
  now: number = Date.now(),
): Sources {
  const masked = maskSecrets(errorText(error));
  return patch(sources, id, {
    status: classifyFailure(error),
    inflight: false,
    error: truncate(masked),
    fullError: masked,
    lastAttemptAt: now,
    retries: sources[id].retries + 1,
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Should opening a consumer of this source re-read it?
 *
 * - never attempted → yes (nothing on screen otherwise);
 * - loading → no, there is already a request on the wire;
 * - ready → only once the data is older than `ttlMs` (FR-006);
 * - failed → **no**. A failure is shown with its own Retry button, and the
 *   process-lifecycle path (FR-005) already covers "pi just became ready".
 *   Silently re-reading here would make the error flash and vanish, which is
 *   exactly the non-determinism US1 exists to remove.
 */
export function needsRefresh(
  state: SourceState,
  now: number = Date.now(),
  ttlMs: number = FILES_TTL_MS,
): boolean {
  if (state.status === "idle") return true;
  if (state.status !== "ready") return false;
  if (state.lastSuccessAt == null) return true;
  return now - state.lastSuccessAt > ttlMs;
}

/**
 * FR-005: sources worth re-reading once pi reports `running`. `ready` sources
 * are left alone — re-fetching them would be pure noise.
 */
export function failedForAutoRetry(sources: Sources): SourceId[] {
  return SOURCE_IDS.filter(
    (id) => sources[id].status === "failed" && !sources[id].inflight && sources[id].retries < AUTO_RETRY_LIMIT,
  );
}

export interface SourceSummary {
  total: number;
  ready: number;
  failed: number;
  unsupported: number;
  idle: number;
  loading: number;
}

export function summarize(sources: Sources): SourceSummary {
  const out: SourceSummary = {
    total: SOURCE_IDS.length,
    ready: 0,
    failed: 0,
    unsupported: 0,
    idle: 0,
    loading: 0,
  };
  for (const id of SOURCE_IDS) {
    const status = sources[id].status;
    if (status === "ready") out.ready += 1;
    else if (status === "failed") out.failed += 1;
    else if (status === "unsupported") out.unsupported += 1;
    else if (status === "loading") out.loading += 1;
    else out.idle += 1;
  }
  return out;
}

/**
 * The headline for the diagnostics panel: one string, chosen by the worst
 * state present. `idle` and `failed` must never collapse into the same word —
 * "not loaded yet" is not a fault.
 */
export function summarizeState(sources: Sources): "failed" | "loading" | "idle" | "ok" {
  const s = summarize(sources);
  if (s.failed > 0) return "failed";
  if (s.loading > 0) return "loading";
  if (s.idle > 0) return "idle";
  return "ok";
}

import { create } from "zustand";
import type { AppTheme, Bridge, ThemePreference } from "../bridge/types";
import { rpc } from "../bridge/types";
import { getBridge } from "../bridge";
import { displaySkillText, parseSkillBlock } from "../lib/skillDisplay";
import {
  clipTitleInput,
  deriveSessionTitle,
  sanitizeLlmTitle,
  validateSessionTitle,
} from "../lib/sessionTitle";
import { manageApi, type AuthLoginEventData, type AuthLoginEvent, type AuthLoginPrompt, type EnvDetectResult } from "../manage";

/**
 * Panel-side mirror of one pi OAuth login. `events` is capped: providers emit
 * a handful (auth_url → progress), but a chatty one must not grow unbounded.
 */
export interface AuthLoginState {
  phase: "idle" | "running" | "done";
  provider: string | null;
  events: AuthLoginEvent[];
  browserOpened: boolean;
  prompt: { id: number; p: AuthLoginPrompt } | null;
  done: { ok: boolean; cancelled?: boolean; error?: string } | null;
}

const AUTH_LOGIN_EVENT_CAP = 10;
import {
  applyEvent,
  approvalFromEvent,
  emptyItem,
  itemToMarkdownSource,
  itemsFromMessages,
  quoteMarkdownSource,
  type ChatItem,
  type CommandInfo,
  type ConfirmRequest,
  type ModelInfo,
  type PendingApproval,
  type QueueImage,
  type QueueMode,
  type QueueState,
  type QueueStateEvent,
  type SessionStats,
} from "./types";
import {
  beginLoad,
  emptySources,
  failedForAutoRetry,
  rejectLoad,
  resolveLoad,
  type SourceId,
  type Sources,
} from "./sources";
import { hitsFromItems, type SearchHit } from "../lib/search";
import { requestRepaint } from "../lib/repaint";
import { perfMark } from "../lib/perf";
import { withTimeout } from "../lib/timeout";
import { i18n, initI18n, isRegistered } from "../i18n";

/** Shorthand for store-side (non-React) copy; English falls out of the base bundle. */
const t = i18n.t.bind(i18n);

/**
 * 021 D1: the single "a session switch is in flight" fact. The placeholder,
 * the send gate, the row highlight and the double-click guards all read this
 * one object instead of keeping their own booleans in sync.
 */
export interface PendingSwitch {
  kind: "new" | "history";
  /** Target session file for `kind: "history"`. */
  file?: string;
  /** `performance.now()` at the click — drives `switch.*` marks and the
   *  "still switching" copy after 10s. */
  startedAt: number;
}

/** 021 D8 / T308: after this long the copy softens; nothing rolls back — a
 *  slow pi is not a failed one. */
export const SWITCH_LONG_MS = 10_000;

/**
 * 026: the switch flow bounds every pi round-trip locally (spec plan §0) — the
 * bridge's 360s default stays for installs; a switch that outlives these is a
 * failure with a retry, never an infinite placeholder. abort is 3s so the
 * sequential worst case (abort + switch) stays inside the 8s US1 budget.
 */
export const SWITCH_RPC_TIMEOUT_MS = 5_000;
export const SWITCH_ABORT_TIMEOUT_MS = 3_000;
export const SWITCH_READ_TIMEOUT_MS = 3_000;

/**
 * 026 FR-007: the `reason=` value for `switch.failed`. `withTimeout` rejections
 * carry "<label> timeout"; the abort hop is named so its signature is distinct
 * from a hung `switch_session` (the real-machine attribution question spec §0
 * leaves open).
 */
function switchFailReason(e: unknown): "timeout" | "rpc" | "abort_timeout" {
  const msg = (e as Error | undefined)?.message ?? "";
  if (msg.includes("abort timeout")) return "abort_timeout";
  if (msg.includes("timeout")) return "timeout";
  return "rpc";
}

export function isSwitchLong(startedAt: number, now: number): boolean {
  return now - startedAt >= SWITCH_LONG_MS;
}

/**
 * Prefix reserved for commands registered by the plugin's own pi extensions
 * (approval, model reload). They are plumbing, not user-facing slash commands.
 */
const INTERNAL_COMMAND_PREFIX = "pi-agent-";

export type SendMode = "auto" | "steer" | "followUp";
export type Tab = "chat" | "sessions" | "manage";

/**
 * How the composer should consume a pending prompt:
 *  - replace: overwrite the draft (IDE "Explain with Pi" and friends)
 *  - quote:   append it after the draft, never overwriting typing (FR-006)
 *  - edit:    overwrite and switch the composer into edit-and-resend mode
 *  - restore: queue take-back (spec 005 US3) — verbatim text, never a
 *             blockquote: the user is getting their own draft back
 */
export type PromptMode = "replace" | "quote" | "edit" | "restore";

/**
 * A file/directory reference waiting to become a composer chip (spec 015):
 * `path` is project-relative when the IDE could compute it, absolute otherwise
 * (desktop drags land outside the project too). pi resolves `@path` refs at
 * send time, so only the path travels — no listings, no file contents.
 */
export interface PendingRef {
  path: string;
  dir: boolean;
}

/** Normalizes the `files` payload of an `ide` event into pending refs. */
function toPendingRefs(files: unknown): PendingRef[] {
  if (!Array.isArray(files)) return [];
  const out: PendingRef[] = [];
  for (const f of files) {
    const o = (f ?? {}) as { path?: unknown; dir?: unknown };
    if (typeof o.path === "string" && o.path.length > 0) {
      out.push({ path: o.path, dir: o.dir === true });
    }
  }
  return out;
}

export interface PendingPrompt {
  text: string;
  id: number;
  mode: PromptMode;
  /** Images to drop into the composer chips (queue restore). */
  images?: Array<{ data: string; mimeType: string }>;
  /** File/directory references to drop into the composer chips (spec 015). */
  refs?: PendingRef[];
}

/** The user message an edit-and-resend will branch from. */
export interface EditTarget {
  entryId: string;
  /** Original text, kept so cancelling can restore without another RPC. */
  text: string;
}

// ---------------------------------------------------------------------------
// Branch point resolution (spec 007 US1)
// ---------------------------------------------------------------------------
//
// Measured against pi 1.5.0 (specs/007-message-fork/fork-semantics.json):
// `fork {entryId}` branches *before* that user entry, and `get_fork_messages`
// lists user entries only. So a reply that is followed by another question
// branches at the *next* question, and the last reply — which has no successor
// — is duplicated with `clone`.

export type BranchTarget = { kind: "entry"; index: number } | { kind: "clone" };

/**
 * 023 D3 — the last pi reply of the round that `index` belongs to.
 *
 * `fork {entryId}` only cuts at user entries, so every reply inside one round
 * lands on the same branch point. Normalising the click to the round's end
 * gives the UI one entry point and makes "triggered from the middle" behave
 * exactly like "triggered from the end" — no half-round session can be created
 * even if a future entry point forgets the `isRoundEnd` guard.
 *
 * Returns -1 when `index` is not an assistant item (caller reports
 * `error.fork.notReply`, as before).
 */
export function roundEndIndex(items: ChatItem[], index: number): number {
  if (index < 0 || index >= items.length) return -1;
  if (items[index].role !== "assistant") return -1;
  let end = index;
  for (let i = index + 1; i < items.length; i++) {
    if (items[i].role === "user") break;
    if (items[i].role === "assistant") end = i;
  }
  return end;
}

/** How many user messages sit at or above `index` in the transcript. */
export function userCountUpTo(items: ChatItem[], index: number): number {
  let count = 0;
  for (let i = 0; i <= index && i < items.length; i++) {
    if (items[i].role === "user") count++;
  }
  return count;
}

/**
 * Which forkable entry a Fork on this reply should branch at.
 *
 * @param userCount     user messages up to and including the target reply
 * @param forkableCount user entries pi reports for this session
 */
export function branchTargetFor(userCount: number, forkableCount: number): BranchTarget {
  if (userCount < 0 || forkableCount <= 0) return { kind: "clone" };
  return userCount < forkableCount ? { kind: "entry", index: userCount } : { kind: "clone" };
}

// Dev / Vite fallback. Inside the IDE the preference is persisted through
// PiUserPrefs (config.getPrefs), because the loopback port — and therefore
// the origin holding localStorage — changes between IDE sessions.
const THEME_STORAGE_KEY = "pi-agent.theme-preference";

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function isAppTheme(value: unknown): value is AppTheme {
  return value === "light" || value === "dark";
}

export function resolveTheme(preference: ThemePreference, ideTheme: AppTheme): AppTheme {
  return preference === "system" ? ideTheme : preference;
}

function readLocalThemePreference(): ThemePreference {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemePreference(raw)) return raw;
  } catch {
    // Storage can be unavailable (privacy settings); default is fine.
  }
  return "system";
}

function writeLocalThemePreference(preference: ThemePreference) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(THEME_STORAGE_KEY, preference);
    }
  } catch {
    // Non-fatal: the IDE preference is the authoritative store.
  }
}

// Language preference (spec 008): same two-layer scheme as the theme. Inside
// the IDE the PiUserPrefs value wins; the localStorage copy only matters in
// standalone/mock runs where the loopback port changes between sessions.
const LANGUAGE_STORAGE_KEY = "pi-agent.language-preference";

function readLocalLanguagePreference(): string | null {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return typeof raw === "string" && (raw === "system" || isRegistered(raw)) ? raw : null;
  } catch {
    return null;
  }
}

function writeLocalLanguagePreference(pref: string) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, pref);
    }
  } catch {
    // Non-fatal: the IDE preference is the authoritative store.
  }
}

function applyDocumentTheme(theme: AppTheme) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty("color-scheme", theme);
}

const initialPreference = readLocalThemePreference();
const initialTheme: AppTheme = resolveTheme(initialPreference, "light");
applyDocumentTheme(initialTheme);

export interface SessionInfo {
  file: string;
  id: string;
  timestamp: string;
  name: string;
  preview: string;
  modifiedAt: number;
  messageCount?: number;
}

// -- Full-session search (spec 006 US3) --------------------------------------

export interface SessionSearchHit {
  role: string;
  snippet: string;
  /** Ordinal of this hit within the session (the jump target, US3). */
  hitIndex: number;
}

export interface SessionSearchMatch {
  file: string;
  id: string;
  name: string;
  modifiedAt: number;
  hitCount: number;
  hits: SessionSearchHit[];
}

export interface SessionSearchResponse {
  results: SessionSearchMatch[];
  scanned: number;
  truncated: boolean;
}

interface PiStore {
  ready: boolean;
  bridgeKind: "jcef" | "mock" | "connecting";
  /** Resolved theme currently applied to the document. */
  theme: AppTheme;
  /** "system" follows the IDE; "light"/"dark" are explicit user overrides. */
  themePreference: ThemePreference;
  /** Last theme reported by the IDE (light/dark). */
  ideTheme: AppTheme;
  tab: Tab;

  piStatus: "notStarted" | "starting" | "running" | "exited";
  piVersion: string;
  exitMessage: string;
  exitStderr: string;

  items: ChatItem[];
  isStreaming: boolean;
  aborted: boolean;
  /** 021: non-null from the click until the target session's content is on
   *  screen (or the switch failed and rolled back). */
  pendingSwitch: PendingSwitch | null;
  retryInfo: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string } | null;
  /**
   * Mirror of pi's queue (spec 005), pushed as full snapshots by the Kotlin
   * queue service on the "queue" event. pi is the source of truth; the items
   * add ids and images that pi's wire format lacks.
   */
  queue: QueueState;
  /** The drift banner was dismissed; stays down until drift resets. */
  driftAck: boolean;
  /** Set when a session change would discard queued entries (FR-012). */
  queueDiscardConfirm: { count: number; kind: "new" | "switch"; file?: string } | null;
  /**
   * Live state of the browser-OAuth login (spec 014), fed by `auth` bridge
   * events. Survives tab switches (US4) until the next start or a reset.
   */
  authLogin: AuthLoginState;
  applyAuthEvent(data: AuthLoginEventData): void;
  resetAuthLogin(): void;
  /** Editor-initiated prompt ("ide" event) waiting for the Composer to pick up. */
  pendingPrompt: PendingPrompt | null;
  /**
   * spec 016 兜底：页面没收到 HTML5 drop 时由 IDE 主动推送引用（ide 事件带
   * fromDrop）。记下时间，Composer 在随后的一次 drop 里据此跳过 DataTransfer
   * 兜底，避免同一批文件插出两个 chip。
   */
  lastIdeDropAt: number;
  /**
   * Edit-and-resend target while the composer owns it. Null when idle; the
   * action matrix hides regenerate/edit whenever this is set (FR-010).
   */
  editing: EditTarget | null;

  /**
   * The one confirmation dialog the App renders (spec 007 US3). Every entry
   * point that switches away from or destroys the current view goes through
   * here instead of `window.confirm`.
   */
  confirm: ConfirmRequest | null;
  askConfirm(request: ConfirmRequest): void;
  closeConfirm(): void;
  /**
   * Bumped whenever a branch invalidates the composer's *local* state (draft
   * images live in Composer state, not the store). The Composer clears itself
   * on change (007 FR-013).
   */
  composerResetSeq: number;

  // -- session outline & search (spec 006) -----------------------------------

  /** The user-message outline popover (US1). Hidden for empty sessions. */
  outlineOpen: boolean;
  toggleOutline(open?: boolean): void;

  // -- language (spec 008) ----------------------------------------------------

  /** Effective UI language (a registered code), resolved at init (FR-004). */
  language: string;
  /** The user's choice: "system" follows the IDE, or a registered code. */
  languagePref: "system" | string;
  /** IDE locale as reported by `env` — the "system" input. */
  envLocale: string;
  /** Applies the choice, persists it, and swaps the dictionary at runtime. */
  setLanguagePreference(pref: "system" | string): Promise<void>;

  /**
   * In-session search (US2). `hits` are derived from the transcript on demand
   * (pure `hitsFromItems`); the store owns query + current index so Enter /
   * Shift+Enter navigation survives re-renders and streaming updates.
   */
  search: { open: boolean; query: string; index: number };
  /** Set when a Sessions search result wants the composer search to open. */
  pendingSearchJump: { query: string; hitIndex: number } | null;
  openSearch(): void;
  closeSearch(): void;
  /**
   * Toolbar button semantics: opens the bar when it is closed and closes it
   * (clearing the query, like the × button) when it is already open. Ctrl/Cmd+F
   * keeps calling [openSearch] — it must focus an open bar, never close it.
   */
  toggleSearch(): void;
  setSearchQuery(query: string): void;
  /** Moves the current hit by `delta` with wrap-around; no-op without hits. */
  searchGo(delta: number): void;
  /** Directly selects a hit (Sessions-result landing, US3). */
  setSearchIndex(index: number): void;
  searchHits(): SearchHit[];
  /** Sessions result click: switch session, then land on this hit (US3). */
  requestSearchJump(query: string, hitIndex: number): void;
  clearSearchJump(): void;
  /**
   * Full-session body search (US3). Race-guarded: only the latest call's
   * response is stored, so a stale answer can never overwrite a newer one.
   */
  sessionSearch: SessionSearchResponse | null;
  searchAllSessions(query: string): Promise<void>;
  clearSessionSearch(): void;

  model?: ModelInfo;
  models: ModelInfo[];
  thinkingLevel: string;
  thinkingLevels: string[];
  commands: CommandInfo[];
  /** Project files for `@` completion; owned here so `sources.files` can describe them. */
  files: string[];
  stats?: SessionStats;
  sessionName?: string;
  sessionId?: string;
  sessions: SessionInfo[];
  /** The current session's title was set by hand — pi name events never
   *  overwrite it (012 T106). Cleared on switch/new session. */
  manualTitle: boolean;
  /** Auto-titling already ran for this session: exactly one attempt (T109). */
  autoTitled: boolean;
  /** B stage (LLM refinement) already attempted for this session: one call,
   *  fired after the first assistant reply; A's title stays on any failure. */
  llmTitled: boolean;
  /** Inline title editor (T107/T108) — one instance at a time. The value is
   *  the session FILE under edit; "current" is the live session when its
   *  file is not (yet) in the list; null means no editor is open. */
  editingSessionTitle: string | null;
  /**
   * First-run setup gate (012 US4, T121): the ONE place that knows whether pi
   * is missing. `state==="ready" && needsSetup` makes the tool window
   * exclusive (App renders only the guide); `state==="error"` never locks the
   * UI — the main view shows with a visible error and a retry instead.
   */
  setupGate: {
    needsSetup: boolean;
    state: "loading" | "ready" | "error";
    error?: string;
    env?: EnvDetectResult;
  };
  /** Post-install provider-config step (012 US5, T130): offered once after a
   *  successful install, skippable; the skip persists in prefs (Q8). */
  providerStep: "hidden" | "offered";
  /** Open image preview request (012 US7, T139): which block to show. */
  imagePreview: { itemId: number; blockIndex: number } | null;
  /** Composer-side preview request (018 US2): the images live in the
   *  composer's local state, so a click hands the modal the list itself. */
  composerPreview: { images: Array<{ src: string; label: string }>; index: number } | null;
  /** Manage sub-tab, persisted across ManageView mounts (0.5.4 real-machine
   *  UX: leaving Manage and returning no longer resets to MCP). */
  manageTab: "mcp" | "packages" | "skills" | "agents" | "auth" | "settings" | "diagnostics";

  /**
   * Per-data-source status (spec 003). "Empty" and "failed" must be
   * distinguishable everywhere, so every async read reports through here.
   */
  sources: Sources;
  /**
   * Single entry point for those reads: dedupes in-flight requests, records the
   * outcome, and hands the value back. Returns undefined on failure — the error
   * lives in `sources[id]`.
   */
  loadSource<T>(id: SourceId, fetcher: () => Promise<T>): Promise<T | undefined>;
  /** Re-runs the last fetcher registered for `id`; no-op when nothing was loaded yet. */
  retrySource(id: SourceId): Promise<void>;
  /** FR-005: one more chance for everything that failed (pi just became ready). */
  retryFailedSources(): void;
  /** Project files, re-read when the `@` menu opens on stale data (FR-006). */
  loadFiles(): Promise<void>;

  /** Pending tool-approval dialogs forwarded by the pi-approve extension. */
  approvals: PendingApproval[];
  /** Approval policy of the bundled extension: "yolo" (default) or "ask". */
  approvalMode: "ask" | "yolo";
  /** pi-managed toggles; null until get_state / config.getPrefs answered. */
  autoCompaction: boolean | null;
  autoRetry: boolean | null;

  setTab(tab: Tab): void;
  setThemePreference(preference: ThemePreference): void;
  init(): Promise<void>;
  send(text: string, mode: SendMode): Promise<void>;
  sendImages(text: string, images: Array<{ data: string; mimeType: string }>, mode: SendMode): Promise<void>;
  /** Resolves dropped/copied paths to project-relative references (spec 015). */
  resolveRefs(inputs: Array<{ path: string; dir: boolean }>): Promise<PendingRef[]>;
  /**
   * Takes the paths of the file/folder drag that just entered the panel from
   * the IDE side (spec 016) — the only place the real absolute paths exist.
   * Empty when the drag carried no files or the bridge is too old.
   */
  takeDroppedRefs(): Promise<PendingRef[]>;
  abort(): Promise<void>;
  // -- message queue (spec 005) ---------------------------------------------
  /** Pulls the current queue snapshot (webview reload restore, FR-001). */
  refreshQueue(): Promise<void>;
  queueMove(id: string, delta: number): Promise<void>;
  queueRemove(id: string): Promise<void>;
  /** Takes an entry back into the composer (text + images, draft kept). */
  queueRestore(id: string): Promise<boolean>;
  queuePromote(id: string): Promise<void>;
  queueResume(): Promise<void>;
  queueClear(): Promise<void>;
  queueDismissDrift(): void;
  confirmQueueDiscard(proceed: boolean): Promise<void>;
  newSession(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  compact(): Promise<void>;
  restartPi(): Promise<void>;
  /**
   * spec 017: re-read the model catalog after a credential or models.json
   * change. pi refreshes auth.json by itself; models.json goes through the
   * bundled pi-models extension, triggered by the bridge. Returns false when
   * the in-process refresh was unavailable (list is still re-read).
   */
  reloadModels(): Promise<boolean>;
  refreshStats(): Promise<void>;
  /** Retries `get_commands` — init() races the pi process and used to leave
   *  the slash menu permanently empty. */
  refreshCommands(): Promise<void>;
  refreshSessions(): Promise<void>;
  switchSession(file: string): Promise<void>;
  /** Renames the current session; [manual] = user-typed (beats pi name
   *  events). Returns false when the RPC failed (error already surfaced). */
  renameSession(name: string, manual?: boolean): Promise<boolean>;
  /** Single setup detection: init() calls it once; SetupCard consumes the
   *  result instead of detecting on its own. force re-runs after install. */
  detectSetup(force?: boolean): Promise<void>;
  /** Called after a successful install: offer the provider config step. */
  offerProviderStep(): void;
  /** Dismisses the provider step; [skip] persists (Q8 default). */
  dismissProviderStep(skip: boolean): Promise<void>;
  /** Manage sub-tab selection (survives ManageView unmounts). */
  setManageTab(tab: "mcp" | "packages" | "skills" | "agents" | "auth" | "settings" | "diagnostics"): void;
  /** Image preview (012 US7). */
  openImagePreview(itemId: number, blockIndex: number): void;
  closeImagePreview(): void;
  /** Composer image preview (018 US2). */
  openComposerPreview(images: Array<{ src: string; label: string }>, index: number): void;
  closeComposerPreview(): void;
  /** Inline title editing shared by the status bar and session list (T107/T108).
   *  Without a file the editor targets the current session; with one, that row. */
  beginEditSessionTitle(file?: string): void;
  cancelEditSessionTitle(): void;
  submitSessionTitle(name: string): Promise<"ok" | "empty" | "long" | "failed">;
  /** Renames a session that is not the live one (bridge sessions.rename). */
  renameSessionFile(file: string, name: string): Promise<boolean>;
  deleteSession(file: string): Promise<void>;
  cloneSession(file: string): Promise<void>;
  forkSession(): Promise<void>;
  /** Branches the session at a specific pi reply (spec 007 US1). */
  forkAtItem(itemId: number): Promise<void>;
  exportSession(file: string): Promise<void>;
  replayMessages(): Promise<void>;
  clearPendingPrompt(): void;
  /** Puts the message into the composer as a blockquote, after the draft. */
  quoteToComposer(item: ChatItem): void;
  /** Branches at the last user message and re-answers it (FR-008). */
  regenerate(): Promise<void>;
  /** Opens edit-and-resend for a message without touching the transcript yet. */
  beginEditMessage(item: ChatItem): Promise<void>;
  cancelEditMessage(): void;
  /** Sends the edited text, branching the old version off first (FR-009). */
  sendEdited(text: string): Promise<void>;
  openFile(path: string, line: number): Promise<void>;
  showFileDiff(path: string): Promise<void>;
  /**
   * Answers a pending extension_ui_request: `confirm` takes a boolean,
   * `select`/`input`/`editor` take the chosen string, `null` cancels (pi
   * receives `undefined`/`false`).
   */
  respondApproval(id: string, answer: boolean | string | null): Promise<void>;
  setApprovalMode(mode: "ask" | "yolo"): Promise<void>;
  setAutoCompaction(enabled: boolean): Promise<void>;
  setAutoRetry(enabled: boolean): Promise<void>;
}

export const usePiStore = create<PiStore>((set, get) => {
  let bridge: Bridge | null = null;
  let initStarted = false;
  let promptSeq = 0;
  /** Sequence guard for sessions.search responses (US3 race rule). */
  let sessionSearchSeq = 0;

  /** Applies a preference and, in system mode, the current IDE theme. */
  const applyThemePreference = (preference: ThemePreference, persist: boolean) => {
    const theme = resolveTheme(preference, get().ideTheme);
    set({ themePreference: preference, theme });
    applyDocumentTheme(theme);
    writeLocalThemePreference(preference);
    if (persist && bridge) {
      // PiUserPrefs is per project and survives port/token changes.
      void bridge.request("config.setPrefs", { theme: preference }).catch(() => undefined);
    }
  };

  /** IDE reported a theme change; overrides only matter in system mode. */
  const applyIdeTheme = (ideTheme: AppTheme) => {
    const theme = resolveTheme(get().themePreference, ideTheme);
    set({ ideTheme, theme });
    applyDocumentTheme(theme);
  }

  /**
   * `id` → the last fetcher used for it, so "Retry" can replay a request
   * without every caller having to re-supply its own closure.
   */
  const sourceLoaders = new Map<SourceId, () => Promise<unknown>>();

  /**
   * 021 D8: every `switchSession` / `runNewSession` bumps this. A response
   * that comes back after a newer request owns the screen is dropped instead
   * of painting the wrong transcript.
   */
  let switchSeq = 0;

  /**
   * 026 FR-003: a switch that leaves scope (early return on a newer seq, a
   * late catch, success) clears only the pendingSwitch it *owns* — ownership
   * is the `startedAt` captured at click time. Clearing unconditionally would
   * either erase a newer switch's placeholder or resurrect nothing; before
   * this guard the newest switch's own failure left the screen stuck.
   */
  const clearOwnPending = (startedAt: number) => {
    if (get().pendingSwitch?.startedAt === startedAt) set({ pendingSwitch: null });
  };

  /**
   * Runs a source read through the state machine (spec 003).
   *
   * In-flight dedupe lives here rather than in each caller: the composer's
   * menus used to fire a request per keystroke, and a retry button that can be
   * pressed twice must not double the load.
   */
  const runSource = async <T,>(id: SourceId, fetcher: () => Promise<T>): Promise<T | undefined> => {
    sourceLoaders.set(id, fetcher);
    if (get().sources[id].inflight) return undefined;
    set({ sources: beginLoad(get().sources, id) });
    try {
      const value = await fetcher();
      set({ sources: resolveLoad(get().sources, id) });
      return value;
    } catch (e) {
      set({ sources: rejectLoad(get().sources, id, e) });
      return undefined;
    }
  };

  /**
   * Re-fetches whatever init() asked for while the pi process might still have
   * been starting. A silently empty command/model list makes the composer's
   * menus look broken, so this retries once pi reports itself running.
   *
   * Two categories qualify: sources that *failed*, and metadata sources that
   * answered "ready" with nothing in them — pi returns an empty model list
   * before its provider config is loaded, which is not a failure but is just
   * as useless to show.
   */
  const refreshMeta = () => {
    if (!bridge) return;
    // FR-005: whatever failed while pi was starting gets one more chance.
    get().retryFailedSources();
    const s = get();
    const empty: SourceId[] = [];
    if (s.sources.commands.status === "ready" && s.commands.length === 0) empty.push("commands");
    if (s.sources.models.status === "ready" && s.models.length === 0) empty.push("models");
    if (s.sources.thinkingLevels.status === "ready" && s.thinkingLevels.length === 0) {
      empty.push("thinkingLevels");
    }
    for (const id of empty) void get().retrySource(id);
  };

  /** Appends a visible error item (spec 003: failures must never be silent). */
  const appendError = (text: string) => {
    const item = emptyItem("system", [{ kind: "text", text, done: true }]);
    item.done = true;
    item.isError = true;
    set({ items: [...get().items, item] });
  };

  /**
   * pi 1.4.0's `fork` / `clone` switch the session *inside* the pi process and
   * answer without `sessionPath` / `sessionId`. The UI therefore cannot follow
   * the response — it has to rebuild from the authoritative session state,
   * which is also why the old flow silently did nothing on a real pi.
   */
  const syncAfterBranch = async () => {
    if (!bridge) return;
    const b = bridge;
    set({ tab: "chat", isStreaming: false, aborted: false, stats: undefined });
    await get().replayMessages();
    try {
      const state = await rpc<{
        sessionId?: string;
        sessionName?: string;
        model?: ModelInfo;
        thinkingLevel?: string;
      }>(b, { type: "get_state" });
      set({
        sessionId: state.sessionId,
        sessionName: state.sessionName,
        thinkingLevel: state.thinkingLevel ?? get().thinkingLevel,
        ...(state.model ? { model: state.model } : {}),
      });
    } catch {
      // Best effort: the transcript is already restored by the replay above.
    }
    await get().refreshSessions();
    await get().refreshStats();
  };

  /**
   * The forkable user entries, oldest first. `get_fork_messages` answers a bare
   * array in pi 1.4.0; the wrapper shape is accepted too so a protocol tweak
   * cannot silently break the Fork button.
   */
  const forkEntries = async (b: Bridge): Promise<Array<{ entryId: string; text: string }>> => {
    const resp = await rpc<
      Array<{ entryId: string; text: string }> | { messages?: Array<{ entryId: string; text: string }> }
    >(b, { type: "get_fork_messages" });
    const list = Array.isArray(resp) ? resp : (resp?.messages ?? []);
    return list.filter((e) => e && typeof e.entryId === "string" && e.entryId.length > 0);
  };

  /**
   * Branches the conversation at `entryId` and rebuilds the UI from the
   * authoritative state. Returns false when an extension cancelled the branch
   * (pi reports that in-band, not as an RPC error).
   */
  const branchTo = async (b: Bridge, entryId: string): Promise<boolean> => {
    const result = await rpc<{ text?: string; cancelled?: boolean }>(b, { type: "fork", entryId });
    if (result?.cancelled) return false;
    await syncAfterBranch();
    return true;
  };

  /** Hands a pre-filled prompt to the Composer; `mode` decides how it lands. */
  const pushPendingPrompt = (text: string, mode: PromptMode) => {
    set({ pendingPrompt: { text, id: ++promptSeq, mode } });
  };

  /**
   * Drops everything that belonged to the session we just branched away from
   * (007 FR-013). pi's own queue does not follow a fork — measured in
   * fork-semantics.json, the new session starts with an empty queue — so the
   * mirror is reset rather than cleared over RPC.
   */
  const resetConversationLocalState = () => {
    set({
      pendingPrompt: null,
      editing: null,
      queue: { items: [], paused: false, pauseReason: null, drift: false },
      composerResetSeq: get().composerResetSeq + 1,
      // 006 FR-015: a new conversation must not inherit the old outline or
      // search state (stale hits would highlight the wrong transcript).
      outlineOpen: false,
      search: { open: false, query: "", index: 0 },
      pendingSearchJump: null,
    });
  };

  /**
   * Creates the empty session (021 US2). The screen clears *before* the RPC:
   * waiting for pi to answer kept the old transcript visible for a second or
   * more with zero feedback. A failure restores the snapshot (D2).
   */
  const runNewSession = async () => {
    if (!bridge) return;
    // D8: a second "new" while one is in flight would spawn two sessions.
    if (get().pendingSwitch) return;
    // FR-012 (spec 005): a non-empty queue would be silently dropped.
    if (get().queue.items.length > 0) {
      set({ queueDiscardConfirm: { count: get().queue.items.length, kind: "new" } });
      return;
    }
    const b = bridge;
    const startedAt = performance.now();
    const seq = ++switchSeq;
    const previousItems = get().items;

    set({
      pendingSwitch: { kind: "new", startedAt },
      items: [],
      stats: undefined,
      aborted: false,
      isStreaming: false,
      sessionName: undefined,
      editing: null,
      manualTitle: false,
      autoTitled: false,
      llmTitled: false,
      editingSessionTitle: null,
    });
    resetConversationLocalState();
    requestRepaint();
    perfMark("switch.pending", startedAt, { kind: "new" });

    try {
      await withTimeout(rpc(b, { type: "new_session" }), SWITCH_RPC_TIMEOUT_MS, "new_session");
      if (seq !== switchSeq) {
        clearOwnPending(startedAt); // 026 FR-003
        return;
      }
      set({ pendingSwitch: null });
      perfMark("switch.content", startedAt, { kind: "new" });
      // D2: neither the stats read nor the session-list rescan belongs on the
      // critical path; one tick later so they cannot race pi's first answer.
      setTimeout(() => {
        void get().refreshStats();
        void get().refreshSessions();
      }, 0);
      perfMark("switch.ready", startedAt, { kind: "new" });
    } catch (e) {
      if (seq !== switchSeq) {
        clearOwnPending(startedAt); // 026 FR-003
        return;
      }
      // 026 FR-007: a visible failure mark — "pending without ready" stops
      // being the only stuck signature in idea.log.
      perfMark("switch.failed", startedAt, { reason: switchFailReason(e) });
      set({ pendingSwitch: null, items: previousItems });
      appendError(t("error.newSession.failed", { msg: (e as Error).message }));
    }
  };

  /**
   * 018 US7: a fork clones the parent's title, so the list would show two
   * indistinguishable rows. Append the localized suffix once — forking a
   * fork must not stack suffixes, and an unnamed parent stays unnamed (the
   * auto-titler owns that case). `renameSession(name, false)` keeps the
   * manual flag off, so neither auto-title path fires over the suffix; if pi
   * renames the session itself later, pi's name wins (documented boundary).
   */
  const applyForkSuffix = async () => {
    const name = get().sessionName;
    const suffix = t("session.forkSuffix");
    if (!name || name.endsWith(suffix)) return;
    await get().renameSession(`${name}${suffix}`, false);
  };

  /** Branches at one pi reply; the caller has already confirmed. */
  const runForkAtItem = async (itemId: number) => {
    if (!bridge) return;
    const b = bridge;
    if (get().isStreaming) {
      appendError(t("error.fork.busy"));
      return;
    }
    if (get().editing) {
      appendError(t("error.fork.editing"));
      return;
    }
    const items = get().items;
    const clicked = items.findIndex((item) => item.id === itemId);
    // 023 D3: normalise to the round's last reply before computing the branch
    // point, so a click on a tool-call reply cannot cut the round in half.
    const index = roundEndIndex(items, clicked);
    if (index < 0) {
      appendError(t("error.fork.notReply"));
      return;
    }
    try {
      const entries = await forkEntries(b);
      if (entries.length === 0) {
        appendError(t("error.fork.noUser"));
        return;
      }
      const target = branchTargetFor(userCountUpTo(items, index), entries.length);
      let cancelled: boolean;
      if (target.kind === "entry") {
        const entry = entries[target.index];
        if (!entry) {
          appendError(t("error.fork.noBranch"));
          return;
        }
        const result = await rpc<{ text?: string; cancelled?: boolean }>(b, {
          type: "fork",
          entryId: entry.entryId,
        });
        cancelled = Boolean(result?.cancelled);
      } else {
        // Last reply: "fork" there would drop the answer itself, so duplicate
        // the whole branch instead (007 FR-004).
        const result = await rpc<{ cancelled?: boolean }>(b, { type: "clone" });
        cancelled = Boolean(result?.cancelled);
      }
      // FR-012: the view must stay exactly as it was when pi says no.
      if (cancelled) {
        appendError(t("error.fork.cancelled"));
        return;
      }
      await syncAfterBranch();
      resetConversationLocalState();
      await applyForkSuffix();
    } catch (e) {
      appendError(t("error.fork.failed", { msg: (e as Error).message }));
    }
  };

  /** Bottom-bar Fork capability (UI hidden in 0.5.2, kept for later). */
  const runForkSession = async () => {
    if (!bridge) return;
    try {
      const entries = await forkEntries(bridge);
      const last = entries[entries.length - 1];
      if (!last) {
        appendError(t("error.fork.noUser"));
        return;
      }
      const result = await rpc<{ text?: string; cancelled?: boolean }>(bridge, {
        type: "fork",
        entryId: last.entryId,
      });
      if (result?.cancelled) {
        appendError(t("error.fork.cancelled"));
        return;
      }
      await syncAfterBranch();
      resetConversationLocalState();
      await applyForkSuffix();
    } catch (e) {
      appendError(t("error.fork.failed", { msg: (e as Error).message }));
    }
  };

  const runDeleteSession = async (file: string) => {
    if (!bridge) return;
    try {
      // Deleting the current session leaves the pi process without a session —
      // start a fresh one so the UI never points at a dead file.
      const target = get().sessions.find((s) => s.file === file);
      const wasCurrent = Boolean(target?.id && target.id === get().sessionId);
      await bridge.request("sessions.delete", { file });
      await get().refreshSessions();
      if (wasCurrent) await runNewSession();
    } catch (e) {
      appendError(t("error.delete.failed", { msg: (e as Error).message }));
    }
  };

  /** Full-snapshot update from the Kotlin queue service (spec 005). */
  const applyQueueState = (data: QueueStateEvent | QueueState) => {
    set({
      queue: {
        items: Array.isArray(data.items) ? data.items : [],
        paused: Boolean(data.paused),
        pauseReason: data.pauseReason ?? null,
        drift: Boolean(data.drift),
      },
      // A snapshot without drift clears the dismissed banner too.
      driftAck: !data.drift,
    });
  };

  /**
   * Reduces one `auth` bridge event (spec 014). Events arrive strictly
   * ordered from the single login session; `started` resets any previous
   * run's tail so the panel never mixes two attempts.
   */
  const applyAuthEvent = (data: AuthLoginEventData) => {
    const current = get().authLogin;
    switch (data.kind) {
      case "started":
        set({
          authLogin: {
            phase: "running",
            provider: data.provider ?? null,
            events: [],
            browserOpened: false,
            prompt: null,
            done: null,
          },
        });
        return;
      case "event": {
        if (!data.ev) return;
        const events = [...current.events, data.ev].slice(-AUTH_LOGIN_EVENT_CAP);
        set({
          authLogin: {
            ...current,
            events,
            browserOpened: current.browserOpened || Boolean(data.browserOpened),
          },
        });
        return;
      }
      case "prompt":
        if (data.id === undefined || !data.p) return;
        set({ authLogin: { ...current, prompt: { id: data.id, p: data.p } } });
        return;
      case "done":
        set({
          authLogin: {
            ...current,
            phase: "done",
            prompt: null,
            done: { ok: Boolean(data.ok), cancelled: data.cancelled, error: data.error },
          },
        });
        return;
    }
  };

  const handlePiEvent = (event: Record<string, unknown>) => {
    const type = event["type"];
    const state = get();
    if (type === "agent_start") {
      set({ isStreaming: true, aborted: false });
      return;
    }
    if (type === "agent_settled") {
      // Pending approval dialogs belong to the finished run — drop them so a
      // stale card never blocks the composer.
      set({ isStreaming: false, aborted: Boolean(event["aborted"]), approvals: [] });
      void get().refreshStats();
      return;
    }
    if (type === "auto_retry_start") {
      set({
        retryInfo: {
          attempt: Number(event["attempt"] ?? 1),
          maxAttempts: Number(event["maxAttempts"] ?? 3),
          delayMs: Number(event["delayMs"] ?? 0),
          errorMessage: String(event["errorMessage"] ?? ""),
        },
      });
      return;
    }
    if (type === "auto_retry_end") {
      set({ retryInfo: null });
      return;
    }
    if (type === "queue_update") {
      // spec 005: the raw pi event is the Kotlin queue service's input, not
      // the UI's. The UI learns queue state only from `queue` events, which
      // carry the aligned mirror (ids + images + paused/drift flags).
      return;
    }
    if (type === "session_info_changed") {
      const name = (event["name"] as string) ?? undefined;
      // A hand-set title wins for this session (012 T106): pi events may not
      // rename it back. Cleared on switch/new session, so a future event
      // reaches the list again.
      if (get().manualTitle) return;
      const sid = get().sessionId;
      set({
        sessionName: name,
        // Keep the list row in sync optimistically — no refreshSessions
        // round-trip (012 T105: at most one request per title change).
        sessions:
          name && sid
            ? get().sessions.map((s) => (s.file === sid || s.id === sid ? { ...s, name } : s))
            : get().sessions,
      });
      return;
    }
    if (type === "extension_ui_request") {
      // Dialog kinds (confirm/select/input/editor) queue as approval cards;
      // fire-and-forget methods (notify/setStatus/…) parse to null and are
      // ignored.
      const request = approvalFromEvent(event);
      if (request) set({ approvals: [...get().approvals, request] });
      return;
    }
    if (type === "thinking_level_changed") {
      set({ thinkingLevel: String(event["level"] ?? state.thinkingLevel) });
      return;
    }
    set({ items: applyEvent(state.items, event) });
    // 012 T109: pi never names sessions on its own (T101 evidence) — the first
    // real user message becomes the title, written back via set_session_name.
    // Stage B then refines it once the first assistant reply is in.
    if (type === "message_end") {
      const message = event["message"] as Record<string, unknown> | undefined;
      if (message && message["role"] === "user") maybeAutoTitle();
      else if (message && message["role"] === "assistant") maybeLlmTitle();
    }
  };

  /** Names the session once from the first user message; never re-fires and
   *  never issues any prompt/model call — just the set_session_name RPC. */
  const maybeAutoTitle = () => {
    const s = get();
    if (s.autoTitled || s.manualTitle || s.sessionName) return;
    set({ autoTitled: true });
    const first = s.items.find((i) => i.role === "user");
    const text = first?.blocks.find((b) => b.kind === "text")?.text ?? "";
    const title = deriveSessionTitle(text);
    if (title) void get().renameSession(title, false);
  };

  /**
   * B on top of A: once the first assistant reply lands, a one-shot pi
   * process (bridge title.generate) turns the exchange into a proper title
   * that overwrites A's truncation. A's result is the durable fallback — the
   * call is best-effort and any failure simply keeps it. Fires only with real
   * text on both sides (an aborted or errored first exchange retries on the
   * next reply instead of burning the one attempt on nothing).
   */
  const maybeLlmTitle = () => {
    const s = get();
    if (s.llmTitled || s.manualTitle) return;
    const userText = s.items.find((i) => i.role === "user")?.blocks.find((b) => b.kind === "text")?.text ?? "";
    const assistantText =
      [...s.items].reverse().find((i) => i.role === "assistant")?.blocks.find((b) => b.kind === "text")?.text ?? "";
    if (!userText.trim() || !assistantText.trim()) return;
    set({ llmTitled: true });
    void generateLlmTitle(
      s.sessionId,
      userText,
      assistantText,
      s.sessions.find((x) => x.id === s.sessionId)?.name,
    );
  };

  /**
   * B write-back, routed by the session the attempt was made for: the still-
   * live session renames through pi (its process owns file and in-memory
   * name); a session the user already left goes through the file append. A
   * hand rename landing mid-flight wins in both routes.
   */
  const generateLlmTitle = async (
    sid: string | undefined,
    userText: string,
    assistantText: string,
    nameAtDispatch: string | undefined,
  ) => {
    const b = bridge;
    if (!b || !sid) return;
    const model = get().model;
    try {
      // A skill-expanded message would burn the excerpt's budget on SKILL.md
      // boilerplate — the question after the block is what titles the session.
      const skill = parseSkillBlock(userText);
      // 45s: the one-shot itself caps at 30s; without this the web request
      // would ride the 6-minute default deadline before the fallback fires.
      const r = (await b.request("title.generate", {
        user: clipTitleInput(skill?.userMessage || userText, 800),
        assistant: clipTitleInput(assistantText, 400),
        provider: model?.provider,
        modelId: model?.id,
      }, 45_000)) as Record<string, unknown>;
      const title = sanitizeLlmTitle(String(r["title"] ?? ""));
      const isCurrent = get().sessionId === sid;
      if (!title || (isCurrent && get().manualTitle)) return;
      const row = get().sessions.find((x) => x.id === sid);
      if (row && !isCurrent) {
        // Renamed while we were generating (a row rename never switches
        // sessions); A's own title landing in between is expected, not a
        // user rename.
        const aTitle = deriveSessionTitle(userText);
        if (row.name && row.name !== nameAtDispatch && row.name !== aTitle) return;
        await get().renameSessionFile(row.file, title);
      } else if (isCurrent) {
        await get().renameSession(title, false);
      }
      // Switched away and unlisted: no safe target — A's title stays on disk.
    } catch {
      // B is best-effort by design; A's heuristic title is already durable.
    }
  };

  return {
    ready: false,
    bridgeKind: "connecting",
    theme: initialTheme,
    themePreference: initialPreference,
    ideTheme: "light",
    tab: "chat",

    piStatus: "notStarted",
    piVersion: "",
    exitMessage: "",
    exitStderr: "",

    items: [],
    isStreaming: false,
    aborted: false,
    pendingSwitch: null,
    retryInfo: null,
    queue: { items: [], paused: false, pauseReason: null, drift: false },
    driftAck: false,
    queueDiscardConfirm: null,
    authLogin: { phase: "idle", provider: null, events: [], browserOpened: false, prompt: null, done: null },
    pendingPrompt: null,
    lastIdeDropAt: 0,
    editing: null,
    confirm: null,
    composerResetSeq: 0,

    outlineOpen: false,
    search: { open: false, query: "", index: 0 },
    pendingSearchJump: null,
    sessionSearch: null,

    language: "en",
    languagePref: "system",
    envLocale: "",

    approvals: [],
    // Auto-approve by default; "ask" is opt-in from the options menu.
    approvalMode: "yolo",
    autoCompaction: null,
    autoRetry: null,

    models: [],
    thinkingLevel: "medium",
    thinkingLevels: [],
    commands: [],
    files: [],
    sessions: [],
    manualTitle: false,
    autoTitled: false,
    llmTitled: false,
    editingSessionTitle: null,
    setupGate: { needsSetup: false, state: "loading" },
    providerStep: "hidden",
    imagePreview: null,
    composerPreview: null,
    manageTab: "mcp",
    sources: emptySources(),

    setTab(tab: Tab) {
      // 012 T121: while the setup gate holds, the tabs do not exist — a
      // programmatic switch must not land anywhere either.
      if (get().setupGate.needsSetup && get().setupGate.state === "ready") return;
      set({ tab });
      if (tab === "sessions") void get().refreshSessions();
    },

    // -- session outline & search (spec 006) -----------------------------------

    toggleOutline(open?: boolean) {
      set({ outlineOpen: open ?? !get().outlineOpen });
    },

    openSearch() {
      set({ search: { ...get().search, open: true } });
    },

    closeSearch() {
      set({ search: { open: false, query: "", index: 0 }, pendingSearchJump: null });
    },

    toggleSearch() {
      if (get().search.open) get().closeSearch();
      else get().openSearch();
    },

    setSearchQuery(query: string) {
      set({ search: { ...get().search, query, index: 0 } });
    },

    searchHits() {
      const { search, items } = get();
      return hitsFromItems(items, search.query);
    },

    searchGo(delta: number) {
      const hits = get().searchHits();
      if (hits.length === 0) return;
      const n = hits.length;
      const index = ((get().search.index + delta) % n + n) % n;
      set({ search: { ...get().search, index } });
    },

    setSearchIndex(index: number) {
      const n = get().searchHits().length;
      if (n === 0) return;
      set({ search: { ...get().search, index: Math.max(0, Math.min(index, n - 1)) } });
    },

    requestSearchJump(query: string, hitIndex: number) {
      set({ pendingSearchJump: { query, hitIndex }, search: { ...get().search, open: true } });
    },

    clearSearchJump() {
      set({ pendingSearchJump: null });
    },

    async searchAllSessions(query: string) {
      const trimmed = query.trim();
      if (!bridge || trimmed.length < 2) {
        set({ sessionSearch: null });
        return;
      }
      const seq = ++sessionSearchSeq;
      try {
        const resp = await bridge.request<SessionSearchResponse>("sessions.search", { query: trimmed });
        if (seq !== sessionSearchSeq) return; // a newer query superseded this one
        set({ sessionSearch: resp });
      } catch {
        if (seq === sessionSearchSeq) {
          // A failed scan must not look like "no matches" (spec 003), but the
          // Sessions page also must not lose the list — report an empty scan.
          set({ sessionSearch: { results: [], scanned: 0, truncated: false } });
        }
      }
    },

    clearSessionSearch() {
      sessionSearchSeq++;
      set({ sessionSearch: null });
    },

    setThemePreference(preference: ThemePreference) {
      applyThemePreference(preference, true);
    },

    async setLanguagePreference(pref: "system" | string) {
      // FR-001: an unknown code is corrected back to "system" so the failure
      // path cannot repeat on every start.
      const safe = pref === "system" || isRegistered(pref) ? pref : "system";
      set({ languagePref: safe });
      writeLocalLanguagePreference(safe);
      const language = await initI18n(safe, get().envLocale);
      set({ language });
      if (bridge) {
        void bridge.request("config.setPrefs", { language: safe }).catch(() => undefined);
      }
    },

    async init() {
      // React StrictMode (dev) mounts effects twice; event wiring must happen once.
      if (initStarted) return;
      initStarted = true;
      bridge = await getBridge();
      set({ bridgeKind: bridge.kind });
      bridge.onEvent((name, data) => {
        if (name === "pi") {
          handlePiEvent(data as Record<string, unknown>);
        } else if (name === "queue") {
          applyQueueState(data as QueueStateEvent);
        } else if (name === "auth") {
          // spec 014: browser-OAuth login progress (single login at a time).
          applyAuthEvent(data as AuthLoginEventData);
        } else if (name === "ide") {
          // Editor action (e.g. "Explain with Pi"): pre-fill the composer and
          // switch to chat. The Composer consumes pendingPrompt and focuses.
          const d = (data ?? {}) as { kind?: string; text?: string; files?: unknown; fromDrop?: boolean };
          const dropStamp = d.fromDrop ? Date.now() : get().lastIdeDropAt;
          if (d.kind === "prompt") {
            const refs = toPendingRefs(d.files);
            set({
              tab: "chat",
              pendingPrompt: {
                text: String(d.text ?? ""),
                id: ++promptSeq,
                mode: "replace",
                ...(refs.length > 0 ? { refs } : {}),
              },
            });
          } else if (d.kind === "refs") {
            // Spec 015: "Add Directory / Send File" push references, not
            // prompt text. Successive right-clicks must accumulate (add two
            // directories in a row keeps both), so merge into whatever
            // pendingPrompt is already waiting instead of replacing it.
            const incoming = toPendingRefs(d.files);
            if (incoming.length === 0) return;
            const cur = get().pendingPrompt;
            if (cur) {
              set({
                tab: "chat",
                pendingPrompt: { ...cur, refs: [...(cur.refs ?? []), ...incoming], id: ++promptSeq },
                lastIdeDropAt: dropStamp,
              });
            } else {
              set({
                tab: "chat",
                pendingPrompt: { text: "", id: ++promptSeq, mode: "replace", refs: incoming },
                lastIdeDropAt: dropStamp,
              });
            }
          }
        } else if (name === "theme") {
          const t = (data ?? {}) as { theme?: unknown };
          if (isAppTheme(t.theme)) applyIdeTheme(t.theme);
        } else if (name === "pi-state") {
          const st = data as {
            status: PiStore["piStatus"];
            version?: string;
            message?: string;
            stderr?: string;
          };
          set({
            piStatus: st.status,
            piVersion: st.version ?? get().piVersion,
            exitMessage: st.message ?? "",
            exitStderr: st.stderr ?? "",
          });
          if (st.status === "running") refreshMeta();
        }
      });

      // 012 T121: exactly ONE envDetect per boot — SetupCard reads the gate.
      void get().detectSetup();
      try {
        const env = await bridge.request<{ theme?: unknown; locale?: string }>("env");
        if (isAppTheme(env.theme)) applyIdeTheme(env.theme);
        set({ envLocale: String(env.locale ?? "") });
      } catch {
        // standalone mock provides env as well; ignore failures
      }

      // Every source read goes through loadSource so its outcome is visible in
      // the diagnostics panel instead of dying in a console.warn.
      const b = bridge;
      await Promise.all([
        rpc<{ model?: ModelInfo; thinkingLevel?: string; isStreaming?: boolean; sessionName?: string; sessionId?: string; autoCompactionEnabled?: boolean }>(
          b,
          { type: "get_state" },
        ).then((s) =>
          set({
            model: s.model,
            thinkingLevel: s.thinkingLevel ?? "medium",
            isStreaming: Boolean(s.isStreaming),
            sessionName: s.sessionName,
            sessionId: s.sessionId,
            autoCompaction: typeof s.autoCompactionEnabled === "boolean" ? s.autoCompactionEnabled : null,
          }),
        ).catch(() => undefined),
        get().loadSource("models", async () => {
          const r = await rpc<{ models: ModelInfo[] }>(b, { type: "get_available_models" });
          set({ models: r.models ?? [] });
        }),
        get().loadSource("thinkingLevels", async () => {
          const r = await rpc<{ levels: string[] }>(b, { type: "get_available_thinking_levels" });
          set({ thinkingLevels: r.levels ?? [] });
        }),
        // Approval policy (bundled pi-approve extension) and preferences pi does
        // not expose via get_state.
        get().loadSource("policy", async () => {
          const policy = await b.request<{ mode?: string }>("approval.getPolicy");
          if (policy.mode === "yolo" || policy.mode === "ask") set({ approvalMode: policy.mode });
        }),
        get().loadSource("prefs", async () => {
          const prefs = await b.request<{ autoRetry?: boolean; theme?: unknown; language?: unknown }>("config.getPrefs");
          if (typeof prefs.autoRetry === "boolean") set({ autoRetry: prefs.autoRetry });
          // IDE-side preference wins over the dev localStorage fallback.
          if (isThemePreference(prefs.theme)) applyThemePreference(prefs.theme, false);
          if (typeof prefs.language === "string" && prefs.language !== "system" && !isRegistered(prefs.language)) {
            // D1: an unregistered leftover code is corrected back to "system".
            void b.request("config.setPrefs", { language: "system" }).catch(() => undefined);
          }
          // IDE pref wins; the localStorage copy covers standalone/mock runs.
          const stored =
            typeof prefs.language === "string" && (prefs.language === "system" || isRegistered(prefs.language))
              ? prefs.language
              : readLocalLanguagePreference();
          if (stored) set({ languagePref: stored });
        }),
        get().refreshCommands(),
        get().refreshStats(),
      ]);

      // 008: resolve the language BEFORE the first paint — the base bundle is
      // synchronous, so worst case this is a no-op (FR-017).
      try {
        const language = await initI18n(get().languagePref, get().envLocale);
        set({ language });
      } catch (e) {
        // i18n must never block startup; a broken dictionary surfaces via the
        // ⟦key⟧ marker instead of a blank tool window — but never silently.
        console.warn("[i18n] init failed; staying on the fallback language", e);
      }

      // Replay the current session so a reopened tool window shows history.
      try {
        const messages = await rpc<{ messages: unknown[] }>(bridge, { type: "get_messages" });
        const restored = itemsFromMessages(messages.messages ?? []);
        if (restored.length > 0) set({ items: restored });
      } catch {
        // mock bridge without get_messages support
      }

      // Restore the queue mirror (webview reload, spec 005 FR-001).
      void get().refreshQueue();

      // Approval policy and preferences are loaded in the Promise.all above,
      // through the source machine — a bridge that does not implement them is
      // recorded as `unsupported`, not as a failure.
      // Re-apply the persisted auto-retry choice to the fresh pi process.
      const retry = get().autoRetry;
      if (retry != null) void get().setAutoRetry(retry);

      set({ ready: true });
    },

    async send(text: string, mode: SendMode) {
      await get().sendImages(text, [], mode);
    },

    async sendImages(text: string, images: Array<{ data: string; mimeType: string }>, mode: SendMode) {
      if (!bridge) return;
      if (!text.trim() && images.length === 0) return;
      const { isStreaming } = get();
      if (isStreaming) {
        // pi is busy (spec 005): the message joins the queue instead of
        // interrupting the run. "auto" while busy means a plain follow-up;
        // steer fires an插话 into the running turn.
        const queueMode: QueueMode = mode === "steer" ? "steer" : "followUp";
        try {
          const res = await bridge.request<{ ok: boolean; retained?: boolean; error?: string }>(
            "queue.enqueue",
            {
              mode: queueMode,
              text,
              images: images.map((img) => ({ data: img.data, mimeType: img.mimeType })),
            },
          );
          if (!res.ok && !res.retained) {
            appendError(t("error.queueEnqueue.failed", { msg: res.error ?? t("error.queueEnqueue.unknown") }));
          }
        } catch (e) {
          appendError(t("error.queueEnqueue.failed", { msg: (e as Error).message }));
          return;
        }
        if (queueMode === "steer") {
          // Fire-and-trace (plan decision 5): render the fire immediately with
          // the「插话」badge; the next replay drops it once pi has recorded the
          // real user message — the transcript is the only source of truth.
          const item = emptyItem("user", [
            { kind: "text", text, done: true },
            ...images.map((img) => ({ kind: "image" as const, data: img.data, mimeType: img.mimeType })),
          ]);
          item.done = true;
          item.ephemeral = true;
          item.steer = true;
          set({ items: [...get().items, item] });
        }
        return;
      }
      // Idle: every mode degrades to a direct send (FR-006) — no queueing.
      const item = emptyItem("user", [
        { kind: "text", text, done: true },
        ...images.map((img) => ({ kind: "image" as const, data: img.data, mimeType: img.mimeType })),
      ]);
      item.done = true;
      // Keep the image data on the optimistic item so sent images render back.
      set({ items: [...get().items, item] });
      const command: Record<string, unknown> = { type: "prompt", message: text };
      if (images.length > 0) {
        command["images"] = images.map((img) => ({
          type: "image",
          data: img.data,
          mimeType: img.mimeType,
        }));
      }
      try {
        await rpc(bridge, command);
      } catch (e) {
        const errorItem = emptyItem("system", [
          { kind: "text", text: `Failed to send: ${(e as Error).message}`, done: true },
        ]);
        errorItem.done = true;
        errorItem.isError = true;
        set({ items: [...get().items, errorItem] });
      }
    },

    async resolveRefs(inputs) {
      if (inputs.length === 0) return [];
      if (!bridge) return inputs;
      try {
        const res = await bridge.request<{ refs?: Array<{ path?: unknown; dir?: unknown }> }>("files.relpath", {
          paths: inputs.map((i) => ({ path: i.path, dir: i.dir })),
        });
        const refs = toPendingRefs(res.refs);
        return refs.length > 0 ? refs : inputs;
      } catch {
        // An older IDE side without the RPC: the raw paths still work —
        // pi reads absolute paths just fine. This is only cosmetic.
        return inputs;
      }
    },

    async takeDroppedRefs() {
      if (!bridge) return [];
      try {
        const res = await bridge.request<{ refs?: Array<{ path?: unknown; dir?: unknown }> }>("files.takeDrop");
        return toPendingRefs(res.refs);
      } catch {
        // Older IDE side: no such RPC. The DataTransfer fallback still runs.
        return [];
      }
    },

    async abort() {
      if (!bridge) return;
      // Approval cards belong to the run being aborted.
      set({ approvals: [] });
      try {
        await rpc(bridge, { type: "abort" });
      } catch {
        // ignore: state events will settle the UI
      }
    },

    // -- message queue (spec 005) --------------------------------------------

    async refreshQueue() {
      if (!bridge) return;
      try {
        const state = await bridge.request<QueueState>("queue.get");
        applyQueueState(state);
      } catch {
        // A bridge without queue support keeps the empty default; the mirror
        // stays driven by "queue" events once operations start flowing.
      }
    },

    async queueMove(id: string, delta: number) {
      if (!bridge) return;
      try {
        await bridge.request("queue.move", { id, delta });
      } catch (e) {
        appendError(t("error.queueMove.failed", { msg: (e as Error).message }));
      }
      // Success pushes a queue_state snapshot; a rejection (at edge) changes
      // nothing, so no extra refresh is needed.
    },

    async queueRemove(id: string) {
      if (!bridge) return;
      try {
        await bridge.request("queue.remove", { id });
      } catch (e) {
        appendError(t("error.queueRemove.failed", { msg: (e as Error).message }));
      }
    },

    async queueRestore(id: string) {
      if (!bridge) return false;
      try {
        const res = await bridge.request<{
          ok: boolean;
          text?: string;
          images?: QueueImage[];
          error?: string;
        }>("queue.restore", { id });
        if (!res.ok) {
          appendError(res.error ?? t("error.queueRestore.failed", { msg: "" }));
          return false;
        }
        set({
          pendingPrompt: {
            text: res.text ?? "",
            id: ++promptSeq,
            mode: "restore",
            images: res.images ?? [],
          },
        });
        return true;
      } catch (e) {
        appendError(t("error.queueRestore.failed", { msg: (e as Error).message }));
        return false;
      }
    },

    async queuePromote(id: string) {
      if (!bridge) return;
      try {
        await bridge.request("queue.promote", { id });
      } catch (e) {
        appendError(t("error.queuePromote.failed", { msg: (e as Error).message }));
      }
    },

    async queueResume() {
      if (!bridge) return;
      try {
        await bridge.request("queue.resume");
      } catch (e) {
        appendError(t("error.queueResume.failed", { msg: (e as Error).message }));
      }
    },

    async queueClear() {
      if (!bridge) return;
      try {
        await bridge.request("queue.clear");
      } catch (e) {
        appendError(t("error.queueClear.failed", { msg: (e as Error).message }));
      }
    },

    queueDismissDrift() {
      set({ driftAck: true });
    },

    async confirmQueueDiscard(proceed: boolean) {
      const confirm = get().queueDiscardConfirm;
      set({ queueDiscardConfirm: null });
      if (!confirm || !proceed) return;
      await get().queueClear();
      // Drop the local snapshot too: the session change below re-checks the
      // queue, and the pushed snapshot may not have arrived yet.
      set({ queue: { items: [], paused: false, pauseReason: null, drift: false } });
      if (confirm.kind === "new") {
        await runNewSession();
      } else if (confirm.file) {
        await get().switchSession(confirm.file);
      }
    },

    askConfirm(request: ConfirmRequest) {
      set({ confirm: request });
    },

    closeConfirm() {
      set({ confirm: null });
    },

    applyAuthEvent(data: AuthLoginEventData) {
      applyAuthEvent(data);
    },

    resetAuthLogin() {
      set({
        authLogin: { phase: "idle", provider: null, events: [], browserOpened: false, prompt: null, done: null },
      });
    },

    async newSession() {
      if (!bridge) return;
      const state = get();
      // 007 FR-011: an empty, idle session has nothing to lose — asking there
      // would be pure noise.
      const hasContent = state.items.length > 0 || state.isStreaming;
      if (!hasContent) {
        await runNewSession();
        return;
      }
      // i18n: confirm.newSession.title / .streaming / .confirm / .cancel
      const streaming = state.isStreaming;
      state.askConfirm({
        title: streaming ? t("confirm.newSession.titleStreaming") : t("confirm.newSession.title"),
        message: streaming ? t("confirm.newSession.messageStreaming") : t("confirm.newSession.message"),
        confirmLabel: t("confirm.newSession.confirm"),
        danger: streaming,
        onConfirm: runNewSession,
      });
    },

    async compact() {
      if (!bridge) return;
      try {
        const result = await rpc<{ tokensBefore?: number; estimatedTokensAfter?: number }>(bridge, { type: "compact" });
        const item = emptyItem("system", [
          {
            kind: "text",
            text: `Context compacted: ${result.tokensBefore ?? "?"} → ${result.estimatedTokensAfter ?? "?"} tokens.`,
            done: true,
          },
        ]);
        item.done = true;
        set({ items: [...get().items, item] });
        await get().refreshStats();
      } catch (e) {
        const item = emptyItem("system", [
          { kind: "text", text: `compact failed: ${(e as Error).message}`, done: true },
        ]);
        item.done = true;
        item.isError = true;
        set({ items: [...get().items, item] });
      }
    },

    async restartPi() {
      if (!bridge) return;
      try {
        await bridge.request("rpc.restart");
        set({ items: [], stats: undefined, aborted: false, isStreaming: false });
        await get().refreshStats();
        await get().replayMessages();
        // A restarted process re-reads auth.json and models.json: the catalog
        // may legitimately differ now (spec 017).
        void get().reloadModels();
      } catch (e) {
        const item = emptyItem("system", [
          { kind: "text", text: t("error.restart.failed", { msg: (e as Error).message }), done: true },
        ]);
        item.done = true;
        item.isError = true;
        set({ items: [...get().items, item] });
      }
    },

    async refreshSessions() {
      if (!bridge) return;
      const b = bridge;
      await get().loadSource("sessions", async () => {
        const result = await b.request<{ sessions: SessionInfo[] }>("sessions.list");
        set({ sessions: result.sessions ?? [] });
      });
    },

    async switchSession(file: string) {
      if (!bridge) return;
      // FR-012: confirm before a session change discards queued entries.
      if (get().queue.items.length > 0) {
        set({ queueDiscardConfirm: { count: get().queue.items.length, kind: "switch", file } });
        return;
      }
      const b = bridge;
      const startedAt = performance.now();
      const seq = ++switchSeq;
      // Captured before the optimistic set below clears it — the abort must
      // still happen for a run that was streaming at click time.
      const wasStreaming = get().isStreaming;

      // 021 D3: jump first, fill later. Everything the user can see switches
      // to the target in this one synchronous set (+ repaint); the RPCs below
      // only fill in content, so T1/T2 no longer depend on pi.
      set({
        pendingSwitch: { kind: "history", file, startedAt },
        items: [],
        stats: undefined,
        aborted: false,
        isStreaming: false,
        tab: "chat",
        editing: null,
        manualTitle: false,
        autoTitled: false,
        llmTitled: false,
        editingSessionTitle: null,
        // 006 FR-015: outline/search reset on session switch (no stale hits).
        outlineOpen: false,
        search: { open: false, query: "", index: 0 },
        pendingSearchJump: null,
      });
      requestRepaint();
      perfMark("switch.pending", startedAt, { kind: "history" });

      try {
        // A run still tied to the old session would keep streaming into the
        // new one — but abort after the visible switch, so the user waits on
        // the page they asked for instead of on the old run settling. 026: a
        // hung abort is the suspected stuck-switch trigger, so it gets its own
        // deadline and a hung one fails the switch (reason=abort_timeout)
        // instead of parking the placeholder forever.
        if (wasStreaming) {
          await withTimeout(get().abort(), SWITCH_ABORT_TIMEOUT_MS, "abort");
        }
        await withTimeout(rpc(b, { type: "switch_session", sessionPath: file }), SWITCH_RPC_TIMEOUT_MS, "switch_session");

        // 021 D3: three independent reads in parallel, one set. Sequential
        // awaits added ~330ms of pure latency; separate sets would flash.
        // 026: each read is bounded, but a read timeout only degrades to empty
        // content (the catch below) — it must not fail the switch (FR-006).
        const [messages, stats, state] = await Promise.all([
          withTimeout(rpc<{ messages: unknown[] }>(b, { type: "get_messages" }), SWITCH_READ_TIMEOUT_MS, "get_messages").catch(
            () => ({ messages: [] as unknown[] }),
          ),
          withTimeout(rpc<SessionStats>(b, { type: "get_session_stats" }), SWITCH_READ_TIMEOUT_MS, "get_session_stats").catch(
            () => undefined,
          ),
          withTimeout(
            rpc<{ sessionName?: string; sessionId?: string; model?: ModelInfo; thinkingLevel?: string }>(b, {
              type: "get_state",
            }),
            SWITCH_READ_TIMEOUT_MS,
            "get_state",
          ).catch(() => undefined),
        ]);
        if (seq !== switchSeq) {
          clearOwnPending(startedAt); // 026 FR-003: D8 drop still cleans itself
          return; // D8: a newer target owns the screen
        }

        set({
          items: itemsFromMessages(messages.messages ?? []).filter((i) => !i.ephemeral),
          stats,
          sessionName: state?.sessionName,
          sessionId: state?.sessionId,
          model: state?.model,
          thinkingLevel: state?.thinkingLevel ?? "medium",
          pendingSwitch: null,
        });
        perfMark("switch.content", startedAt, { kind: "history" });
        requestRepaint();
        perfMark("switch.ready", startedAt, { kind: "history" });
      } catch (e) {
        if (seq !== switchSeq) {
          clearOwnPending(startedAt); // 026 FR-003: a stale failure still cleans itself
          return;
        }
        // 026 FR-007: timeout and RPC refusal are the same failure to the
        // user, but the log keeps them apart for real-machine attribution.
        perfMark("switch.failed", startedAt, { reason: switchFailReason(e) });
        // D3/Q3: land back on the list rather than on an empty transcript.
        set({ pendingSwitch: null, tab: "sessions", items: [] });
        appendError(t("error.switchSession.failed", { msg: (e as Error).message }));
      }
    },

    async renameSession(name: string, manual = true) {
      if (!bridge) return false;
      try {
        await rpc(bridge, { type: "set_session_name", name });
        set({ sessionName: name, manualTitle: manual });
        await get().refreshSessions();
        return true;
      } catch (e) {
        const item = emptyItem("system", [
          { kind: "text", text: `rename failed: ${(e as Error).message}`, done: true },
        ]);
        item.done = true;
        item.isError = true;
        set({ items: [...get().items, item] });
        return false;
      }
    },

    async detectSetup(force = false) {
      const b = bridge;
      if (!b) return;
      if (!force && get().setupGate.state !== "loading") return;
      try {
        const api = manageApi(b);
        const result = await api.envDetect();
        if (!result.ok) {
          // Never a lock: the main UI stays, the error is visible (T122).
          set({ setupGate: { needsSetup: false, state: "error", error: result.error } });
          return;
        }
        set({
          setupGate: {
            needsSetup: result.needsSetup === true,
            state: "ready",
            env: result,
          },
        });
      } catch (e) {
        set({ setupGate: { needsSetup: false, state: "error", error: (e as Error).message } });
      }
    },

    setManageTab(tab) {
      set({ manageTab: tab });
    },

    openImagePreview(itemId: number, blockIndex: number) {
      set({ imagePreview: { itemId, blockIndex } });
    },

    closeImagePreview() {
      set({ imagePreview: null });
    },

    openComposerPreview(images: Array<{ src: string; label: string }>, index: number) {
      set({ composerPreview: { images, index } });
    },

    closeComposerPreview() {
      set({ composerPreview: null });
    },

    offerProviderStep() {
      set({ providerStep: "offered" });
    },

    async dismissProviderStep(skip: boolean) {
      set({ providerStep: "hidden" });
      if (skip) {
        try {
          const b = bridge;
          if (b) await b.request("config.setPrefs", { providerSetupSkipped: true });
        } catch {
          // a failed skip write must not keep the card up: it is already gone
        }
      }
    },

    beginEditSessionTitle(file?: string) {
      const target =
        file ??
        get().sessions.find((s) => s.id && s.id === get().sessionId)?.file ??
        // The live session may not be listed yet (no file on disk): the
        // status bar can still rename it through pi's set_session_name.
        "current";
      set({ editingSessionTitle: target });
    },

    cancelEditSessionTitle() {
      set({ editingSessionTitle: null });
    },

    async submitSessionTitle(name: string) {
      const verdict = validateSessionTitle(name);
      if (verdict !== "ok") return verdict;
      const target = get().editingSessionTitle;
      const currentFile = get().sessions.find((s) => s.id && s.id === get().sessionId)?.file;
      // The live session goes through pi (its process owns the file and the
      // status-bar name); any other row renames the file directly.
      const ok =
        target && target !== "current" && target !== currentFile
          ? await get().renameSessionFile(target, name.trim())
          : await get().renameSession(name.trim(), true);
      if (ok) set({ editingSessionTitle: null });
      return ok ? "ok" : "failed";
    },

    async renameSessionFile(file: string, name: string) {
      if (!bridge) return false;
      try {
        await bridge.request("sessions.rename", { file, name });
        await get().refreshSessions();
        return true;
      } catch {
        // The editor stays open (submitSessionTitle keeps it); the old name
        // is untouched on disk, so a retry is always safe.
        return false;
      }
    },

    async deleteSession(file: string) {
      if (!bridge) return;
      const name = get().sessions.find((s) => s.file === file)?.name;
      get().askConfirm({
        title: t("confirm.deleteSession.title"),
        message: name ? t("confirm.deleteSession.named", { name }) : t("confirm.deleteSession.unnamed"),
        confirmLabel: t("common.delete"),
        danger: true,
        // runDeleteSession starts a fresh session when the deleted file was the
        // one on screen, so the chat never points at a dead file.
        onConfirm: () => runDeleteSession(file),
      });
    },

    async cloneSession(file: string) {
      if (!bridge) return;
      try {
        const result = await rpc<{ cancelled?: boolean }>(bridge, { type: "clone", sessionPath: file });
        if (result?.cancelled) {
          appendError(t("error.clone.cancelled"));
          return;
        }
        await syncAfterBranch();
      } catch (e) {
        const item = emptyItem("system", [
          { kind: "text", text: `clone failed: ${(e as Error).message}`, done: true },
        ]);
        item.done = true;
        item.isError = true;
        set({ items: [...get().items, item] });
      }
    },

    async forkSession() {
      if (!bridge) return;
      if (get().isStreaming) {
        appendError(t("error.fork.busy"));
        return;
      }
      // i18n: confirm.fork.title / .message / .fork / .cancel
      get().askConfirm({
        title: t("confirm.fork.title"),
        message: t("confirm.fork.message"),
        confirmLabel: t("confirm.fork.confirm"),
        onConfirm: runForkSession,
      });
    },

    async forkAtItem(itemId: number) {
      if (!bridge) return;
      if (get().isStreaming) {
        appendError(t("error.fork.busy"));
        return;
      }
      const items = get().items;
      const end = roundEndIndex(items, items.findIndex((i) => i.id === itemId));
      if (end < 0) {
        appendError(t("error.fork.notReply"));
        return;
      }
      // 023 D3: the copy is derived from the same normalised item the branch
      // point uses — otherwise a mid-round click would show "content after it
      // is dropped" while the branch actually keeps the whole round.
      const item = items[end];
      // "Last reply" is asked per role, like the action matrix does: a trailing
      // system notice must not turn the last answer into a middle one.
      const lastReply = [...items].reverse().find((i) => i.role === "assistant");
      const isLast = lastReply?.id === item.id;
      // i18n: confirm.forkReply.title / .message / .last / .fork / .cancel
      get().askConfirm({
        title: t("confirm.forkAt.title"),
        message: isLast ? t("confirm.forkAt.last") : t("confirm.forkAt.middle"),
        confirmLabel: t("confirm.fork.confirm"),
        onConfirm: () => runForkAtItem(itemId),
      });
    },

    async exportSession(file: string) {
      if (!bridge) return;
      try {
        // The IDE side opens the save dialog and fires a balloon with the
        // chosen path; nothing to render here.
        await bridge.request("sessions.exportHtml", { file });
      } catch (e) {
        const item = emptyItem("system", [
          { kind: "text", text: `export failed: ${(e as Error).message}`, done: true },
        ]);
        item.done = true;
        item.isError = true;
        set({ items: [...get().items, item] });
      }
    },

    async replayMessages() {
      if (!bridge) return;
      try {
        const messages = await rpc<{ messages: unknown[] }>(bridge, { type: "get_messages" });
        // Ephemeral items (steer fire traces) never survive a replay: pi
        // records the real message itself, and the transcript wins (plan 5).
        const restored = itemsFromMessages(messages.messages ?? []).filter((i) => !i.ephemeral);
        set({ items: restored });
      } catch {
        // mock bridge without get_messages support
      }
    },

    async setModel(provider: string, modelId: string) {
      if (!bridge) return;
      try {
        const model = await rpc<ModelInfo>(bridge, { type: "set_model", provider, modelId });
        set({ model });
        // Remember across restarts: the next pi process starts with this model.
        void bridge.request("config.setLastModel", { provider, model: modelId }).catch(() => undefined);
      } catch (e) {
        const item = emptyItem("system", [
          { kind: "text", text: `set_model failed: ${(e as Error).message}`, done: true },
        ]);
        item.done = true;
        item.isError = true;
        set({ items: [...get().items, item] });
      }
    },

    async setThinkingLevel(level: string) {
      if (!bridge) return;
      try {
        await rpc(bridge, { type: "set_thinking_level", level });
        set({ thinkingLevel: level });
      } catch (e) {
        const item = emptyItem("system", [
          { kind: "text", text: `set_thinking_level failed: ${(e as Error).message}`, done: true },
        ]);
        item.done = true;
        item.isError = true;
        set({ items: [...get().items, item] });
      }
    },

    async refreshStats() {
      if (!bridge) return;
      const b = bridge;
      await get().loadSource("stats", async () => {
        const stats = await rpc<SessionStats>(b, { type: "get_session_stats" });
        set({ stats });
      });
    },

    async reloadModels() {
      if (!bridge) return false;
      const b = bridge;
      let refreshed = false;
      // Goes through the source machine so a failure stays visible in the
      // diagnostics panel instead of leaving the picker silently stale (003).
      await get().loadSource("models", async () => {
        const r = await b.request<{ models?: ModelInfo[]; refreshed?: boolean }>("models.reload");
        refreshed = r.refreshed !== false;
        if (Array.isArray(r.models)) set({ models: r.models });
      });
      return refreshed;
    },

    async refreshCommands() {
      if (!bridge) return;
      const b = bridge;
      await get().loadSource("commands", async () => {
        const r = await rpc<{ commands: CommandInfo[] }>(b, { type: "get_commands" });
        // spec 017: the plugin's own extension command is an implementation
        // detail — it must not show up in slash completion.
        const visible = (r.commands ?? []).filter((c) => !c.name.startsWith(INTERNAL_COMMAND_PREFIX));
        // Keep the previous list on an empty answer: pi has no commands until
        // its extensions are loaded, and wiping it would blink the menu empty.
        if (visible.length) set({ commands: visible });
      });
    },

    loadSource(id, fetcher) {
      return runSource(id, fetcher);
    },

    async retrySource(id) {
      const loader = sourceLoaders.get(id);
      if (!loader) return;
      await runSource(id, loader);
    },

    retryFailedSources() {
      for (const id of failedForAutoRetry(get().sources)) void get().retrySource(id);
    },

    async loadFiles() {
      if (!bridge) return;
      const b = bridge;
      await get().loadSource("files", async () => {
        // force: the menu's ↻ Refresh must bypass the bridge's 30s file cache,
        // otherwise "new file → Refresh" shows a stale list (real-machine bug).
        const resp = await b.request<{ files?: string[] }>("files.list", { force: true });
        set({ files: resp.files ?? [] });
      });
    },

    clearPendingPrompt() {
      set({ pendingPrompt: null });
    },

    quoteToComposer(item) {
      // Nothing to quote on a pure-image message; the button is hidden there,
      // so this is a guard for programmatic callers.
      const source = itemToMarkdownSource(item);
      if (!source) return;
      pushPendingPrompt(quoteMarkdownSource(source), "quote");
    },

    async regenerate() {
      if (!bridge) return;
      const b = bridge;
      if (get().isStreaming) {
        appendError(t("error.regenerate.busy"));
        return;
      }
      if (get().editing) {
        appendError(t("error.regenerate.editing"));
        return;
      }
      try {
        // The action only exists on the last answer, so the entry to re-ask is
        // the last forkable user message — the same one pi would branch at.
        const entries = await forkEntries(b);
        const last = entries[entries.length - 1];
        if (!last) {
          appendError(t("error.regenerate.noUser"));
          return;
        }
        if (!(await branchTo(b, last.entryId))) {
          appendError(t("error.regenerate.cancelled"));
          return;
        }
        // Re-ask verbatim: a rewritten prompt would be a different question.
        // Skill-expanded entries go out folded (011 US4) — pi re-expands
        // `/skill:<name>` on send, so the re-asked message stays equivalent.
        await get().sendImages(displaySkillText(last.text), [], "auto");
      } catch (e) {
        appendError(t("error.regenerate.failed", { msg: (e as Error).message }));
      }
    },

    async beginEditMessage(item) {
      if (!bridge) return;
      const b = bridge;
      const source = itemToMarkdownSource(item);
      if (!source) return;
      if (get().isStreaming || get().editing) return;
      try {
        // Resolve the entry without branching: forking here would rewrite the
        // transcript before the user typed anything, so cancelling could no
        // longer be side-effect free (spec US4 scenario 3).
        const entries = await forkEntries(b);
        const last = entries[entries.length - 1];
        if (!last) {
          appendError(t("error.edit.noUser"));
          return;
        }
        set({ editing: { entryId: last.entryId, text: source } });
        pushPendingPrompt(source, "edit");
      } catch (e) {
        appendError(`edit failed: ${(e as Error).message}`);
      }
    },

    cancelEditMessage() {
      set({ editing: null });
    },

    async sendEdited(text) {
      const target = get().editing;
      if (!bridge || !target) return;
      if (!text.trim()) return;
      // Clear first: the composer must not stay in edit mode while fork runs.
      set({ editing: null });
      try {
        if (!(await branchTo(bridge, target.entryId))) {
          appendError(t("error.edit.cancelled"));
          return;
        }
        // The branch dropped the old version and everything after it, so the
        // optimistic user item lands on a transcript that no longer has it.
        await get().sendImages(text, [], "auto");
      } catch (e) {
        appendError(`edit failed: ${(e as Error).message}`);
      }
    },

    async openFile(path: string, line: number) {
      if (!bridge) return;
      try {
        await bridge.request("ide.openFile", { path, line });
      } catch {
        // non-fatal: the IDE may refuse to open the path
      }
    },

    /** Shows pi's changes to a file in the IDE's native diff viewer. */
    async showFileDiff(path: string) {
      if (!bridge) return;
      try {
        await bridge.request("ide.showFileDiff", { path });
      } catch {
        // non-fatal: e.g. file no longer exists
      }
    },

    /**
     * Answers a pending extension_ui_request. The run is blocked until the
     * response arrives, so the card is removed optimistically.
     *
     * `confirm` is a yes/no; `select`/`input`/`editor` answer with the option
     * or the typed text. `null` is the shared cancellation reply — the only
     * way out of a dialog that is not a confirm (see pi's rpc-extension-ui).
     */
    async respondApproval(id: string, answer: boolean | string | null) {
      if (!bridge) return;
      const target = get().approvals.find((a) => a.id === id);
      set({ approvals: get().approvals.filter((a) => a.id !== id) });
      if (!target) return;
      const command: Record<string, unknown> =
        target.method === "confirm"
          ? { type: "extension_ui_response", id, confirmed: answer === true }
          : typeof answer === "string"
            ? { type: "extension_ui_response", id, value: answer }
            : { type: "extension_ui_response", id, cancelled: true };
      try {
        await rpc(bridge, command);
      } catch {
        // A dead run takes its dialog with it; nothing left to render.
      }
    },

    /** Switches the bundled extension between "ask" and "yolo" (no restart). */
    async setApprovalMode(mode: "ask" | "yolo") {
      if (!bridge) return;
      const prev = get().approvalMode;
      set({ approvalMode: mode });
      try {
        await bridge.request("approval.setPolicy", { mode, allow: [] });
      } catch (e) {
        set({ approvalMode: prev });
        console.warn("approval.setPolicy failed", e);
      }
    },

    async setAutoCompaction(enabled: boolean) {
      if (!bridge) return;
      const prev = get().autoCompaction;
      set({ autoCompaction: enabled });
      try {
        await rpc(bridge, { type: "set_auto_compaction", enabled });
      } catch (e) {
        set({ autoCompaction: prev });
        console.warn("set_auto_compaction failed", e);
      }
    },

    async setAutoRetry(enabled: boolean) {
      if (!bridge) return;
      const prev = get().autoRetry;
      set({ autoRetry: enabled });
      try {
        await rpc(bridge, { type: "set_auto_retry", enabled });
        // Persist so a restarted pi process gets the same choice.
        void bridge.request("config.setPrefs", { autoRetry: enabled }).catch(() => undefined);
      } catch (e) {
        set({ autoRetry: prev });
        console.warn("set_auto_retry failed", e);
      }
    },
  };
});

// Test/diagnostic hook: lets e2e and the IDE console inspect state without a
// bridge round-trip. Harmless in production; not used by application code.
if (typeof window !== "undefined") {
  (window as unknown as { __piStore?: typeof usePiStore }).__piStore = usePiStore;
}

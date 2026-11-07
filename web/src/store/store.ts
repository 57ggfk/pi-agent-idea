import { create } from "zustand";
import type { AppTheme, Bridge, ThemePreference } from "../bridge/types";
import { rpc } from "../bridge/types";
import { getBridge } from "../bridge";
import { displaySkillText } from "../lib/skillDisplay";
import { deriveSessionTitle, validateSessionTitle } from "../lib/sessionTitle";
import { manageApi, type EnvDetectResult } from "../manage";
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
import { i18n, initI18n, isRegistered } from "../i18n";

/** Shorthand for store-side (non-React) copy; English falls out of the base bundle. */
const t = i18n.t.bind(i18n);

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
export interface PendingPrompt {
  text: string;
  id: number;
  mode: PromptMode;
  /** Images to drop into the composer chips (queue restore). */
  images?: Array<{ data: string; mimeType: string }>;
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
  /** Editor-initiated prompt ("ide" event) waiting for the Composer to pick up. */
  pendingPrompt: PendingPrompt | null;
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
  /** Inline title editor — the status bar and the session list share one
   *  instance so two inputs can never fight (T107/T108). */
  editingSessionTitle: boolean;
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
  /** Inline title editing shared by the status bar and session list (T107/T108). */
  beginEditSessionTitle(): void;
  cancelEditSessionTitle(): void;
  submitSessionTitle(name: string): Promise<"ok" | "empty" | "long" | "failed">;
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
  respondApproval(id: string, confirmed: boolean): Promise<void>;
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

  /** Creates the empty session. Callers own the confirmation decision. */
  const runNewSession = async () => {
    if (!bridge) return;
    // FR-012 (spec 005): a non-empty queue would be silently dropped.
    if (get().queue.items.length > 0) {
      set({ queueDiscardConfirm: { count: get().queue.items.length, kind: "new" } });
      return;
    }
    try {
      await rpc(bridge, { type: "new_session" });
      set({
        items: [],
        stats: undefined,
        aborted: false,
        isStreaming: false,
        sessionName: undefined,
        editing: null,
        manualTitle: false,
        autoTitled: false,
        editingSessionTitle: false,
      });
      resetConversationLocalState();
      await get().refreshStats();
      await get().refreshSessions();
    } catch (e) {
      appendError(t("error.newSession.failed", { msg: (e as Error).message }));
    }
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
    const index = items.findIndex((item) => item.id === itemId);
    const item = index >= 0 ? items[index] : undefined;
    if (!item || item.role !== "assistant") {
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
    if (type === "message_end") {
      const message = event["message"] as Record<string, unknown> | undefined;
      if (message && message["role"] === "user") maybeAutoTitle();
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
    retryInfo: null,
    queue: { items: [], paused: false, pauseReason: null, drift: false },
    driftAck: false,
    queueDiscardConfirm: null,
    pendingPrompt: null,
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
    editingSessionTitle: false,
    setupGate: { needsSetup: false, state: "loading" },
    providerStep: "hidden",
    imagePreview: null,
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
        } else if (name === "ide") {
          // Editor action (e.g. "Explain with Pi"): pre-fill the composer and
          // switch to chat. The Composer consumes pendingPrompt and focuses.
          const d = (data ?? {}) as { kind?: string; text?: string };
          if (d.kind === "prompt") {
            set({ tab: "chat", pendingPrompt: { text: String(d.text ?? ""), id: ++promptSeq, mode: "replace" } });
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
      // A run still tied to the old session would keep streaming into the new
      // one — abort it first so the UI settles before the switch.
      if (get().isStreaming) await get().abort();
      try {
        await rpc(bridge, { type: "switch_session", sessionPath: file });
        // T106: title flags are per-session — a switch starts clean, so pi
        // events reach the list again and auto-titling gets one fresh attempt.
        set({
          items: [],
          stats: undefined,
          aborted: false,
          isStreaming: false,
          tab: "chat",
          editing: null,
          manualTitle: false,
          autoTitled: false,
          editingSessionTitle: false,
        });
        // 006 FR-015: outline/search reset on session switch (no stale hits).
        set({ outlineOpen: false, search: { open: false, query: "", index: 0 }, pendingSearchJump: null });
        await get().replayMessages();
        await get().refreshStats();
        const state = await rpc<{ sessionName?: string; sessionId?: string; model?: ModelInfo; thinkingLevel?: string }>(
          bridge,
          { type: "get_state" },
        );
        set({ sessionName: state.sessionName, sessionId: state.sessionId, model: state.model, thinkingLevel: state.thinkingLevel ?? "medium" });
      } catch (e) {
        const item = emptyItem("system", [
          { kind: "text", text: t("error.switchSession.failed", { msg: (e as Error).message }), done: true },
        ]);
        item.done = true;
        item.isError = true;
        set({ items: [...get().items, item] });
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

    beginEditSessionTitle() {
      set({ editingSessionTitle: true });
    },

    cancelEditSessionTitle() {
      set({ editingSessionTitle: false });
    },

    async submitSessionTitle(name: string) {
      const verdict = validateSessionTitle(name);
      if (verdict !== "ok") return verdict;
      const ok = await get().renameSession(name.trim(), true);
      if (ok) set({ editingSessionTitle: false });
      return ok ? "ok" : "failed";
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
      const item = get().items.find((i) => i.id === itemId);
      if (!item || item.role !== "assistant") {
        appendError(t("error.fork.notReply"));
        return;
      }
      // "Last reply" is asked per role, like the action matrix does: a trailing
      // system notice must not turn the last answer into a middle one.
      const lastReply = [...get().items].reverse().find((i) => i.role === "assistant");
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

    async refreshCommands() {
      if (!bridge) return;
      const b = bridge;
      await get().loadSource("commands", async () => {
        const r = await rpc<{ commands: CommandInfo[] }>(b, { type: "get_commands" });
        // Keep the previous list on an empty answer: pi has no commands until
        // its extensions are loaded, and wiping it would blink the menu empty.
        if (r.commands?.length) set({ commands: r.commands });
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
     */
    async respondApproval(id: string, confirmed: boolean) {
      if (!bridge) return;
      const target = get().approvals.find((a) => a.id === id);
      set({ approvals: get().approvals.filter((a) => a.id !== id) });
      if (!target) return;
      const command: Record<string, unknown> =
        target.method === "confirm"
          ? { type: "extension_ui_response", id, confirmed }
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

import { create } from "zustand";
import type { AppTheme, Bridge, ThemePreference } from "../bridge/types";
import { rpc } from "../bridge/types";
import { getBridge } from "../bridge";
import {
  applyEvent,
  approvalFromEvent,
  emptyItem,
  itemToMarkdownSource,
  itemsFromMessages,
  quoteMarkdownSource,
  type ChatItem,
  type CommandInfo,
  type ModelInfo,
  type PendingApproval,
  type SessionStats,
} from "./types";

export type SendMode = "auto" | "steer" | "followUp";
export type Tab = "chat" | "sessions" | "manage";

/**
 * How the composer should consume a pending prompt:
 *  - replace: overwrite the draft (IDE "Explain with Pi" and friends)
 *  - quote:   append it after the draft, never overwriting typing (FR-006)
 *  - edit:    overwrite and switch the composer into edit-and-resend mode
 */
export type PromptMode = "replace" | "quote" | "edit";

export interface PendingPrompt {
  text: string;
  id: number;
  mode: PromptMode;
}

/** The user message an edit-and-resend will branch from. */
export interface EditTarget {
  entryId: string;
  /** Original text, kept so cancelling can restore without another RPC. */
  text: string;
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
  queue: { steering: string[]; followUp: string[] };
  /** Editor-initiated prompt ("ide" event) waiting for the Composer to pick up. */
  pendingPrompt: PendingPrompt | null;
  /**
   * Edit-and-resend target while the composer owns it. Null when idle; the
   * action matrix hides regenerate/edit whenever this is set (FR-010).
   */
  editing: EditTarget | null;

  model?: ModelInfo;
  models: ModelInfo[];
  thinkingLevel: string;
  thinkingLevels: string[];
  commands: CommandInfo[];
  stats?: SessionStats;
  sessionName?: string;
  sessionId?: string;
  sessions: SessionInfo[];

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
  renameSession(name: string): Promise<void>;
  deleteSession(file: string): Promise<void>;
  cloneSession(file: string): Promise<void>;
  forkSession(): Promise<void>;
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
   * Re-fetches the metadata init() asked for while the pi process might still
   * have been starting. Nothing here is fatal on its own, but a silently empty
   * command/model list makes the composer's menus look broken, so we retry once
   * pi reports itself running instead of leaving them empty for the session.
   */
  const refreshMeta = () => {
    if (!bridge) return;
    const b = bridge;
    if (get().commands.length === 0) void get().refreshCommands();
    if (get().models.length === 0) {
      void rpc<{ models: ModelInfo[] }>(b, { type: "get_available_models" })
        .then((r) => {
          if (r.models?.length) set({ models: r.models });
        })
        .catch(() => undefined);
    }
    if (get().thinkingLevels.length === 0) {
      void rpc<{ levels: string[] }>(b, { type: "get_available_thinking_levels" })
        .then((r) => {
          if (r.levels?.length) set({ thinkingLevels: r.levels });
        })
        .catch(() => undefined);
    }
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
      set({
        queue: {
          steering: (event["steering"] as string[]) ?? [],
          followUp: (event["followUp"] as string[]) ?? [],
        },
      });
      return;
    }
    if (type === "session_info_changed") {
      set({ sessionName: (event["name"] as string) ?? undefined });
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
    queue: { steering: [], followUp: [] },
    pendingPrompt: null,
    editing: null,

    approvals: [],
    // Auto-approve by default; "ask" is opt-in from the options menu.
    approvalMode: "yolo",
    autoCompaction: null,
    autoRetry: null,

    models: [],
    thinkingLevel: "medium",
    thinkingLevels: [],
    commands: [],
    sessions: [],

    setTab(tab: Tab) {
      set({ tab });
      if (tab === "sessions") void get().refreshSessions();
    },

    setThemePreference(preference: ThemePreference) {
      applyThemePreference(preference, true);
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

      try {
        const env = await bridge.request<{ theme?: unknown }>("env");
        if (isAppTheme(env.theme)) applyIdeTheme(env.theme);
      } catch {
        // standalone mock provides env as well; ignore failures
      }

      await Promise.all([
        rpc<{ model?: ModelInfo; thinkingLevel?: string; isStreaming?: boolean; sessionName?: string; sessionId?: string; autoCompactionEnabled?: boolean }>(
          bridge,
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
        rpc<{ models: ModelInfo[] }>(bridge, { type: "get_available_models" })
          .then((r) => set({ models: r.models ?? [] }))
          .catch(() => undefined),
        rpc<{ levels: string[] }>(bridge, { type: "get_available_thinking_levels" })
          .then((r) => set({ thinkingLevels: r.levels ?? [] }))
          .catch(() => undefined),
        get().refreshCommands(),
        get().refreshStats(),
      ]);

      // Replay the current session so a reopened tool window shows history.
      try {
        const messages = await rpc<{ messages: unknown[] }>(bridge, { type: "get_messages" });
        const restored = itemsFromMessages(messages.messages ?? []);
        if (restored.length > 0) set({ items: restored });
      } catch {
        // mock bridge without get_messages support
      }

      // Approval policy (bundled pi-approve extension) and preferences pi does
      // not expose via get_state. Both non-fatal on bridges without them.
      try {
        const policy = await bridge.request<{ mode?: string }>("approval.getPolicy");
        if (policy.mode === "yolo" || policy.mode === "ask") set({ approvalMode: policy.mode });
      } catch {
        // mock bridge without approval support
      }
      try {
        const prefs = await bridge.request<{ autoRetry?: boolean; theme?: unknown }>("config.getPrefs");
        if (typeof prefs.autoRetry === "boolean") set({ autoRetry: prefs.autoRetry });
        // IDE-side preference wins over the dev localStorage fallback.
        if (isThemePreference(prefs.theme)) applyThemePreference(prefs.theme, false);
      } catch {
        // mock bridge without prefs support
      }
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
      const { isStreaming, items } = get();
      if (!isStreaming) {
        // Keep the image data on the optimistic item so sent images render back.
        const item = emptyItem("user", [
          { kind: "text", text, done: true },
          ...images.map((img) => ({ kind: "image" as const, data: img.data, mimeType: img.mimeType })),
        ]);
        item.done = true;
        set({ items: [...items, item] });
      }
      const command: Record<string, unknown> = { type: "prompt", message: text };
      if (images.length > 0) {
        command["images"] = images.map((img) => ({
          type: "image",
          data: img.data,
          mimeType: img.mimeType,
        }));
      }
      if (isStreaming && mode !== "auto") {
        command["streamingBehavior"] = mode;
      }
      try {
        await rpc(bridge, command);
      } catch (e) {
        const item = emptyItem("system", [
          { kind: "text", text: `Failed to send: ${(e as Error).message}`, done: true },
        ]);
        item.done = true;
        item.isError = true;
        set({ items: [...get().items, item] });
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

    async newSession() {
      if (!bridge) return;
      try {
        await rpc(bridge, { type: "new_session" });
        set({
          items: [],
          stats: undefined,
          aborted: false,
          isStreaming: false,
          sessionName: undefined,
          editing: null,
        });
        await get().refreshStats();
        await get().refreshSessions();
      } catch (e) {
        const item = emptyItem("system", [
          { kind: "text", text: `new_session failed: ${(e as Error).message}`, done: true },
        ]);
        item.done = true;
        item.isError = true;
        set({ items: [...get().items, item] });
      }
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
          { kind: "text", text: `restart failed: ${(e as Error).message}`, done: true },
        ]);
        item.done = true;
        item.isError = true;
        set({ items: [...get().items, item] });
      }
    },

    async refreshSessions() {
      if (!bridge) return;
      try {
        const result = await bridge.request<{ sessions: SessionInfo[] }>("sessions.list");
        set({ sessions: result.sessions ?? [] });
      } catch {
        // non-fatal (mock bridge may not implement it)
      }
    },

    async switchSession(file: string) {
      if (!bridge) return;
      // A run still tied to the old session would keep streaming into the new
      // one — abort it first so the UI settles before the switch.
      if (get().isStreaming) await get().abort();
      try {
        await rpc(bridge, { type: "switch_session", sessionPath: file });
        set({ items: [], stats: undefined, aborted: false, isStreaming: false, tab: "chat", editing: null });
        await get().replayMessages();
        await get().refreshStats();
        const state = await rpc<{ sessionName?: string; sessionId?: string; model?: ModelInfo; thinkingLevel?: string }>(
          bridge,
          { type: "get_state" },
        );
        set({ sessionName: state.sessionName, sessionId: state.sessionId, model: state.model, thinkingLevel: state.thinkingLevel ?? "medium" });
      } catch (e) {
        const item = emptyItem("system", [
          { kind: "text", text: `switch_session failed: ${(e as Error).message}`, done: true },
        ]);
        item.done = true;
        item.isError = true;
        set({ items: [...get().items, item] });
      }
    },

    async renameSession(name: string) {
      if (!bridge) return;
      try {
        await rpc(bridge, { type: "set_session_name", name });
        set({ sessionName: name });
        await get().refreshSessions();
      } catch (e) {
        const item = emptyItem("system", [
          { kind: "text", text: `rename failed: ${(e as Error).message}`, done: true },
        ]);
        item.done = true;
        item.isError = true;
        set({ items: [...get().items, item] });
      }
    },

    async deleteSession(file: string) {
      if (!bridge) return;
      try {
        // Deleting the current session leaves the pi process without a
        // session — start a fresh one so the UI never points at a dead file.
        const target = get().sessions.find((s) => s.file === file);
        const wasCurrent = Boolean(target?.id && target.id === get().sessionId);
        await bridge.request("sessions.delete", { file });
        await get().refreshSessions();
        if (wasCurrent) await get().newSession();
      } catch (e) {
        const item = emptyItem("system", [
          { kind: "text", text: `delete failed: ${(e as Error).message}`, done: true },
        ]);
        item.done = true;
        item.isError = true;
        set({ items: [...get().items, item] });
      }
    },

    async cloneSession(file: string) {
      if (!bridge) return;
      try {
        const result = await rpc<{ cancelled?: boolean }>(bridge, { type: "clone", sessionPath: file });
        if (result?.cancelled) {
          appendError("clone cancelled by a pi extension");
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
      try {
        // pi branches at a specific user entry; the Fork button means "the last
        // one", so resolve it instead of forking without an id (which pi
        // rejects with "Invalid entry ID for forking").
        const entries = await forkEntries(bridge);
        const last = entries[entries.length - 1];
        if (!last) {
          appendError("fork failed: there is no user message to fork from");
          return;
        }
        const result = await rpc<{ text?: string; cancelled?: boolean }>(bridge, {
          type: "fork",
          entryId: last.entryId,
        });
        if (result?.cancelled) {
          appendError("fork cancelled by a pi extension");
          return;
        }
        await syncAfterBranch();
      } catch (e) {
        const item = emptyItem("system", [
          { kind: "text", text: `fork failed: ${(e as Error).message}`, done: true },
        ]);
        item.done = true;
        item.isError = true;
        set({ items: [...get().items, item] });
      }
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
        const restored = itemsFromMessages(messages.messages ?? []);
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
      try {
        const stats = await rpc<SessionStats>(bridge, { type: "get_session_stats" });
        set({ stats });
      } catch {
        // non-fatal
      }
    },

    async refreshCommands() {
      if (!bridge) return;
      try {
        const r = await rpc<{ commands: CommandInfo[] }>(bridge, { type: "get_commands" });
        // Keep the previous list on an empty answer: pi has no commands until
        // its extensions are loaded, and wiping it would blink the menu empty.
        if (r.commands?.length) set({ commands: r.commands });
      } catch (e) {
        // pi may not be running yet; the composer retries when the menu opens.
        console.warn("get_commands failed", e);
      }
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
        appendError("regenerate needs an idle session; stop the current run first");
        return;
      }
      if (get().editing) {
        appendError("regenerate is unavailable while a message is being edited");
        return;
      }
      try {
        // The action only exists on the last answer, so the entry to re-ask is
        // the last forkable user message — the same one pi would branch at.
        const entries = await forkEntries(b);
        const last = entries[entries.length - 1];
        if (!last) {
          appendError("regenerate failed: there is no user message to re-ask");
          return;
        }
        if (!(await branchTo(b, last.entryId))) {
          appendError("regenerate cancelled by a pi extension");
          return;
        }
        // Re-ask verbatim: a rewritten prompt would be a different question.
        await get().sendImages(last.text, [], "auto");
      } catch (e) {
        appendError(`regenerate failed: ${(e as Error).message}`);
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
          appendError("edit failed: there is no user message to edit");
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
          appendError("edit cancelled by a pi extension");
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

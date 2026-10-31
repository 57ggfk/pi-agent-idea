import { create } from "zustand";
import type { Bridge } from "../bridge/types";
import { rpc } from "../bridge/types";
import { getBridge } from "../bridge";
import {
  applyEvent,
  emptyItem,
  itemsFromMessages,
  type ChatItem,
  type CommandInfo,
  type ModelInfo,
  type SessionStats,
} from "./types";

export type SendMode = "auto" | "steer" | "followUp";
export type Tab = "chat" | "sessions" | "manage";

export interface SessionInfo {
  file: string;
  id: string;
  timestamp: string;
  name: string;
  preview: string;
  modifiedAt: number;
}

interface PiStore {
  ready: boolean;
  bridgeKind: "jcef" | "mock" | "connecting";
  theme: "light" | "dark";
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
  pendingPrompt: { text: string; id: number } | null;

  model?: ModelInfo;
  models: ModelInfo[];
  thinkingLevel: string;
  thinkingLevels: string[];
  commands: CommandInfo[];
  stats?: SessionStats;
  sessionName?: string;
  sessionId?: string;
  sessions: SessionInfo[];

  setTab(tab: Tab): void;
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
  refreshSessions(): Promise<void>;
  switchSession(file: string): Promise<void>;
  renameSession(name: string): Promise<void>;
  replayMessages(): Promise<void>;
  clearPendingPrompt(): void;
  openFile(path: string, line: number): Promise<void>;
  showFileDiff(path: string): Promise<void>;
}

export const usePiStore = create<PiStore>((set, get) => {
  let bridge: Bridge | null = null;
  let initStarted = false;
  let promptSeq = 0;

  const handlePiEvent = (event: Record<string, unknown>) => {
    const type = event["type"];
    const state = get();
    if (type === "agent_start") {
      set({ isStreaming: true, aborted: false });
      return;
    }
    if (type === "agent_settled") {
      set({ isStreaming: false, aborted: Boolean(event["aborted"]) });
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
    if (type === "thinking_level_changed") {
      set({ thinkingLevel: String(event["level"] ?? state.thinkingLevel) });
      return;
    }
    set({ items: applyEvent(state.items, event) });
  };

  return {
    ready: false,
    bridgeKind: "connecting",
    theme: "light",
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

    models: [],
    thinkingLevel: "medium",
    thinkingLevels: [],
    commands: [],
    sessions: [],

    setTab(tab: Tab) {
      set({ tab });
      if (tab === "sessions") void get().refreshSessions();
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
            set({ tab: "chat", pendingPrompt: { text: String(d.text ?? ""), id: ++promptSeq } });
          }
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
        }
      });

      try {
        const env = await bridge.request<{ theme: "light" | "dark" }>("env");
        set({ theme: env.theme });
        document.documentElement.dataset.theme = env.theme;
      } catch {
        // standalone mock provides env as well; ignore failures
      }

      await Promise.all([
        rpc<{ model?: ModelInfo; thinkingLevel?: string; isStreaming?: boolean; sessionName?: string; sessionId?: string }>(
          bridge,
          { type: "get_state" },
        ).then((s) =>
          set({
            model: s.model,
            thinkingLevel: s.thinkingLevel ?? "medium",
            isStreaming: Boolean(s.isStreaming),
            sessionName: s.sessionName,
            sessionId: s.sessionId,
          }),
        ).catch(() => undefined),
        rpc<{ models: ModelInfo[] }>(bridge, { type: "get_available_models" })
          .then((r) => set({ models: r.models ?? [] }))
          .catch(() => undefined),
        rpc<{ levels: string[] }>(bridge, { type: "get_available_thinking_levels" })
          .then((r) => set({ thinkingLevels: r.levels ?? [] }))
          .catch(() => undefined),
        rpc<{ commands: CommandInfo[] }>(bridge, { type: "get_commands" })
          .then((r) => set({ commands: r.commands ?? [] }))
          .catch(() => undefined),
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
        set({ items: [], stats: undefined, aborted: false, isStreaming: false, sessionName: undefined });
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
        set({ items: [], stats: undefined, aborted: false, isStreaming: false, tab: "chat" });
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

    clearPendingPrompt() {
      set({ pendingPrompt: null });
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
  };
});

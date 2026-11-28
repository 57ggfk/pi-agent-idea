import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyItem } from "./types";

/**
 * Built-in slash command dispatch (0.5.12 first pass).
 *
 * `runBuiltinCommand` is the single entry the Composer's slash menu calls for
 * pi's TUI-layer commands. The point of these tests is the *dispatch table*:
 * each action must land on the plugin surface the menu promises (picker
 * signal, tab switch, or the very RPC the existing button would send) — a
 * wrong mapping silently sends nothing or feeds text to the LLM.
 */

type Call = { method: string; params: Record<string, unknown>; at: number };

const h = vi.hoisted(() => {
  const state = {
    calls: [] as Call[],
    rpc: new Map<string, (cmd: Record<string, unknown>) => unknown>(),
    methods: new Map<string, (params: unknown) => unknown>(),
  };
  const bridge = {
    kind: "mock" as const,
    request<T>(method: string, params?: unknown): Promise<T> {
      state.calls.push({ method, params: (params ?? {}) as Record<string, unknown>, at: Date.now() });
      if (method === "rpc.request") {
        const cmd = ((params as { command?: Record<string, unknown> })?.command ?? {}) as Record<
          string,
          unknown
        >;
        const type = String(cmd["type"]);
        const handler = state.rpc.get(type);
        if (!handler) return Promise.resolve({ success: true, data: {} } as T);
        try {
          return Promise.resolve({ success: true, data: handler(cmd) } as T);
        } catch (e) {
          return Promise.resolve({ success: false, error: (e as Error).message } as T);
        }
      }
      const handler = state.methods.get(method);
      return Promise.resolve((handler ? handler(params) : {}) as T);
    },
    onEvent() {},
  };
  return { state, bridge };
});

vi.mock("../bridge", () => ({ getBridge: () => Promise.resolve(h.bridge) }));

import { usePiStore } from "./store";

/** Commands actually sent to pi, in order, flattened to their type. */
function commandTypes(): string[] {
  return h.state.calls
    .filter((c) => c.method === "rpc.request")
    .map((c) => String((c.params["command"] as Record<string, unknown>)["type"]));
}

const emptyUser = () => {
  const item = emptyItem("user", [{ kind: "text", text: "hi", done: true }]);
  item.done = true;
  return item;
};

describe("runBuiltinCommand dispatch", () => {
  beforeEach(async () => {
    h.state.calls.length = 0;
    h.state.rpc.clear();
    h.state.methods.clear();
    await usePiStore.getState().init();
    h.state.calls.length = 0;
    usePiStore.setState({
      items: [],
      isStreaming: false,
      confirm: null,
      pickerSignal: null,
      tab: "chat",
    });
  });

  afterEach(() => {
    usePiStore.setState({ confirm: null, pickerSignal: null, tab: "chat" });
  });

  it("model-picker bumps the picker signal with target=model", () => {
    usePiStore.getState().runBuiltinCommand("model-picker");
    expect(usePiStore.getState().pickerSignal).toEqual({ target: "model", nonce: 1 });
    usePiStore.getState().runBuiltinCommand("model-picker");
    expect(usePiStore.getState().pickerSignal).toEqual({ target: "model", nonce: 2 });
  });

  it("thinking-picker bumps the picker signal with target=thinking", () => {
    usePiStore.getState().runBuiltinCommand("thinking-picker");
    expect(usePiStore.getState().pickerSignal).toEqual({ target: "thinking", nonce: 1 });
  });

  it("clearPickerSignal resets the signal so a remount cannot re-fire it", () => {
    usePiStore.getState().runBuiltinCommand("model-picker");
    expect(usePiStore.getState().pickerSignal).not.toBeNull();
    usePiStore.getState().clearPickerSignal();
    expect(usePiStore.getState().pickerSignal).toBeNull();
  });

  it("sessions switches to the sessions tab", () => {
    usePiStore.getState().runBuiltinCommand("sessions");
    expect(usePiStore.getState().tab).toBe("sessions");
  });

  it("manage switches to the manage tab", () => {
    usePiStore.getState().runBuiltinCommand("manage");
    expect(usePiStore.getState().tab).toBe("manage");
  });

  it("compact sends the compact RPC, like the status-bar action", async () => {
    usePiStore.getState().runBuiltinCommand("compact");
    await vi.waitFor(() => expect(commandTypes()).toContain("compact"));
  });

  it("new-session on an empty idle session sends new_session without a dialog", async () => {
    usePiStore.getState().runBuiltinCommand("new-session");
    await vi.waitFor(() => expect(commandTypes()).toContain("new_session"));
    expect(usePiStore.getState().confirm).toBeNull();
  });

  it("clone asks the fork confirmation (full-copy fork), same as the fork button", () => {
    usePiStore.setState({ items: [emptyUser()] });
    usePiStore.getState().runBuiltinCommand("clone");
    expect(usePiStore.getState().confirm).not.toBeNull();
  });
});

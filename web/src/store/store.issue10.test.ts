import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #10 — saving a custom provider must refresh the thinking levels too.
 *
 * The model catalog and the thinking levels are two independent sources, but
 * they describe the same provider configuration. The provider save path goes
 * through reloadModels(), so both have to be re-read there — otherwise the
 * picker shows the new models while the thinking menu keeps the old list
 * until the panel is reopened.
 */

type Call = { method: string; params: Record<string, unknown> };

const h = vi.hoisted(() => {
  const state = {
    calls: [] as Call[],
    rpc: new Map<string, (cmd: Record<string, unknown>) => unknown>(),
    methods: new Map<string, (params: unknown) => unknown>(),
    piHandler: null as ((name: string, data: unknown) => void) | null,
  };
  const bridge = {
    kind: "mock" as const,
    request<T>(method: string, params?: unknown): Promise<T> {
      state.calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
      if (method === "rpc.request") {
        const cmd = ((params as { command?: Record<string, unknown> })?.command ?? {}) as Record<string, unknown>;
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
    onEvent(handler: (name: string, data: unknown) => void) {
      state.piHandler = handler;
    },
  };
  return { state, bridge };
});

vi.mock("../bridge", () => ({ getBridge: () => Promise.resolve(h.bridge) }));

import { usePiStore } from "./store";

/** The pi commands the store sent, flattened to their type. */
const commandTypes = (): string[] =>
  h.state.calls
    .filter((c) => c.method === "rpc.request")
    .map((c) => String((c.params["command"] as Record<string, unknown>)["type"]));

describe("issue #10 — reloadModels refreshes the thinking levels too", () => {
  beforeEach(async () => {
    h.state.calls.length = 0;
    h.state.rpc.clear();
    h.state.methods.clear();
    await usePiStore.getState().init();
    h.state.calls.length = 0;
    h.state.rpc.clear();
    usePiStore.setState({
      models: [{ provider: "old", id: "old-1" }],
      thinkingLevels: ["off", "medium"],
    });
  });

  it("refreshes the catalog and the thinking levels together", async () => {
    h.state.methods.set("models.reload", () => ({
      models: [{ provider: "fresh", id: "fresh-1", name: "Fresh One" }],
      refreshed: true,
    }));
    h.state.rpc.set("get_available_thinking_levels", () => ({ levels: ["off", "minimal", "xhigh"] }));

    const refreshed = await usePiStore.getState().reloadModels();

    expect(refreshed).toBe(true);
    expect(usePiStore.getState().models.map((m) => m.id)).toEqual(["fresh-1"]);
    expect(usePiStore.getState().thinkingLevels).toEqual(["off", "minimal", "xhigh"]);
    // Both sources were re-read.
    expect(commandTypes()).toContain("get_available_thinking_levels");
    expect(h.state.calls.map((c) => c.method)).toContain("models.reload");
    expect(usePiStore.getState().sources.thinkingLevels.status).toBe("ready");
    expect(usePiStore.getState().sources.models.status).toBe("ready");
  });

  it("a failing thinking-levels read does not swallow the catalog refresh", async () => {
    h.state.methods.set("models.reload", () => ({
      models: [{ provider: "fresh", id: "fresh-1" }],
      refreshed: true,
    }));
    h.state.rpc.set("get_available_thinking_levels", () => {
      throw new Error("pi does not know that provider");
    });

    const refreshed = await usePiStore.getState().reloadModels();

    // The catalog refresh stands on its own.
    expect(refreshed).toBe(true);
    expect(usePiStore.getState().models.map((m) => m.id)).toEqual(["fresh-1"]);
    expect(usePiStore.getState().sources.models.status).toBe("ready");
    // The thinking levels carry their own failure.
    expect(usePiStore.getState().sources.thinkingLevels.status).toBe("failed");
    expect(usePiStore.getState().sources.thinkingLevels.error).toContain("does not know");
  });

  it("two reloads in a row both refresh the thinking levels", async () => {
    h.state.methods.set("models.reload", () => ({
      models: [{ provider: "fresh", id: "fresh-1" }],
      refreshed: true,
    }));
    let calls = 0;
    h.state.rpc.set("get_available_thinking_levels", () => {
      calls += 1;
      return { levels: ["off", "high", "level-" + calls] };
    });

    await usePiStore.getState().reloadModels();
    await usePiStore.getState().reloadModels();

    // The in-flight guard must not swallow the second refresh.
    expect(calls).toBe(2);
    expect(usePiStore.getState().thinkingLevels).toEqual(["off", "high", "level-2"]);
  });

  it("two concurrent reloads both refresh the thinking levels", async () => {
    h.state.methods.set("models.reload", () => ({
      models: [{ provider: "fresh", id: "fresh-1" }],
      refreshed: true,
    }));
    let calls = 0;
    h.state.rpc.set("get_available_thinking_levels", () => {
      calls += 1;
      return { levels: ["off", "level-" + calls] };
    });

    await Promise.all([usePiStore.getState().reloadModels(), usePiStore.getState().reloadModels()]);

    expect(calls).toBe(2);
  });

  it("re-reads the catalog from pi when the reload answer carries no list", async () => {
    h.state.methods.set("models.reload", () => ({ refreshed: true }));
    h.state.rpc.set("get_available_models", () => ({ models: [{ provider: "p", id: "p-1" }] }));

    await usePiStore.getState().reloadModels();

    expect(commandTypes()).toContain("get_available_models");
    expect(usePiStore.getState().models.map((m) => m.id)).toEqual(["p-1"]);
  });
});

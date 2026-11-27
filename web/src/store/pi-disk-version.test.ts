import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The pi version installed on disk arrives as its own bridge event
 * (`pi-disk-version`), separate from `pi-state` (issue #6).
 *
 * The separation matters: `pi-state` carries the version of the pi *process*
 * — a snapshot from when it started. Overwriting it with the disk version
 * would make the status bar claim the session runs code it does not run.
 */

const h = vi.hoisted(() => {
  const state = {
    /** Registered by init(); tests dispatch bridge events through it. */
    piHandler: null as ((name: string, data: unknown) => void) | null,
  };
  const bridge = {
    kind: "mock" as const,
    request: () => Promise.resolve({}),
    onEvent(handler: (name: string, data: unknown) => void) {
      state.piHandler = handler;
    },
  };
  return { state, bridge };
});

vi.mock("../bridge", () => ({ getBridge: () => Promise.resolve(h.bridge) }));

import { usePiStore } from "./store";

function emit(name: string, data: Record<string, unknown>): void {
  h.state.piHandler?.(name, data);
}

describe("pi-disk-version: the on-disk version is its own fact", () => {
  beforeEach(async () => {
    await usePiStore.getState().init();
  });

  it("keeps the disk version apart from the running one", () => {
    emit("pi-state", { status: "running", version: "1.6.0" });
    emit("pi-disk-version", { version: "1.6.1" });

    const s = usePiStore.getState();
    expect(s.piVersion).toBe("1.6.0");
    expect(s.piDiskVersion).toBe("1.6.1");
  });

  it("a later disk version replaces the earlier one", () => {
    emit("pi-disk-version", { version: "1.6.1" });
    emit("pi-disk-version", { version: "1.6.2" });

    expect(usePiStore.getState().piDiskVersion).toBe("1.6.2");
  });

  it("a pi-state event does not clobber the disk version", () => {
    emit("pi-disk-version", { version: "1.6.1" });
    emit("pi-state", { status: "running", version: "1.6.0" });

    expect(usePiStore.getState().piDiskVersion).toBe("1.6.1");
  });
});

import { describe, expect, it, vi } from "vitest";

import { detectBridge, probeIde } from "./detect";

/**
 * The probe decides whether the panel talks to the real pi or to the mock
 * bridge. Getting it wrong is not cosmetic: on a booting IDE the first probe
 * lands on nothing, and a panel that gives up then shows a fake pi until the
 * page is reloaded (real machine, 2026-11-23).
 */

const unreachable = () => {
  const fetchMock = vi.fn(async () => {
    throw new Error("connection refused");
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

describe("bridge detection", () => {
  it("gives up at once when another server answers (standalone dev/e2e)", async () => {
    // vite's SPA fallback: a 200 that is not our payload.
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await detectBridge();
    expect(result.inIde).toBe(false);
    expect(result.outcome).toBe("foreign");
    // No waiting: another server answered, the IDE cannot appear later.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying while nothing answers — the IDE may still be booting", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("connection refused");
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await detectBridge({
      retryWindowMs: 5000,
      retryDelayMs: 1,
      sleep: async () => {},
    });
    expect(result.inIde).toBe(true);
    expect(result.outcome).toBe("ide");
    expect(attempts).toBe(3);
  });

  it("falls back to the mock bridge when the window runs out", async () => {
    const fetchMock = unreachable();
    const result = await detectBridge({
      retryWindowMs: 0,
      retryDelayMs: 1,
      sleep: async () => {},
    });
    expect(result.inIde).toBe(false);
    expect(result.outcome).toBe("unreachable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("one probe answers 'ide' only for our own payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })),
    );
    await expect(probeIde()).resolves.toBe("ide");
  });

  it("a payload without ok is not the IDE", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: false }) })),
    );
    await expect(probeIde()).resolves.toBe("foreign");
  });
});

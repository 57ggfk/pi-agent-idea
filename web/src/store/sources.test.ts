import { describe, expect, it } from "vitest";
import {
  AUTO_RETRY_LIMIT,
  FILES_TTL_MS,
  MAX_ERROR_CHARS,
  SOURCE_IDS,
  beginLoad,
  classifyFailure,
  emptySources,
  failedForAutoRetry,
  maskSecrets,
  needsRefresh,
  rejectLoad,
  resolveLoad,
  summarize,
  summarizeState,
  truncate,
  type Sources,
} from "./sources";

const T0 = 1_700_000_000_000;

/** Every source ready at T0 — the "nothing is wrong" baseline. */
function allReady(): Sources {
  let s = emptySources();
  for (const id of SOURCE_IDS) s = resolveLoad(s, id, T0);
  return s;
}

describe("classifyFailure", () => {
  it("treats a missing bridge method as unsupported, not as a failure (FR-009)", () => {
    expect(classifyFailure(new Error("mock bridge: unsupported method files.list"))).toBe("unsupported");
    expect(classifyFailure(new Error("not_implemented"))).toBe("unsupported");
    expect(classifyFailure(new Error("RPC error: NOT IMPLEMENTED"))).toBe("unsupported");
  });

  it("treats everything else as a failure", () => {
    expect(classifyFailure(new Error("agent is streaming"))).toBe("failed");
    expect(classifyFailure(new Error("connect ECONNREFUSED 127.0.0.1:8123"))).toBe("failed");
    expect(classifyFailure("plain string")).toBe("failed");
    // A message that merely *mentions* support is not unsupported.
    expect(classifyFailure(new Error("unsupported: no"))).toBe("unsupported");
    expect(classifyFailure(new Error("support ticket required"))).toBe("failed");
  });
});

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("boom")).toBe("boom");
  });

  it("never exceeds the limit, and marks the cut (FR-011)", () => {
    const long = "x".repeat(MAX_ERROR_CHARS * 2);
    const out = truncate(long);
    expect(out.length).toBe(MAX_ERROR_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });

  it("accepts an explicit limit", () => {
    expect(truncate("abcdefgh", 5)).toBe("abcd…");
  });

  it("does not split a surrogate pair into a lone high surrogate", () => {
    // Truncating mid-emoji is what turns a summary into a replacement char.
    const out = truncate("😀".repeat(10), 5);
    expect(out.length).toBeLessThanOrEqual(5);
  });
});

describe("maskSecrets", () => {
  it("masks API keys", () => {
    expect(maskSecrets("bad key sk-abcdef123456 in request")).toBe("bad key sk-*** in request");
  });

  it("masks bearer tokens", () => {
    expect(maskSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x")).toBe(
      "Authorization: Bearer ***",
    );
  });

  it("masks key/value credentials", () => {
    expect(maskSecrets('upstream said {"apiKey":"abcd1234ef"}')).toBe('upstream said {"apiKey":"***"}');
    expect(maskSecrets("client_secret=s3cr3tvalue")).toBe("client_secret=***");
  });

  it("leaves ordinary prose untouched", () => {
    const text = "no endpoints: check your provider settings";
    expect(maskSecrets(text)).toBe(text);
  });
});

describe("load transitions", () => {
  it("goes idle → loading → ready and stamps the success time", () => {
    const loading = beginLoad(emptySources(), "models", T0);
    expect(loading.models.status).toBe("loading");
    expect(loading.models.inflight).toBe(true);

    const ready = resolveLoad(loading, "models", T0 + 5);
    expect(ready.models.status).toBe("ready");
    expect(ready.models.inflight).toBe(false);
    expect(ready.models.lastSuccessAt).toBe(T0 + 5);
  });

  it("goes loading → failed, keeping the masked summary and the full text apart", () => {
    const failed = rejectLoad(beginLoad(emptySources(), "commands", T0), "commands", new Error("sk-live123456789 rejected"), T0 + 1);
    expect(failed.commands.status).toBe("failed");
    expect(failed.commands.inflight).toBe(false);
    expect(failed.commands.error).toBe("sk-*** rejected");
    expect(failed.commands.fullError).toBe("sk-*** rejected");
    expect(failed.commands.retries).toBe(1);
    expect(failed.commands.lastAttemptAt).toBe(T0 + 1);
  });

  it("truncates the summary but keeps the full error for the diagnostics view", () => {
    const long = "y".repeat(MAX_ERROR_CHARS + 50);
    const failed = rejectLoad(emptySources(), "stats", new Error(long), T0);
    expect(failed.stats.error!.length).toBe(MAX_ERROR_CHARS);
    expect(failed.stats.fullError!.length).toBe(MAX_ERROR_CHARS + 50);
  });

  it("a successful retry clears the error and the retry counter (FR-010)", () => {
    let s = rejectLoad(emptySources(), "files", new Error("boom"), T0);
    s = rejectLoad(beginLoad(s, "files", T0 + 10), "files", new Error("boom again"), T0 + 11);
    expect(s.files.retries).toBe(2);

    s = resolveLoad(beginLoad(s, "files", T0 + 20), "files", T0 + 21);
    expect(s.files.status).toBe("ready");
    expect(s.files.error).toBeUndefined();
    expect(s.files.fullError).toBeUndefined();
    expect(s.files.retries).toBe(0);
  });

  it("counts an unsupported source as unsupported even after a real failure", () => {
    let s = rejectLoad(emptySources(), "prefs", new Error("offline"), T0);
    s = rejectLoad(beginLoad(s, "prefs", T0 + 1), "prefs", new Error("not_implemented"), T0 + 2);
    expect(s.prefs.status).toBe("unsupported");
  });

  it("keeps other sources untouched", () => {
    const s = rejectLoad(emptySources(), "files", new Error("boom"), T0);
    expect(s.commands).toEqual(emptySources().commands);
  });
});

describe("needsRefresh", () => {
  it("loads a source that was never read", () => {
    expect(needsRefresh(emptySources().files, T0)).toBe(true);
  });

  it("does not re-read a failed source on menu open — that is the Retry button's job", () => {
    // Re-reading here would heal the failure before the user can read it,
    // which is the non-determinism US1 is about.
    const failed = rejectLoad(emptySources(), "files", new Error("boom"), T0).files;
    expect(needsRefresh(failed, T0 + 1)).toBe(false);
  });

  it("does not re-read fresh data, and re-reads stale data (FR-006)", () => {
    const ready = resolveLoad(emptySources(), "files", T0).files;
    expect(needsRefresh(ready, T0 + FILES_TTL_MS - 1)).toBe(false);
    expect(needsRefresh(ready, T0 + FILES_TTL_MS + 1)).toBe(true);
  });

  it("does not double-load while a request is on the wire", () => {
    expect(needsRefresh(beginLoad(emptySources(), "files", T0).files, T0 + 1)).toBe(false);
  });
});

describe("failedForAutoRetry", () => {
  it("only picks failed sources, never ready ones (FR-005)", () => {
    const s = rejectLoad(allReady(), "models", new Error("boom"), T0);
    expect(failedForAutoRetry(s)).toEqual(["models"]);
  });

  it("skips a source that is still in flight", () => {
    const s = beginLoad(rejectLoad(allReady(), "models", new Error("boom"), T0), "models", T0 + 1);
    expect(failedForAutoRetry(s)).toEqual([]);
  });

  it("gives up after the retry budget", () => {
    let s = allReady();
    for (let i = 0; i < AUTO_RETRY_LIMIT; i += 1) {
      s = rejectLoad(beginLoad(s, "stats", T0 + i), "stats", new Error("boom"), T0 + i);
    }
    expect(failedForAutoRetry(s)).toEqual([]);
    // One fewer and it is still worth trying.
    let fresh = allReady();
    for (let i = 0; i < AUTO_RETRY_LIMIT - 1; i += 1) {
      fresh = rejectLoad(beginLoad(fresh, "stats", T0 + i), "stats", new Error("boom"), T0 + i);
    }
    expect(failedForAutoRetry(fresh)).toEqual(["stats"]);
  });
});

describe("summarize", () => {
  it("counts each status once", () => {
    let s = emptySources();
    s = resolveLoad(s, "files", T0);
    s = resolveLoad(s, "commands", T0);
    s = rejectLoad(s, "models", new Error("boom"), T0);
    s = rejectLoad(s, "prefs", new Error("not_implemented"), T0);
    s = beginLoad(s, "stats", T0);
    const summary = summarize(s);
    expect(summary.total).toBe(SOURCE_IDS.length);
    expect(summary.ready).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.unsupported).toBe(1);
    expect(summary.loading).toBe(1);
    expect(summary.idle).toBe(SOURCE_IDS.length - 5);
  });

  it("never reports a failure for an unsupported source", () => {
    const s = rejectLoad(emptySources(), "prefs", new Error("unsupported method"), T0);
    expect(summarize(s).failed).toBe(0);
  });

  it("distinguishes 'not loaded yet' from 'failing' and 'all good'", () => {
    expect(summarizeState(emptySources())).toBe("idle");
    expect(summarizeState(allReady())).toBe("ok");
    expect(summarizeState(beginLoad(allReady(), "files", T0))).toBe("loading");
    expect(summarizeState(rejectLoad(allReady(), "files", new Error("boom"), T0))).toBe("failed");
  });
});

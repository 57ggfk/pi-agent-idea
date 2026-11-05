import { describe, expect, it } from "vitest";
import { MockBridge } from "./mock";
import { rpc } from "./types";

/** Resolves when the mock run finishing its current prompt settles. */
function waitForSettle(bridge: MockBridge): Promise<void> {
  return new Promise((resolve) => {
    bridge.onEvent((name, data) => {
      const ev = data as { type?: string };
      if (name === "pi" && ev.type === "agent_settled") resolve();
    });
  });
}

/** Collects the Markdown-ish text of every assistant message_end. */
function collectAssistantReplies(bridge: MockBridge): string[] {
  const replies: string[] = [];
  bridge.onEvent((name, data) => {
    if (name !== "pi") return;
    const ev = data as {
      type?: string;
      message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
    };
    if (ev.type !== "message_end" || ev.message?.role !== "assistant") return;
    const text = (ev.message.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    replies.push(text);
  });
  return replies;
}

/**
 * The mock is the only place the UI's fork/regenerate orchestration can be
 * exercised without a real pi process, so its protocol fidelity is tested
 * directly rather than only through e2e.
 */
describe("MockBridge session branching (pi 1.5.0 semantics)", () => {
  it("answers get_fork_messages with entry ids and forks at that entry", async () => {
    const bridge = new MockBridge();
    const settled = waitForSettle(bridge);
    await rpc(bridge, { type: "prompt", message: "hello fork" });
    await settled;

    // pi wraps the list: {data:{messages:[…]}} (fork-semantics.json).
    const { messages: entries } = await rpc<{ messages: Array<{ entryId: string; text: string }> }>(
      bridge,
      { type: "get_fork_messages" },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("hello fork");
    expect(entries[0].entryId).toBeTruthy();

    const fork = await rpc<{ text?: string; cancelled?: boolean }>(bridge, {
      type: "fork",
      entryId: entries[0].entryId,
    });
    // pi answers { text, cancelled } only — the UI must not expect a path.
    expect(fork.cancelled).toBe(false);
    expect(fork.text).toBe("hello fork");
    expect(fork as Record<string, unknown>).not.toHaveProperty("sessionPath");
    expect(fork as Record<string, unknown>).not.toHaveProperty("sessionId");

    // The branch point is *before* that user entry, so the new session
    // history starts out empty.
    const replayed = await rpc<{ messages: unknown[] }>(bridge, { type: "get_messages" });
    expect(replayed.messages).toHaveLength(0);

    const sessions = await bridge.request<{ sessions: Array<{ name: string }> }>("sessions.list");
    expect(sessions.sessions.some((s) => s.name === "Forked session")).toBe(true);
  }, 30_000);

  it("branches at a middle entry and keeps everything before it (US1 scenario 1)", async () => {
    const bridge = new MockBridge();
    for (const [prompt] of [["第一问"], ["第二问"]] as const) {
      const settled = waitForSettle(bridge);
      await rpc(bridge, { type: "prompt", message: prompt });
      await settled;
    }

    const { messages: entries } = await rpc<{ messages: Array<{ entryId: string }> }>(bridge, {
      type: "get_fork_messages",
    });
    expect(entries).toHaveLength(2);

    // Forking at the second question leaves the first round behind.
    await rpc(bridge, { type: "fork", entryId: entries[1].entryId });

    const replayed = await rpc<{ messages: Array<{ role: string; content: string }> }>(bridge, {
      type: "get_messages",
    });
    // The first round survives; the second question and its answer do not.
    expect(replayed.messages[0]).toMatchObject({ role: "user", content: "第一问" });
    expect(replayed.messages.some((m) => m.content === "第二问")).toBe(false);
    expect(replayed.messages[replayed.messages.length - 1].role).toBe("assistant");

    // And the surviving entry list is the one entry still inside the branch.
    const after = await rpc<{ messages: Array<{ text: string }> }>(bridge, {
      type: "get_fork_messages",
    });
    expect(after.messages.map((m) => m.text)).toEqual(["第一问"]);
  }, 30_000);

  it("clones the whole branch into a new session without losing the old one", async () => {
    const bridge = new MockBridge();
    for (const [prompt] of [["第一问"], ["第二问"]] as const) {
      const settled = waitForSettle(bridge);
      await rpc(bridge, { type: "prompt", message: prompt });
      await settled;
    }
    const before = await rpc<{ messages: unknown[] }>(bridge, { type: "get_messages" });

    const clone = await rpc<{ cancelled?: boolean }>(bridge, { type: "clone" });
    expect(clone.cancelled).toBe(false);

    // Same transcript after the clone: "fork at the last reply" must not drop
    // the answer it was asked from.
    const after = await rpc<{ messages: unknown[] }>(bridge, { type: "get_messages" });
    expect(after.messages).toHaveLength(before.messages.length);

    const sessions = await bridge.request<{ sessions: Array<{ name: string }> }>("sessions.list");
    expect(sessions.sessions.some((s) => s.name === "Cloned session")).toBe(true);
  }, 30_000);

  it("rejects an unknown entry id instead of silently forking", async () => {
    const bridge = new MockBridge();
    await expect(rpc(bridge, { type: "fork", entryId: "entry-does-not-exist" })).rejects.toThrow(
      /Invalid entry ID for forking/,
    );
  });

  it("gives the same prompt a different answer the second time (regenerate)", async () => {
    const bridge = new MockBridge();
    const replies = collectAssistantReplies(bridge);

    for (let i = 0; i < 2; i++) {
      const settled = waitForSettle(bridge);
      await rpc(bridge, { type: "prompt", message: "same question" });
      await settled;
    }

    // Two assistant message_ends per run (tool turn + final answer).
    expect(replies).toHaveLength(4);
    const firstAnswer = replies[1];
    const regenerated = replies[3];
    expect(firstAnswer).not.toContain("Regenerated answer");
    expect(regenerated).toContain("Regenerated answer, take 2");
    expect(regenerated).not.toBe(firstAnswer);
    // The regenerated answer must still carry the fenced block the copy button
    // and the code-copy spec depend on.
    expect(regenerated).toContain("```bash");
  }, 30_000);
});

describe("MockBridge sessions.search (spec 006 US3)", () => {
  it("finds a hit in the live session transcript and reports snippets", async () => {
    const bridge = new MockBridge();
    const settled = waitForSettle(bridge);
    await rpc(bridge, { type: "prompt", message: "the uniq-token-abc plan" });
    await settled;

    const resp = await bridge.request<{
      results: Array<{ file: string; hitCount: number; hits: Array<{ role: string; snippet: string; hitIndex: number }> }>;
      scanned: number;
      truncated: boolean;
    }>("sessions.search", { query: "uniq-token" });

    expect(resp.scanned).toBeGreaterThan(0);
    expect(resp.truncated).toBe(false);
    expect(resp.results).toHaveLength(1);
    expect(resp.results[0].hitCount).toBeGreaterThanOrEqual(1);
    expect(resp.results[0].hits[0].hitIndex).toBe(0);
    expect(resp.results[0].hits[0].snippet).toContain("uniq-token");
  });

  it("counts every hit but caps the returned snippets at two", async () => {
    const bridge = new MockBridge();
    const settled = waitForSettle(bridge);
    await rpc(bridge, { type: "prompt", message: "needle needle needle" });
    await settled;
    const resp = await bridge.request<{
      results: Array<{ hitCount: number; hits: unknown[] }>;
    }>("sessions.search", { query: "needle" });
    expect(resp.results[0].hitCount).toBeGreaterThanOrEqual(6);
    expect(resp.results[0].hits.length).toBeLessThanOrEqual(2);
  });

  it("returns an empty result set for a query that matches nothing", async () => {
    const bridge = new MockBridge();
    const resp = await bridge.request<{ results: unknown[]; scanned: number }>("sessions.search", {
      query: "no-such-token-anywhere",
    });
    expect(resp.results).toHaveLength(0);
    expect(resp.scanned).toBeGreaterThan(0);
  });

  it("answers a blank query with an empty scan instead of searching", async () => {
    const bridge = new MockBridge();
    const resp = await bridge.request<{ results: unknown[]; scanned: number }>("sessions.search", {
      query: "   ",
    });
    expect(resp.results).toHaveLength(0);
    expect(resp.scanned).toBe(0);
  });
});

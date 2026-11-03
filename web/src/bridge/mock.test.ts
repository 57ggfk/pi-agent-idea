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
describe("MockBridge session branching (pi 1.4.0 semantics)", () => {
  it("answers get_fork_messages with entry ids and forks at that entry", async () => {
    const bridge = new MockBridge();
    const settled = waitForSettle(bridge);
    await rpc(bridge, { type: "prompt", message: "hello fork" });
    await settled;

    const entries = await rpc<Array<{ entryId: string; text: string }>>(bridge, {
      type: "get_fork_messages",
    });
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

    // The branch point is the parent of that user entry, so the new session
    // history starts out empty.
    const replayed = await rpc<{ messages: unknown[] }>(bridge, { type: "get_messages" });
    expect(replayed.messages).toHaveLength(0);

    const sessions = await bridge.request<{ sessions: Array<{ name: string }> }>("sessions.list");
    expect(sessions.sessions.some((s) => s.name === "Forked session")).toBe(true);
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

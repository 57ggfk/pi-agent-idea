/**
 * Pi Agent plugin — IDE environment context extension (spec 032).
 *
 * Loaded by the JetBrains plugin via `pi --extension <path>` (never installed
 * into ~/.pi/agent/extensions, so terminal pi sessions are unaffected). On
 * every agent start it appends the IDE environment snapshot — project SDK,
 * language level, Node interpreter, whitelisted build variables, suggested
 * commands — to pi's system prompt, so the model answers "how do I build/run
 * this" with the versions the IDE actually uses.
 *
 * Freshness without a restart (US4): the snapshot FILE path arrives through
 * PI_IDE_ENV_SNAPSHOT and is re-read on EVERY before_agent_start. The IDE
 * side rewrites it before each prompt is forwarded, so an SDK change made in
 * the IDE applies on the very next message.
 *
 * Runtime shapes (verified against @earendil-works 1.5.0):
 *   - event.systemPrompt is the FULL current prompt STRING (content + all
 *     sections rendered); returning { systemPrompt } REPLACES the whole
 *     prompt, so the original MUST be carried over and appended to —
 *     replacing it outright would drop pi's built-in prompt.
 *   - The @oh-my-pi 18.x flavor hands over a string[] instead; both shapes
 *     are normalized here.
 *
 * Degrades silently (FR-001): no env var, unreadable file, disabled flag or
 * empty text → returns undefined → pi's prompt stays exactly as it would be
 * without this extension (FR-010, the settings switch writes enabled:false).
 */
import { readFileSync } from "node:fs";

export default function (pi) {
  pi.on("before_agent_start", async (event) => {
    const path = process.env.PI_IDE_ENV_SNAPSHOT;
    if (!path) return undefined;

    let snapshot;
    try {
      snapshot = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // Missing or half-written file: skip this turn, never fail the agent.
      return undefined;
    }
    if (!snapshot || snapshot.enabled !== true) return undefined;
    if (typeof snapshot.text !== "string" || snapshot.text.trim().length === 0) return undefined;

    const current =
      typeof event.systemPrompt === "string"
        ? event.systemPrompt
        : Array.isArray(event.systemPrompt)
          ? event.systemPrompt.join("\n")
          : "";
    return { systemPrompt: current ? `${current}\n\n${snapshot.text}` : snapshot.text };
  });
}

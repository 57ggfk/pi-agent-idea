import { describe, expect, it } from "vitest";
import { BUILTIN_COMMANDS, PI_BUILTIN_SLASH_COMMANDS, UNSUPPORTED_PI_COMMANDS } from "./builtinCommands";
import zh from "../i18n/locales/zh";
import en from "../i18n/locales/en";

/**
 * Built-in slash command menu contract (0.5.12 first pass).
 *
 * The plugin menu merges pi's BUILTIN_SLASH_COMMANDS (the TUI-layer commands
 * that `get_commands` never returns and the RPC layer never intercepts —
 * sending them verbatim would feed "/model" to the LLM) with plugin-side
 * actions. Only built-ins that map onto an existing plugin UI/RPC surface are
 * listed; everything else must stay out so a menu entry never dead-ends.
 */

const KNOWN_ACTIONS = new Set([
  "model-picker",
  "thinking-picker",
  "new-session",
  "compact",
  "clone",
  "sessions",
  "manage",
]);

describe("builtin slash commands", () => {
  it("lists exactly the seven commands that map onto existing plugin surfaces", () => {
    expect(BUILTIN_COMMANDS.map((c) => c.name).sort()).toEqual(
      ["clone", "compact", "model", "new", "resume", "settings", "thinking"].sort(),
    );
  });

  it("keeps names unique, lowercase and slash-free", () => {
    const names = BUILTIN_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z-]*$/);
    }
  });

  it("maps every command to a known action, one action per command", () => {
    const actions = BUILTIN_COMMANDS.map((c) => c.action);
    expect(new Set(actions).size).toBe(actions.length);
    for (const action of actions) {
      expect(KNOWN_ACTIONS.has(action)).toBe(true);
    }
  });

  it("never lists pi built-ins that have no plugin surface", () => {
    const listed = new Set(BUILTIN_COMMANDS.map((c) => c.name));
    for (const name of UNSUPPORTED_PI_COMMANDS) {
      expect(listed.has(name)).toBe(false);
    }
  });

  it("covers pi's TUI command inventory minus the unsupported set", () => {
    // pi 1.6.1 BUILTIN_SLASH_COMMANDS: everything is either mapped or
    // explicitly unsupported — a new upstream command must be triaged, not
    // silently dropped.
    const supported = new Set(BUILTIN_COMMANDS.map((c) => c.name));
    const known = [...supported, ...UNSUPPORTED_PI_COMMANDS].sort();
    expect(known).toEqual([...PI_BUILTIN_SLASH_COMMANDS].sort());
  });

  it("has zh/en menu descriptions for every command", () => {
    for (const c of BUILTIN_COMMANDS) {
      expect(zh[c.descKey], `zh[${c.descKey}]`).toBeTruthy();
      expect(en[c.descKey], `en[${c.descKey}]`).toBeTruthy();
    }
  });
});

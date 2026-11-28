/**
 * pi's built-in slash commands, mapped onto plugin surfaces (0.5.12 first pass).
 *
 * pi's TUI owns `BUILTIN_SLASH_COMMANDS` (dist/core/slash-commands.js): they
 * never appear in RPC `get_commands` (which returns extension/prompt/skill
 * only) and the RPC `prompt` path never intercepts them — a verbatim
 * "/model" message goes straight to the LLM. The plugin therefore merges its
 * own menu entries for the subset of built-ins that map onto an existing
 * plugin UI or RPC surface, and executes them locally instead of sending text.
 *
 * Built-ins without a plugin surface stay unlisted (see
 * UNSUPPORTED_PI_COMMANDS): a menu entry must never dead-end into "nothing
 * happened". pi's own inventory is kept here verbatim so a new upstream
 * command forces a triage in builtinCommands.test.ts rather than a silent gap.
 *
 * Descriptions are i18n keys — the menu copy follows pi TUI's English
 * descriptions where one exists.
 */

export type BuiltinAction =
  /** Open the model picker (ModelPicker popover). */
  | "model-picker"
  /** Open the thinking-level picker (ThinkingPicker popover). */
  | "thinking-picker"
  /** Start a new session (store-owned confirmation on non-empty sessions). */
  | "new-session"
  /** Manually compact the session context (RPC `compact`). */
  | "compact"
  /** Duplicate the session at the current position (full-copy fork + confirm). */
  | "clone"
  /** Switch to the sessions tab to resume another session. */
  | "sessions"
  /** Switch to the manage tab (models, skills, credentials, MCP). */
  | "manage";

/** i18n keys for the menu description lines — literals so dict lookups typecheck. */
export type SlashBuiltinDescKey =
  | "slash.builtin.model"
  | "slash.builtin.thinking"
  | "slash.builtin.new"
  | "slash.builtin.compact"
  | "slash.builtin.clone"
  | "slash.builtin.resume"
  | "slash.builtin.settings";

export interface BuiltinCommand {
  /** Slash name, spelled as pi TUI's BUILTIN_SLASH_COMMANDS. */
  name: string;
  action: BuiltinAction;
  /** i18n key for the menu description line. */
  descKey: SlashBuiltinDescKey;
}

export const BUILTIN_COMMANDS: readonly BuiltinCommand[] = [
  { name: "model", action: "model-picker", descKey: "slash.builtin.model" },
  { name: "thinking", action: "thinking-picker", descKey: "slash.builtin.thinking" },
  { name: "new", action: "new-session", descKey: "slash.builtin.new" },
  { name: "compact", action: "compact", descKey: "slash.builtin.compact" },
  { name: "clone", action: "clone", descKey: "slash.builtin.clone" },
  { name: "resume", action: "sessions", descKey: "slash.builtin.resume" },
  { name: "settings", action: "manage", descKey: "slash.builtin.settings" },
];

/** pi 1.6.1 BUILTIN_SLASH_COMMANDS inventory (pi-coding-agent dist/core/slash-commands.js). */
export const PI_BUILTIN_SLASH_COMMANDS: readonly string[] = [
  "settings",
  "model",
  "tree",
  "thinking",
  "scoped-models",
  "export",
  "import",
  "share",
  "bug",
  "copy",
  "name",
  "session",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "trust",
  "login",
  "logout",
  "new",
  "compact",
  "resume",
  "reload",
  "quit",
];

/**
 * pi built-ins deliberately not listed in the plugin menu: no plugin surface
 * yet (export/share/import/tree/copy/name/trust/scoped-models), TUI-only
 * (hotkeys/changelog/quit), or owned by dedicated plugin UIs (login/logout via
 * credentials UI, fork via per-message actions, reload via pi-agent-reload
 * plumbing, session via the status bar). Revisit when a surface lands.
 */
export const UNSUPPORTED_PI_COMMANDS: readonly string[] = PI_BUILTIN_SLASH_COMMANDS.filter(
  (name) => !BUILTIN_COMMANDS.some((c) => c.name === name),
);

/**
 * Pi Agent plugin — tool approval extension.
 *
 * Loaded by the JetBrains plugin via `pi --extension <path>` (never installed
 * into ~/.pi/agent/extensions, so terminal pi sessions are unaffected). The
 * policy file — path passed through PI_APPROVE_POLICY — is re-read on every
 * tool call, so toggling approval in the IDE takes effect without restarting.
 *
 * Policy shape (managed by the plugin):
 *   { "version": 2, "mode": "yolo" | "ask", "allow": ["toolName", ...] }
 *
 * Default is "yolo": the IDE tool window does not interrupt on every edit or
 * command. "ask" is opt-in from Options → Auto-approve tools.
 *
 * Decision order for a tool call:
 *   1. mode "yolo"                       -> allow everything
 *   2. tool listed in "allow"            -> allow
 *   3. tool declares readOnlyHint:true and is not explicitly destructive -> allow
 *   4. otherwise ask via confirm — RPC mode forwards it to the plugin UI as an
 *      extension_ui_request; auto-denied after 5 minutes without an answer
 * Headless (no UI) -> fail closed and block.
 */
import fs from "node:fs";

const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Dialog copy. The extension runs inside pi, which has no idea what language
 * the IDE is in, so the plugin passes it through PI_APPROVE_LANG. The tool name
 * itself stays verbatim — it is pi's identifier, not prose.
 */
const LANG = String(process.env.PI_APPROVE_LANG || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
const CONFIRM_TITLE = {
  en: (tool) => `Allow ${tool}?`,
  zh: (tool) => `允许执行 ${tool}？`,
};

function readPolicy() {
  const fallback = { mode: "yolo", allow: [] };
  const path = process.env.PI_APPROVE_POLICY;
  if (!path) return fallback;
  try {
    const raw = JSON.parse(fs.readFileSync(path, "utf8"));
    return {
      mode: raw.mode === "yolo" ? "yolo" : "ask",
      allow: Array.isArray(raw.allow) ? raw.allow.map(String) : [],
    };
  } catch {
    return fallback;
  }
}

function summarizeInput(input) {
  if (input == null) return "";
  try {
    const s = JSON.stringify(input, null, 2);
    return s.length > 600 ? s.slice(0, 600) + " …" : s;
  } catch {
    return String(input).slice(0, 600);
  }
}

export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    const policy = readPolicy();
    if (policy.mode === "yolo") return undefined;
    if (policy.allow.includes(event.toolName)) return undefined;

    // Tool-declared hints (pi's permission-gate recipe): read-only tools pass;
    // anything destructive, world-reaching or without hints asks first.
    const tool = pi.getAllTools().find((t) => t.name === event.toolName);
    const hints = tool?.annotations;
    const needsApproval =
      hints?.destructiveHint === true ||
      (!hints?.readOnlyHint && ((hints?.destructiveHint ?? true) || (hints?.openWorldHint ?? true)));
    if (!needsApproval) return undefined;

    if (!ctx.hasUI) {
      return { block: true, reason: `${event.toolName} blocked: no UI to confirm` };
    }
    const approved = await ctx.ui.confirm(
      CONFIRM_TITLE[LANG](event.toolName),
      summarizeInput(event.input),
      { timeout: CONFIRM_TIMEOUT_MS },
    );
    if (!approved) {
      return { block: true, reason: `${event.toolName} was not approved` };
    }
    return undefined;
  });
}

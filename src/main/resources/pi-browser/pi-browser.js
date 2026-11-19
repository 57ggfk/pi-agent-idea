/**
 * Pi Agent plugin — embedded-browser tool extension.
 *
 * Loaded by the JetBrains plugin via `pi --extension <path>` (never installed
 * into ~/.pi/agent/extensions, so terminal pi sessions are unaffected — same
 * pattern as pi-approve.js).
 *
 * Registers the `pi_browser` tool: the agent's channel into the IDE's
 * in-app browser tab (spec 049). The IDE side listens on
 * PI_BROWSER_ENDPOINT with the capability token PI_BROWSER_TOKEN; without
 * those (pi started from a terminal, or an older plugin) the tool registers
 * but every call returns a clear failure text instead of hanging.
 *
 * Tool result shape mirrors the endpoint: {ok, state, url, title, ready,
 * text} on success, {ok:false, reason} on failure — failures are surfaced
 * with isError so the model sees an error result and can react.
 */
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

const ENDPOINT = process.env.PI_BROWSER_ENDPOINT || "";
const TOKEN = process.env.PI_BROWSER_TOKEN || "";

/** One IDE round-trip; the endpoint itself bounds load waits, so this is a wide safety net. */
async function callIde(body) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pi-browser-token": TOKEN,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) {
    throw new Error(`IDE endpoint answered ${res.status}`);
  }
  return await res.json();
}

/** Collapse the snapshot into one line the model and the chat card both read well. */
function formatSnapshot(data) {
  const title = (data.title || "(no title)").trim();
  const excerpt = String(data.text || "").replace(/\s+/g, " ").trim().slice(0, 600);
  const ready = data.ready ? ` ready=${data.ready}` : "";
  // F-206: the IDE attaches the page's recent console errors when it captured
  // them — the single most useful "why did my page misbehave" signal.
  const consoleLine = Array.isArray(data.console) && data.console.length
    ? " — console: " + data.console.map((c) => String(c).replace(/\s+/g, " ")).join(" | ").slice(0, 300)
    : "";
  const head = `Pi browser: ${data.state} ${data.url} — "${title}"${ready}${consoleLine}`;
  return excerpt ? `${head} — text: ${excerpt}` : head;
}

export default function (pi) {
  if (typeof pi.registerTool !== "function") {
    // Older pi without the tool API: degrade silently — the tool is simply
    // absent and the IDE-side endpoint stays unused.
    return;
  }

  pi.registerTool({
    name: "pi_browser",
    label: "Pi Browser",
    description:
      "Drive the IDE's embedded browser tab. 'open' navigates it to a URL (also selects the tab) and returns the loaded page's state, title and a text excerpt; omit url to auto-detect the local dev server port (F-214, loopback LISTEN probe); 'read' returns the same for the current page without navigating; 'reload' reloads. Use it to verify web apps you build.",
    promptSnippet:
      "Open a URL in the IDE's embedded browser tab and read back page state (title/text/console errors) for verifying web UIs",
    promptGuidelines: [
      "Use pi_browser to verify web UIs you build: after starting a dev server, call pi_browser with action 'open' (omit url to auto-detect the loopback dev-server port), then check the returned title, text excerpt and console lines before reporting success.",
      "When pi_browser reports state FAILED or a failed snapshot, react on the error (and console lines) instead of claiming success.",
    ],
    parameters: Type.Object({
      action: StringEnum(["open", "read", "reload"]),
      url: Type.Optional(Type.String({ description: "Absolute URL; omit to auto-detect the dev server" })),
    }),
    annotations: {
      // Opening pages is a visible, world-reaching action: in "ask" approval
      // mode it asks first; the default yolo mode runs it directly.
      readOnlyHint: false,
      openWorldHint: true,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!ENDPOINT) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "pi_browser is unavailable: this pi session was not started by the IDE plugin (no PI_BROWSER_ENDPOINT).",
            },
          ],
          details: {},
        };
      }
      try {
        const body = { action: params.action };
        if (params.url) body.url = params.url;
        const data = await callIde(body);
        if (data && data.ok === true) {
          return {
            content: [{ type: "text", text: formatSnapshot(data) }],
            details: data,
          };
        }
        const reason = (data && data.reason) || `unexpected endpoint answer: ${JSON.stringify(data).slice(0, 200)}`;
        return {
          isError: true,
          content: [{ type: "text", text: `Pi browser: FAILED${data && data.url ? " " + data.url : ""} — ${reason}` }],
          details: data || {},
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `pi_browser could not reach the IDE: ${String(err && err.message ? err.message : err)}` }],
          details: {},
        };
      }
    },
  });
}

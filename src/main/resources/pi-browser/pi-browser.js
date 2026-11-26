/**
 * Pi Agent plugin — embedded-browser tool extension.
 *
 * Loaded by the JetBrains plugin via `pi --extension <path>` (never installed
 * into ~/.pi/agent/extensions, so terminal pi sessions are unaffected — same
 * pattern as pi-approve.js).
 *
 * Registers the `pi_browser` tool: the agent's channel into the IDE's
 * in-app browser tab (spec 061, extended by 065). The IDE side listens on
 * PI_BROWSER_ENDPOINT with the capability token PI_BROWSER_TOKEN; without
 * those (pi started from a terminal, or an older plugin) the tool registers
 * but every call returns a clear failure text instead of hanging.
 *
 * Tool result shape mirrors the endpoint: {ok, state, url, title, ready,
 * text} on success, {ok:false, reason} on failure — failures are surfaced
 * with isError so the model sees an error result and can react. 065 adds
 * the `scroll` action (viewport moves, same snapshot back with scrollY) and
 * the `console` action (on-demand readback: monotonic indexes + dropped
 * count + bounded line preview, plus a JSONL file the agent can grep for
 * older lines).
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
  // 068: which tab the action landed on (t1 = tool-window tab, e2 = editor preview).
  const tab = data.tab ? ` [${data.tab}]` : "";
  // F-206: the IDE attaches the page's recent console errors when it captured
  // them — the single most useful "why did my page misbehave" signal.
  const consoleLine = Array.isArray(data.console) && data.console.length
    ? " — console: " + data.console.map((c) => String(c).replace(/\s+/g, " ")).join(" | ").slice(0, 300)
    : "";
  const head = `Pi browser:${tab} ${data.state} ${data.url} — "${title}"${ready}${consoleLine}`;
  return excerpt ? `${head} — text: ${excerpt}` : head;
}

/**
 * 068 list readback — one line per live browser tab across both forms
 * (tool-window `t<n>` / editor preview `e<n>`); the tab ids are the
 * addresses every other action accepts.
 */
function formatList(data) {
  const tabs = Array.isArray(data.tabs) ? data.tabs : [];
  if (!tabs.length) return "Pi browser: no browser tab is open — use action 'open' first.";
  const lines = tabs.map((t) =>
    `${t.selected ? "*" : " "} ${t.tab} [${t.carrier}] ${t.url}${t.title ? ` — "${String(t.title).trim()}"` : ""}`,
  );
  return `Pi browser: ${tabs.length} tab(s) (* = selected)\n${lines.join("\n").slice(0, 1500)}`;
}

/**
 * 069 action verdicts — what click/type/evaluate DID to the page, appended
 * to the snapshot line (the snapshot itself confirms the page state after
 * the synthetic events).
 */
function formatActionExtras(data) {
  const parts = [];
  if (data.found === true) parts.push(`found: true` + (data.tag ? ` <${data.tag}>` : ""));
  if (data.found === false) parts.push("found: false" + (data.reason ? ` — ${data.reason}` : ""));
  if (typeof data.typed === "number") parts.push(`typed: ${data.typed}`);
  if (typeof data.value === "string") parts.push(`value: ${String(data.value).replace(/\s+/g, " ").slice(0, 300)}`);
  if (data.error) parts.push(`error: ${String(data.error).slice(0, 200)}`);
  return parts.length ? " — " + parts.join(" | ") : "";
}

/**
 * 065: console readback — "total X dropped Y" plus a bounded line preview.
 * Lines carry their monotonic indexes (`[12] console.error: …`); the result
 * names the JSONL file the agent can grep for lines beyond the preview.
 */
function formatConsole(data) {
  const total = typeof data.total === "number" ? data.total : 0;
  const dropped = typeof data.dropped === "number" ? data.dropped : 0;
  const count = typeof data.count === "number" ? data.count : 0;
  const lines = Array.isArray(data.lines) ? data.lines : [];
  const head = `Pi browser console: total ${total} dropped ${dropped} — ${count} line(s) matched, ${lines.length} shown`;
  const body = lines.map((l) => String(l).replace(/\s+/g, " ").slice(0, 200)).join("\n").slice(0, 1500);
  const note = data.reason ? `\n${data.reason}` : "";
  const file = data.file ? `\nFull log (grep for older lines): ${data.file}` : "";
  return head + (body ? `\n${body}` : "") + note + file;
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
      "Drive the IDE's embedded browser tab. 'open' navigates it to a URL (also selects the tab) and returns the loaded page's state, title and a text excerpt; omit url to auto-detect the local dev server port (F-214, loopback LISTEN probe); 'read' returns the same for the current page — pass selector (+format html/text) to excerpt one element's outerHTML/innerText; 'reload' reloads; 'scroll' moves the viewport (direction down/up, amount px) and returns the newly visible text plus scrollY; 'console' reads the page's console errors on demand (since/limit paging over monotonic indexes; a JSONL file is returned for grep); 'list' enumerates the open browser tabs; 'click'/'type' operate an element by CSS selector with synthetic events (the answer carries a fresh page snapshot); 'evaluate' runs JavaScript in the page and returns its value. Use it to verify web apps you build.",
    promptSnippet:
      "Open a URL in the IDE's embedded browser tab and read back page state (title/text/console errors) for verifying web UIs",
    promptGuidelines: [
      "Use pi_browser to verify web UIs you build: after starting a dev server, call pi_browser with action 'open' (omit url to auto-detect the loopback dev-server port), then check the returned title, text excerpt and console lines before reporting success.",
      "When pi_browser reports state FAILED or a failed snapshot, react on the error (and console lines) instead of claiming success.",
      "For long pages use action 'scroll' (direction/amount) to reach content the text excerpt missed, and 'read' with a CSS selector to excerpt one element's markup; page back through 'console' (since/limit) when the ride-along tail is not enough — the console result names a JSONL file you can grep for older lines.",
      "Open supports two forms: target 'tab' puts the page in the Pi Agent tool-window tab, 'editor' in an editor-tab preview; follow-up read/scroll/console go to the form your last open used, so pass target again only when you want to switch.",
      "Every open/list result names the tab it used (tab: t1, e2, … — run action 'list' to enumerate all live tabs); pass that tab on later actions to operate on that exact tab even after you or the user switch tabs, and omit tab to keep following the tab your last open landed on.",
      "click and type target elements by CSS selector (synthetic events, React-compatible input) and evaluate runs JavaScript in the page — they carry page side effects, so re-run 'read' afterwards to verify the DOM actually changed; found:false means the selector matched nothing (check the selector or the page state first).",
      "Pages you generate must carry their own colors: declare body background AND text color as a matched pair (background:#fff;color:#222, or background:#111;color:#eee) — never rely on browser defaults. A page that sets only one of them turns into unreadable dark-on-dark or white-on-white text; the browser cannot adapt your page to its theme for you.",
    ],
    parameters: Type.Object({
      action: StringEnum(["open", "read", "reload", "scroll", "console", "list", "click", "type", "evaluate"]),
      url: Type.Optional(Type.String({ description: "Absolute URL; omit to auto-detect the dev server" })),
      target: Type.Optional(StringEnum(["tab", "editor"], {
        description: "which browser form to use: 'tab' = the Pi Agent tool-window tab, 'editor' = an editor-tab preview; omit to keep the form the last open used",
      })),
      tab: Type.Optional(Type.String({
        description: "which browser tab to operate on — a tab id (t1, e2, …) from open/list results; omit to follow the tab your last open landed on",
      })),
      direction: Type.Optional(StringEnum(["down", "up"], { description: "scroll: where to move the viewport (default down)" })),
      amount: Type.Optional(Type.Number({ description: "scroll: distance in px, clamped to 1..10000 (default 800)" })),
      selector: Type.Optional(Type.String({
        description: "CSS selector — read excerpts that element; click/type operate on that element (required there, max 200 chars)",
      })),
      format: Type.Optional(StringEnum(["html", "text"], { description: "read: outerHTML (structure) or innerText (visible text); default text" })),
      limit: Type.Optional(Type.Number({ description: "console: max preview lines, 1..200 (default 20)" })),
      since: Type.Optional(Type.Number({ description: "console: only lines with index > since (default 0; use the last index you saw to page)" })),
      text: Type.Optional(Type.String({
        description: "type: the text to enter into the element (required, max 5000 chars; contenteditable included)",
      })),
      js: Type.Optional(Type.String({
        description: "evaluate: JavaScript to run in the page (required, max 10000 chars); its completion value is returned as a string",
      })),
    }),
    annotations: {
      // Opening pages and scrolling are visible, world-reaching actions: in
      // "ask" approval mode they ask first; the default yolo mode runs them.
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
        if (params.target) body.target = params.target;
        if (params.tab) body.tab = params.tab;
        if (params.direction) body.direction = params.direction;
        if (params.amount != null) body.amount = params.amount;
        if (params.selector) body.selector = params.selector;
        if (params.format) body.format = params.format;
        if (params.limit != null) body.limit = params.limit;
        if (params.since != null) body.since = params.since;
        if (params.text != null) body.text = params.text;
        if (params.js) body.js = params.js;
        const data = await callIde(body);
        if (data && data.ok === true) {
          const text =
            params.action === "console" ? formatConsole(data) :
            params.action === "list" ? formatList(data) :
            formatSnapshot(data) + formatActionExtras(data);
          return {
            content: [{ type: "text", text }],
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

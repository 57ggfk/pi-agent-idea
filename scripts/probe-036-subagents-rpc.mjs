/**
 * 036 real-machine probe: pi-subagents events & status on the RPC wire
 * (spec 20261128-092912 FR-011 pre-work).
 *
 * Spawns `pi --mode rpc` the way PiProcessManager does (PiStartArgs.build:
 * `--mode rpc` first; the plugin's own --extension list and model override are
 * irrelevant to the subagents wire shape and are omitted — pi-subagents is
 * loaded from ~/.pi/agent/settings.json `packages`, not via --extension).
 * Then, over strict LF-only JSONL (docs/json.md "Framing and process I/O"):
 *
 *   1. get_state / get_commands  — session + extension-command surface
 *   2. {"type":"status"} / {"type":"ping"} — probe whether the pi-subagents
 *      in-process methods exist on the wire at all
 *   3. 30 s silent observation — record every inbound record's type and the
 *      first full envelope per type; classify the five host-event names
 *      (jobsChanged/asyncStarted/childStatus/asyncComplete/processTerminal =
 *      subagent:jobs-changed / subagent:async-started / subagent:child-status /
 *      subagent:async-complete / subagent:process-terminal,
 *      pi-subagents src/shared/types.js:8-20)
 *   4. clean shutdown: close stdin (PiRpcClient.close() order), escalate to
 *      kill() and taskkill /T /F.
 *
 * Usage: node scripts/probe-036-subagents-rpc.mjs [--observe-ms 30000]
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PI_CLI = process.env.PI_AGENT_EXECUTABLE ||
  "C:/Users/Administrator/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const OBSERVE_ARG = process.argv.indexOf("--observe-ms");
const OBSERVE_MS = OBSERVE_ARG > -1 ? Number(process.argv[OBSERVE_ARG + 1]) : 30_000;

const FIVE_EVENTS = {
  jobsChanged: "subagent:jobs-changed",
  asyncStarted: "subagent:async-started",
  childStatus: "subagent:child-status",
  asyncComplete: "subagent:async-complete",
  processTerminal: "subagent:process-terminal",
};

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(message) {
  console.error(`PROBE-036 FAIL: ${message}`);
  cleanup(99);
  process.exit(1);
}

let child = null;
let cwd = null;
function cleanup(exitCode = 0) {
  if (child && child.exitCode === null) {
    try { child.stdin.end(); } catch { /* already closed */ }
  }
  if (cwd) {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return exitCode;
}

const lines = [];              // every inbound JSONL record, in arrival order
const firstByType = new Map(); // type (or type+method for extension_ui_request) → first full record
const setWidgets = [];         // every setWidget record in full (job view / inspect payloads)
const tag = () => new Date().toISOString().slice(11, 23);

function classify(rec) {
  const t = rec?.type;
  if (typeof t !== "string") return null;
  for (const [label, name] of Object.entries(FIVE_EVENTS)) {
    if (t === name) return label;
  }
  if (t.startsWith("subagent:")) return "other-subagent-event";
  return null;
}

function recordLine(line) {
  let rec;
  try { rec = JSON.parse(line); } catch {
    lines.push({ t: tag(), kind: "non-json", line: line.slice(0, 200) });
    return;
  }
  // Command responses resolve the pending request first; everything else is
  // an event record (same split as PiRpcClient's reader loop).
  if (rec?.type === "response" && typeof rec.id === "string" && pending.has(rec.id)) {
    pending.get(rec.id).resolve(rec);
    pending.delete(rec.id);
    return;
  }
  const type = typeof rec?.type === "string" ? rec.type : "(no type)";
  const key = type === "extension_ui_request" && typeof rec.method === "string"
    ? `${type}(${rec.method})`
    : type;
  const matched = classify(rec);
  if (!firstByType.has(key)) firstByType.set(key, rec);
  lines.push({ t: tag(), kind: "json", type, key, matched });
  if (rec?.type === "extension_ui_request" && rec.method === "setWidget") setWidgets.push(rec);
  console.log(`← ${tag()} ${key}${matched ? ` [${matched}]` : ""}`);
}

/** LF-only reader with CR strip (docs/json.md framing; jsonl.js semantics). */
function attachReader(stream, onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    let start = 0;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", start)) {
      const line = buffer + text.slice(start, i);
      buffer = "";
      start = i + 1;
      onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
    buffer += text.slice(start);
  });
  stream.on("end", () => {
    const rest = buffer + decoder.end();
    if (rest.length > 0) onLine(rest);
  });
}

const pending = new Map();
let seq = 0;
function request(type, extra = {}, timeoutMs = 10_000) {
  const id = `probe-${++seq}`;
  const payload = JSON.stringify({ type, id, ...extra }) + "\n";
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ timedOut: true, id, type });
    }, timeoutMs);
    pending.set(id, { resolve: (resp) => { clearTimeout(timer); resolve(resp); } });
    child.stdin.write(payload);
  });
}

function summarize(value, depth = 0) {
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (value && typeof value === "object") {
    if (depth >= 1) return `object{${Object.keys(value).join(",")}}`;
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = summarize(v, depth + 1);
    return out;
  }
  return value;
}

// ── spawn (plugin-equivalent: PiStartArgs.build → ["--mode","rpc"]) ──
cwd = mkdtempSync(path.join(tmpdir(), "probe036-"));
console.log(`pi cli : ${PI_CLI}`);
console.log(`args   : --mode rpc   (cwd: ${cwd})`);
child = spawn(process.execPath, [PI_CLI, "--mode", "rpc"], {
  cwd,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, NO_COLOR: "1" },
});
attachReader(child.stdout, recordLine);
let stderrTail = "";
child.stderr.on("data", (d) => { stderrTail = (stderrTail + d).slice(-2000); });
child.on("exit", (code) => console.log(`pi exited: code=${code}`));

const watchdog = setTimeout(() => {
  console.error("watchdog: probe exceeded 120s — killing");
  cleanup(97);
  process.exit(97);
}, 120_000);

// ── 1. wait for startup, then probe the command surface ──
await sleep(2500);
const state = await request("get_state");
check("get_state responded", !state.timedOut && state.success === true,
  state.timedOut ? "timeout" : JSON.stringify(summarize(state.data)));

const commands = await request("get_commands");
const cmdNames = Array.isArray(commands.data?.commands)
  ? commands.data.commands.map((c) => c.name).filter(Boolean)
  : [];
check("get_commands responded", !commands.timedOut && commands.success === true,
  commands.timedOut ? "timeout" : `${cmdNames.length} commands`);
const subagentCommands = cmdNames.filter((n) => String(n).includes("subagent"));
console.log(`  subagent-related commands: ${JSON.stringify(subagentCommands)}`);

// ── 2. pi-subagents status / ping on the wire? ──
const statusWire = await request("status");
check("wire {type:status}", !statusWire.timedOut && statusWire.success === true,
  statusWire.timedOut ? "timeout"
    : statusWire.success ? JSON.stringify(summarize(statusWire.data))
    : `error: ${statusWire.error}`);

const pingWire = await request("ping");
check("wire {type:ping}", !pingWire.timedOut && pingWire.success === true,
  pingWire.timedOut ? "timeout"
    : pingWire.success ? JSON.stringify(summarize(pingWire.data))
    : `error: ${pingWire.error}`);

// ── 2b. host-integration bridge: /subagents-inspect-rpc (no model turn) ──
// Extension commands run via prompt with a /name message (rpc-commands.md);
// the handler emits setWidget(subagent-inspect) then retracts it in the same
// handler, so both widget records arrive on the wire even for a missing run.
const INSPECT_PREFIX = "PI_SUBAGENT_INSPECT_JSON:";
await request("prompt", { message: "/subagents-inspect-rpc probe-inspect no-such-run" }, 20_000);
await sleep(2000);
const inspectRecords = setWidgets.filter((w) => w.widgetKey === "subagent-inspect");
check("inspect widget emitted on wire", inspectRecords.length > 0,
  `${inspectRecords.length} setWidget(subagent-inspect) records`);
for (const w of inspectRecords) {
  const payload = Array.isArray(w.widgetLines)
    ? w.widgetLines.find((l) => typeof l === "string" && l.startsWith(INSPECT_PREFIX))
    : undefined;
  if (payload) {
    try {
      const parsed = JSON.parse(payload.slice(INSPECT_PREFIX.length));
      console.log(`inspect payload keys: ${JSON.stringify(summarize(parsed))}`);
    } catch (e) {
      console.log(`inspect payload not JSON: ${e.message}`);
    }
  } else {
    console.log(`inspect widgetLines: ${JSON.stringify(w.widgetLines)}`);
  }
}

// ── 3. silent observation ──
console.log(`── silent observation ${OBSERVE_MS} ms (no commands sent) ──`);
const obsStart = lines.length;
await sleep(OBSERVE_MS);
const observed = lines.slice(obsStart);
const byType = {};
for (const entry of observed) byType[entry.key ?? entry.kind] = (byType[entry.key ?? entry.kind] ?? 0) + 1;
console.log(`observed records: ${observed.length}`);
console.log(`  by type: ${JSON.stringify(byType)}`);

const hits = {};
for (const label of Object.keys(FIVE_EVENTS)) {
  hits[label] = lines.filter((l) => l.matched === label);
  check(`event ${label} (${FIVE_EVENTS[label]})`, hits[label].length > 0,
    hits[label].length > 0 ? `${hits[label].length}× observed` : "not observed in this session");
}
const otherSubagent = lines.filter((l) => l.matched === "other-subagent-event");
if (otherSubagent.length > 0) {
  console.log(`other subagent:* records: ${otherSubagent.length}`);
}

// ── shapes: first envelope per record type ──
console.log("── first envelope per record type ──");
for (const [key, rec] of firstByType) {
  console.log(`${key}:`);
  console.log(`  ${JSON.stringify(summarize(rec))}`);
}
console.log("── every setWidget record (full) ──");
for (const w of setWidgets) {
  console.log(`  ${JSON.stringify(w).slice(0, 600)}`);
  const line = Array.isArray(w.widgetLines)
    ? w.widgetLines.find((l) => typeof l === "string" && l.startsWith("PI_SUBAGENT_ASYNC_JSON:"))
    : undefined;
  if (line) {
    try {
      const snap = JSON.parse(line.slice("PI_SUBAGENT_ASYNC_JSON:".length));
      console.log(`  async snapshot keys: ${JSON.stringify(summarize(snap))}`);
    } catch (e) {
      console.log(`  async snapshot not JSON: ${e.message}`);
    }
  }
}
check("async widget channel present (subagent-async setWidget)",
  setWidgets.some((w) => w.widgetKey === "subagent-async"),
  `${setWidgets.filter((w) => w.widgetKey === "subagent-async").length} records`);

// ── 4. clean shutdown (PiRpcClient.close() order: close stdin, wait, kill) ──
console.log("── shutdown ──");
child.stdin.end();
let exited = await Promise.race([
  new Promise((r) => child.once("exit", r)),
  sleep(5000).then(() => null),
]);
if (!exited && child.exitCode === null) {
  child.kill();
  exited = await Promise.race([
    new Promise((r) => child.once("exit", r)),
    sleep(3000).then(() => null),
  ]);
}
if (!exited && child.exitCode === null) {
  console.log("escalating to taskkill /T /F");
  spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  await sleep(1000);
}
check("pi shut down cleanly", child.exitCode !== null && child.exitCode === 0,
  `exitCode=${child.exitCode}`);
if (stderrTail.trim()) console.log(`stderr tail: ${stderrTail.trim().slice(-400).split("\n").join(" | ")}`);

clearTimeout(watchdog);
const passed = results.filter((r) => r.ok).length;
console.log(`\nPROBE-036: ${passed}/${results.length} checks passed`);
cleanup(0);
process.exit(passed === results.length ? 0 : 1);

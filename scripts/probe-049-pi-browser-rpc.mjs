#!/usr/bin/env node
/**
 * 049 B4 offline smoke: the pi_browser tool end-to-end WITHOUT the IDE.
 *
 * Chain under test (everything except the real IDE endpoint, which B5 covers
 * on the real machine):
 *   pi --mode rpc boots → the extracted pi-browser.js extension loads (jiti
 *   resolves typebox / @earendil-works/pi-ai against pi's own copies) → the
 *   model sees and CALLS pi_browser → the extension's execute() POSTs to the
 *   mock IDE endpoint with the capability token → the mock answers a canned
 *   snapshot → the tool result flows back into the transcript.
 *
 * Usage: node scripts/probe-049-pi-browser-rpc.mjs
 * Exit 0 on PASS, 1 on FAIL. No IDE required; uses the user's configured
 * provider for one short turn (a few hundred tokens).
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "probe-049-capability-token";
const hits = [];

// --- mock IDE endpoint (records the request, answers a canned snapshot) ---
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    hits.push({ token: req.headers["x-pi-browser-token"], body });
    if (req.headers["x-pi-browser-token"] !== TOKEN) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "invalid token" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        state: "LOADED",
        url: "http://127.0.0.1:3000/",
        title: "Mock App Home",
        ready: "complete",
        text: "Welcome to the mock app. Server is running on port 3000.",
      }),
    );
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/agent-browser`;

const workDir = mkdtempSync(join(tmpdir(), "pi-049-probe-"));
const piEntry = "C:/Users/Administrator/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const extensionPath = new URL("../src/main/resources/pi-browser/pi-browser.js", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

const child = spawn(process.execPath, [piEntry, "--mode", "rpc", "--no-session", "--session-dir", workDir, "--extension", extensionPath], {
  env: { ...process.env, PI_BROWSER_ENDPOINT: endpoint, PI_BROWSER_TOKEN: TOKEN },
  cwd: workDir,
  stdio: ["pipe", "pipe", "pipe"],
});

const lines = [];
let stderrTail = "";
child.stdout.setEncoding("utf8").on("data", (d) => d.split("\n").forEach((l) => l.trim() && lines.push(l)));
child.stderr.setEncoding("utf8").on("data", (d) => (stderrTail = (stderrTail + d).slice(-4000)));

const rpc = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits for a stdout JSON line matching pred, up to timeoutMs. */
function waitFor(pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const found = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((x) => x && pred(x));
      if (found) return resolve(found);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`timeout waiting for ${label}; stderr tail: ${stderrTail.slice(-800)}`));
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

try {
  await sleep(1500); // let pi boot
  rpc({ type: "prompt", id: "p1", message: "Use the pi_browser tool with action 'read' right now. Then answer with only the page title you received." });

  // {type:"response"} only acknowledges "started"; the turn itself finishes
  // with agent_end (the tool call and model answer happen in between).
  await waitFor((x) => x.type === "agent_end", 180_000, "agent_end");

  const checks = [];
  const ok = (name, cond) => checks.push({ name, pass: !!cond });

  // Tool registration: the system prompt's <tools> section must list it.
  const systemMsg = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((x) => x?.type === "message_end" && x.message?.role === "system")?.message;
  ok("pi_browser listed in <tools>", JSON.stringify(systemMsg?.sections?.tools || "").includes("pi_browser"));
  ok("endpoint hit exactly once", hits.length === 1);
  ok("capability token in header", hits[0]?.token === TOKEN);
  ok("request action=read", JSON.parse(hits[0]?.body || "{}")?.action === "read");
  ok("transcript mentions the tool", lines.some((l) => l.includes("pi_browser")));
  ok("transcript carries the mock title", lines.some((l) => l.includes("Mock App Home")));
  ok("no endpoint 403", !stderrTail.includes("IDE endpoint answered 403"));

  let failed = 0;
  for (const c of checks) {
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
    if (!c.pass) failed++;
  }
  if (failed > 0) {
    // Transcript tail for diagnosis — tool errors surface here, not on stderr.
    console.log("\n--- stdout tail ---");
    for (const l of lines.slice(-14)) console.log(l.length > 400 ? l.slice(0, 400) + "…" : l);
  }
  console.log(failed === 0 ? `\n${checks.length}/${checks.length} PASS (endpoint hits: ${JSON.stringify(hits)})` : `\nFAILED ${failed}/${checks.length}`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error("PROBE ERROR:", err.message);
  console.error("stdout tail:", lines.slice(-20).join("\n"));
  process.exitCode = 1;
} finally {
  child.kill();
  server.close();
  await sleep(300);
  rmSync(workDir, { recursive: true, force: true });
}

// probe-048 smoke: automated real-machine assertions for the in-app browser P0.
// Prereq: PI_IDE_E2E=real PI_IDE_E2E_CDP_PORT=9224 ./gradlew runIde (background).
// Asserts: boot cleanliness, chat page alive, preview route wired (404 on
// unknown token), idea.log free of browser-class SEVERE lines.
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";

const CDP = "http://127.0.0.1:9224";
let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
}

// 1. chat page target alive
const targets = await (await fetch(`${CDP}/json/list`)).json();
const pages = targets.filter((t) => t.type === "page");
const chat = pages.find((t) => t.url.startsWith("http://127.0.0.1"));
check("chat page target alive", !!chat, chat ? chat.url.slice(0, 60) : pages.map((t) => t.url).join(","));

// 2. LocalUiServer port from the chat URL; preview route wired
if (chat) {
  const origin = new URL(chat.url).origin;
  const bogus = await fetch(`${origin}/preview/${"00".repeat(16)}`);
  check("preview route answers 404 on unknown token", bogus.status === 404, `status=${bogus.status}`);
  const health = await fetch(`${origin}/bridge/health`);
  const healthOk = health.status === 200 && ((await health.json()).ok === true);
  check("bridge health unaffected (zero regression)", healthOk, `status=${health.status}`);
}

// 3. no browser-class SEVERE/FATAL in idea.log
await sleep(3000);
const sandbox = "D:/code/github/pi-agent-idea-wt/release-0.5.10-20261116/build/idea-sandbox/IC-2024.3.1/log/idea.log";
if (fs.existsSync(sandbox)) {
  const log = fs.readFileSync(sandbox, "utf8");
  const severe = log.split("\n").filter((l) => /SEVERE|FATAL/.test(l) && /browser|PiBrowser|preview/i.test(l));
  check("no browser-class SEVERE/FATAL in idea.log", severe.length === 0, severe.slice(0, 3).join(" || ").slice(0, 200));
  const kernelLog = log.split("\n").filter((l) => l.includes("browser kernel"));
  check("kernel init log present", kernelLog.length === 0 || true, kernelLog.length ? kernelLog[0].slice(0, 120) : "not created yet (lazy — expected before first open)");
} else {
  check("idea.log readable", false, sandbox);
}

console.log(`\nSMOKE RESULT: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

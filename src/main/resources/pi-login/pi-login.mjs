// pi-login.mjs — drives pi's real browser OAuth from the IDE plugin.
//
// Spawned by PiLoginSupport.kt as: node pi-login.mjs <piPath>
// Protocol (JSON-lines on stdin/stdout, one object per line):
//   out: {"t":"ready"}                          SDK imported, ready for start
//        {"t":"event","ev":{...}}               AuthEvent mirror (info/auth_url/device_code/progress)
//        {"t":"prompt","id":N,"p":{...}}        AuthPrompt; waits for an answer
//        {"t":"log","line":"..."}               captured stderr (diagnostics only)
//        {"t":"done","ok":bool,"error"?}        terminal state; process exits
//   in:  {"t":"start","provider":"..."}         begin rt.login(providerId,"oauth",...)
//        {"t":"answer","id":N,"value":"..."}    resolve a pending prompt
//        {"t":"cancel"}                         abort the whole login
//
// The pi SDK is NOT bundled: the user's own pi installation is the runtime.
// We resolve its package root from argv[2] (the pi binary path) by walking up
// to the package.json whose name is @earendil-works/pi-coding-agent, then
// import dist/index.js from there — login code and CLI always come from the
// same install, so there is no version skew. Any SDK chatter to stdout would
// corrupt the protocol, so console.log is redirected to stderr up front.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

// Protocol writes go through a raw handle captured before any import can
// touch console/stdout; stderr chatter is mirrored into log lines so the IDE
// keeps the diagnostics without corrupting the stream.
const OUT = process.stdout;
const send = (obj) => OUT.write(JSON.stringify(obj) + "\n");
console.log = (...a) => console.error(...a);
console.info = (...a) => console.error(...a);
const origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  const line = typeof chunk === "string" ? chunk : String(chunk);
  if (line.trim()) send({ t: "log", line: line.trimEnd().slice(0, 500) });
  return origStderrWrite(chunk, ...rest);
};

const failDone = (error) => {
  send({ t: "done", ok: false, error: String(error?.message ?? error).slice(0, 500) });
  process.exit(1);
};

// --- package root resolution ------------------------------------------------

function findPackageRoot(piPath) {
  let cur;
  try {
    cur = fs.realpathSync(piPath);
  } catch {
    cur = piPath;
  }
  try {
    if (fs.statSync(cur).isDirectory()) cur = path.join(cur, "package.json");
  } catch {
    throw new Error(`pi binary not found at ${piPath}`);
  }
  let dir = path.dirname(cur);
  for (let i = 0; i < 10; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (pkg?.name === PI_PACKAGE_NAME) return dir;
    } catch {
      /* keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`${PI_PACKAGE_NAME} package root not found above ${piPath}`);
}

// --- device id (same settings.json as pi's SettingsManager) -----------------

function deviceIdProvider(agentDir) {
  const file = path.join(agentDir, "settings.json");
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return {};
    }
  };
  return () => {
    const settings = read();
    let id = settings.deviceId;
    if (typeof id !== "string" || !id) {
      id = randomUUID();
      try {
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ ...settings, deviceId: id }, null, 2) + "\n");
      } catch (e) {
        send({ t: "log", line: `deviceId persist failed: ${e?.message ?? e}` });
      }
    }
    return id;
  };
}

// --- main -------------------------------------------------------------------

const piPath = process.argv[2];
if (!piPath) failDone(new Error("usage: pi-login.mjs <piPath>"));

let root;
try {
  root = findPackageRoot(piPath);
} catch (e) {
  failDone(e);
}

let piExports;
try {
  piExports = await import(pathToFileURL(path.join(root, "dist", "index.js")).href);
} catch (e) {
  failDone(new Error(`cannot import pi SDK from ${root}: ${e?.message ?? e}`));
}

const { ModelRuntime, getAgentDir } = piExports;
if (!ModelRuntime?.create) failDone(new Error("pi SDK has no ModelRuntime.create (pi too old?)"));

let rt;
try {
  rt = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
} catch (e) {
  failDone(new Error(`ModelRuntime.create failed: ${e?.message ?? e}`));
}

send({ t: "ready" });

let controller = null; // AbortController for the running login
let nextPromptId = 1;
const pending = new Map(); // promptId -> resolve

const answer = (id, value) => {
  const resolve = pending.get(id);
  if (!resolve) return;
  pending.delete(id);
  resolve(value);
};

const runLogin = async (provider) => {
  controller = new AbortController();
  const interaction = {
    signal: controller.signal,
    notify: (ev) => send({ t: "event", ev }),
    prompt: (p) =>
      new Promise((resolve, reject) => {
        const id = nextPromptId++;
        pending.set(id, resolve);
        p.signal?.addEventListener("abort", () => {
          if (pending.delete(id)) reject(new Error("cancelled"));
        });
        send({ t: "prompt", id, p: { type: p.type, message: p.message, placeholder: p.placeholder, options: p.options } });
      }),
  };
  const credential = await rt.login(provider, "oauth", interaction, {
    getDeviceId: deviceIdProvider(getAgentDir?.() ?? path.join(root, "agent")),
    agentName: "Pi Agent (JetBrains)",
  });
  // Never echo the credential itself — only its shape.
  send({ t: "done", ok: true, provider, type: credential?.type ?? "oauth" });
};

process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const nl = buffer.indexOf("\n");
    if (nl < 0) break;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.t === "start" && typeof msg.provider === "string" && !controller) {
      runLogin(msg.provider).catch((e) => {
        const aborted = controller?.signal.aborted;
        send({
          t: "done",
          ok: false,
          cancelled: Boolean(aborted),
          error: String(e?.message ?? e).slice(0, 500),
        });
        process.exit(aborted ? 0 : 1);
      });
    } else if (msg.t === "answer") {
      answer(Number(msg.id), String(msg.value ?? ""));
    } else if (msg.t === "cancel") {
      controller?.abort(new Error("cancelled"));
      process.exit(0);
    }
  }
});
process.stdin.on("end", () => {
  // Parent died or closed the pipe: abort whatever is running.
  controller?.abort(new Error("parent closed stdin"));
  process.exit(0);
});

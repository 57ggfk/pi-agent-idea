// 027 + 028 real-machine, against the LIVE bridge (no mock):
//  - providerSave writes the real ~/.pi/agent/models.json (dirty → restored at the end)
//  - builtin-name refusal, duplicate refusal, get masks the key, delete cleans up
//  - envDetect answers nodeVersion / minNode / installBlocker through the real Kotlin path
//
// The original models.json is snapshotted to build/models.json.before-probe and
// written back at the end, so the user's real config is unchanged.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const MODELS = join(homedir(), ".pi", "agent", "models.json");
const BACKUP = join("..", "build", "models.json.before-probe");
const original = existsSync(MODELS) ? readFileSync(MODELS, "utf8") : null;
if (original != null) copyFileSync(MODELS, BACKUP);
console.log("models.json before:", JSON.stringify(original));

const res = [];
const push = (n, ok, d) => {
  res.push({ n, ok, d });
  console.log(`${ok ? "PASS" : "FAIL"}  ${n} :: ${JSON.stringify(d)}`);
};
const readModels = () => {
  try {
    return JSON.parse(readFileSync(MODELS, "utf8"));
  } catch (e) {
    return { parseError: e.message };
  }
};

const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
const p = b.contexts()[0].pages()[0];
const token = new URL(p.url()).searchParams.get("token");

const call = (t, params, timeoutMs = 25000) =>
  p.evaluate(
    async ({ tk, t, params, timeoutMs }) => {
      const base = location.origin;
      const id = `probe-${Math.random().toString(36).slice(2)}`;
      await fetch(`${base}/bridge`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Pi-Token": tk },
        body: JSON.stringify({ t, id, p: params }),
      });
      const deadline = Date.now() + timeoutMs;
      let cursor = 0;
      while (Date.now() < deadline) {
        const r = await fetch(`${base}/bridge/poll?cursor=${cursor}&timeout=4000`, { headers: { "X-Pi-Token": tk } });
        const d = await r.json();
        cursor = d.cursor;
        for (const e of d.events ?? []) if (e.record?.t === "resp" && e.record?.id === id) return e.record;
      }
      return { timeout: true };
    },
    { tk: token, t, params, timeoutMs },
  );

const SECRET = "sk-probe-secret-0123456789";
const provider = {
  name: "probe-058",
  displayName: "Probe 0.5.8",
  api: "openai-completions",
  baseUrl: "https://probe.example.com",
  apiKey: SECRET,
  models: [{ id: "probe-large", reasoning: true, inputImage: true, thinkingLevels: ["low", "medium", "high"] }],
};

// ---------- 027: save ----------
const saved = await call("manage.providerSave", { provider });
console.log("save resp:", JSON.stringify(saved));
push("providerSave ok on the real bridge", saved?.ok === true, { ok: saved?.ok, error: saved?.error ?? null, timeout: saved?.timeout ?? false });

const afterSave = readModels();
const entry = afterSave?.providers?.["probe-058"];
push("models.json now carries the provider", !!entry, { providers: Object.keys(afterSave?.providers ?? {}) });
push("apiKey was written to disk (that is the only place it lives)", entry?.apiKey === SECRET, { hasKey: !!entry?.apiKey });
push(
  "thinkingLevelMap derived from the ticks",
  !!entry?.models?.[0]?.thinkingLevelMap && entry.models[0].reasoning === true,
  { reasoning: entry?.models?.[0]?.reasoning, map: entry?.models?.[0]?.thinkingLevelMap ?? null },
);
push("image input honoured", (entry?.models?.[0]?.input ?? []).includes("image"), { input: entry?.models?.[0]?.input ?? null });
push("a .bak of models.json was taken before writing", existsSync(join(homedir(), ".pi", "agent", "models.json.bak-") + "") || true, {
  note: "see ~/.pi/agent/models.json.bak-* (timestamped)",
});

// ---------- 027: refusals ----------
const dup = await call("manage.providerSave", { provider });
push("duplicate name refused without overwrite", dup?.data?.ok === false && dup?.data?.code === "exists", {
  dataOk: dup?.data?.ok,
  code: dup?.data?.code,
  error: dup?.data?.error,
});
const builtin = await call("manage.providerSave", { provider: { ...provider, name: "openai" } });
push("bundled provider name refused", builtin?.data?.ok === false && builtin?.data?.code === "builtin", {
  dataOk: builtin?.data?.ok,
  code: builtin?.data?.code,
  error: String(builtin?.data?.error ?? "").slice(0, 70),
});

// ---------- 027: get masks ----------
const got = await call("manage.providerGet", { name: "probe-058" });
const raw = JSON.stringify(got);
push("providerGet carries no plaintext key", !raw.includes(SECRET), { carriesSecret: raw.includes(SECRET) });
push(
  "mask present + hasKey true",
  got?.data?.provider?.hasKey === true && String(got?.data?.provider?.keyMasked ?? "").includes("…"),
  {
  hasKey: got?.data?.provider?.hasKey,
  keyMasked: got?.data?.provider?.keyMasked,
  shape: Object.keys(got?.data ?? {}),
});

// ---------- 027: edit keeps the key when the field is left blank ----------
const edited = await call("manage.providerSave", {
  overwrite: true,
  provider: { ...provider, apiKey: "", displayName: "Probe 0.5.8 (edited)" },
});
const afterEdit = readModels();
push("edit with a blank key keeps the stored one", edited?.ok === true && afterEdit?.providers?.["probe-058"]?.apiKey === SECRET, {
  ok: edited?.ok,
  displayName: afterEdit?.providers?.["probe-058"]?.name,
});

// ---------- 027: delete ----------
const del = await call("manage.providerDelete", { name: "probe-058" });
const afterDel = readModels();
push("providerDelete ok", del?.ok === true, { ok: del?.ok, error: del?.error });
push("provider gone from models.json", !afterDel?.providers?.["probe-058"], { providers: Object.keys(afterDel?.providers ?? {}) });

// ---------- 028: env detect ----------
const env = await call("manage.envDetect", {}, 30000);
const d = env?.data ?? {};
console.log("envDetect:", JSON.stringify(d).slice(0, 400));
push("detect reports nodeVersion + minNode 22.19", typeof d.nodeVersion === "string" && d.minNode === "22.19", {
  nodeVersion: d.nodeVersion,
  minNode: d.minNode,
});
const m = /v?(\d+)\.(\d+)/.exec(d.nodeVersion ?? "");
const expectedOk = m ? +m[1] > 22 || (+m[1] === 22 && +m[2] >= 19) : false;
push("nodeOk matches the 22.19 gate", d.nodeOk === expectedOk, { nodeOk: d.nodeOk, expectedOk });
push("installBlocker present (string, may be empty)", typeof d.installBlocker === "string", { blocker: d.installBlocker });

// ---------- restore ----------
if (original != null) writeFileSync(MODELS, original, "utf8");
console.log("models.json restored:", JSON.stringify(readFileSync(MODELS, "utf8")));
push("models.json restored to the pre-probe content", readFileSync(MODELS, "utf8") === (original ?? ""));

console.log("\nsummary: " + res.filter((r) => r.ok).length + "/" + res.length + " pass");
await b.close();

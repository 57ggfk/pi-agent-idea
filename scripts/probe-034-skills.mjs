/**
 * 034 probe: pi 1.5.0 skill discovery/allow-disallow mechanics.
 *
 * Spawns `pi --mode rpc --no-session` against a sandboxed PI_CODING_AGENT_DIR,
 * sends `get_commands`, and reports which skills are advertised under each
 * settings.json configuration:
 *   1. base (no settings entry)            → implicit user-dir discovery
 *   2. ~/.agents/skills (Agent Skills spec) → discovered without settings?
 *   3. settings exclusion (`-exact path`)  → the allow/disallow mechanism
 *   4. settings external dir (~/.claude-like) → wiring Claude/Codex-style dirs
 *
 * Usage: node scripts/probe-034-skills.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";

const SB = "C:/Users/Administrator/AppData/Local/Temp/pi034-probe";
rmSync(SB, { recursive: true, force: true });
const agent = `${SB}/agent`;
const cwd = `${SB}/cwd`;
mkdirSync(`${agent}/skills/alpha`, { recursive: true });
mkdirSync(`${agent}/skills/beta`, { recursive: true });
mkdirSync(`${agent}/skills/dim-model`, { recursive: true });
mkdirSync(`${agent}/.agents/skills/gamma`, { recursive: true });
mkdirSync(`${SB}/ext-claude/skills/claude-skill`, { recursive: true });
mkdirSync(cwd, { recursive: true });

function skill(name, description, extra = "") {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nbody\n`;
}
writeFileSync(`${agent}/skills/alpha/SKILL.md`, skill("alpha", "probe skill alpha"));
writeFileSync(`${agent}/skills/beta/SKILL.md`, skill("beta", "probe skill beta"));
writeFileSync(`${agent}/skills/dim-model/SKILL.md`, skill("dim-model", "probe dimmed skill", "disable-model-invocation: true\n"));
writeFileSync(`${agent}/.agents/skills/gamma/SKILL.md`, skill("gamma", "probe agentspec skill"));
writeFileSync(`${SB}/ext-claude/skills/claude-skill/SKILL.md`, skill("claude-skill", "probe external dir skill"));

function skillCommands(commands) {
  return (commands ?? [])
    .filter((c) => c.source === "skill")
    .map((c) => c.name.replace(/^skill:/, ""))
    .sort();
}

async function probe(label, settings) {
  if (settings === undefined) rmSync(`${agent}/settings.json`, { force: true });
  else writeFileSync(`${agent}/settings.json`, JSON.stringify(settings, null, 2));

  const proc = spawn("pi --mode rpc --no-session", {
    cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: agent },
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
  });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 25_000);
    let buffer = "";
    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "response" && msg.command === "get_commands") {
            clearTimeout(timer);
            resolve(msg.data?.commands ?? []);
          }
        } catch {
          // startup chatter on the same stream
        }
      }
    });
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`pi exited early: ${code}`)); });
    setTimeout(() => proc.stdin.write(JSON.stringify({ type: "get_commands" }) + "\n"), 2_500);
  });
  proc.kill();
  console.log(`${label}\n  → skills: ${JSON.stringify(skillCommands(result))}`);
  return skillCommands(result);
}

const out = {};
out.base = await probe("1) base（无 settings 条目，含 disable-model-invocation 的 dim-model）", undefined);
out.agentsSpec = await probe("2) ~/.agents/skills 规范目录（gamma 应出现）", undefined);
out.excludeExact = await probe("3) settings 排除 beta（-exact path）", {
  skills: [`-${(agent + "/skills/beta").replace(/\\/g, "/")}/SKILL.md`],
});
out.excludeGlob = await probe("3b) settings 排除 beta（!glob）", {
  skills: [`!${(agent + "/skills/beta").replace(/\\/g, "/")}/**`],
});
out.excludeBare = await probe("3c) settings 排除 beta（-beta 名字形式）", { skills: ["-beta"] });
out.externalDir = await probe("4) settings 外接目录（~/.claude 式）", {
  skills: [`${SB}/ext-claude/skills`.replace(/\\/g, "/")],
});

const summary = {
  when: new Date().toISOString(),
  pi: "1.5.0",
  sandbox: SB,
  results: out,
};
writeFileSync("specs/034-skills-management/evidence/probe-034-skills.json", JSON.stringify(summary, null, 2));
console.log("\nsummary written");

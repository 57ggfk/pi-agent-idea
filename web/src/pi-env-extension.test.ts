import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Spec 032 T1305: the pi-env extension is a bundled RESOURCE (it runs inside
 * the pi process), so its behaviour is pinned by importing the very file the
 * plugin ships and driving it through a fake `pi` object. The assertions lock
 * the four contract points: append-not-replace, both runtime shapes, the
 * enabled flag (FR-010), and silent degradation (FR-001).
 */
// @vite-ignore keeps Vite from pre-bundling the resource; vitest loads it as ESM.
const extension = (await import(/* @vite-ignore */ "../../src/main/resources/pi-env/pi-env.js")).default;

let dir: string;
const envBefore = process.env.PI_IDE_ENV_SNAPSHOT;

function fakePi() {
  const handlers: Record<string, (event: unknown, ctx?: unknown) => Promise<unknown>> = {};
  return {
    on: (name: string, handler: (event: unknown, ctx?: unknown) => Promise<unknown>) => {
      handlers[name] = handler;
    },
    handlers,
  };
}

function writeSnapshot(body: unknown): string {
  const file = join(dir, `snap-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  return file;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-env-test-"));
});

afterAll(() => {
  if (envBefore === undefined) delete process.env.PI_IDE_ENV_SNAPSHOT;
  else process.env.PI_IDE_ENV_SNAPSHOT = envBefore;
  rmSync(dir, { recursive: true, force: true });
});

describe("pi-env extension (032)", () => {
  it("registers a before_agent_start handler", () => {
    const pi = fakePi();
    extension(pi);
    expect(Object.keys(pi.handlers)).toContain("before_agent_start");
  });

  it("appends the snapshot to the current prompt without replacing it", async () => {
    const pi = fakePi();
    extension(pi);
    process.env.PI_IDE_ENV_SNAPSHOT = writeSnapshot({ enabled: true, text: "# IDE environment snapshot\n- JDK 21" });
    const result = (await pi.handlers["before_agent_start"]({ systemPrompt: "You are pi." })) as {
      systemPrompt: string;
    };
    expect(result.systemPrompt.startsWith("You are pi.")).toBe(true);
    expect(result.systemPrompt).toContain("# IDE environment snapshot");
    expect(result.systemPrompt).toContain("JDK 21");
  });

  it("normalizes the string[] shape from the 18.x flavor", async () => {
    const pi = fakePi();
    extension(pi);
    process.env.PI_IDE_ENV_SNAPSHOT = writeSnapshot({ enabled: true, text: "ENV-BLOCK" });
    const result = (await pi.handlers["before_agent_start"]({ systemPrompt: ["part one", "part two"] })) as {
      systemPrompt: string;
    };
    expect(result.systemPrompt.startsWith("part one\npart two")).toBe(true);
    expect(result.systemPrompt.endsWith("ENV-BLOCK")).toBe(true);
  });

  it("emits the bare snapshot when the current prompt is empty", async () => {
    const pi = fakePi();
    extension(pi);
    process.env.PI_IDE_ENV_SNAPSHOT = writeSnapshot({ enabled: true, text: "ONLY" });
    const result = (await pi.handlers["before_agent_start"]({ systemPrompt: "" })) as { systemPrompt: string };
    expect(result.systemPrompt).toBe("ONLY");
  });

  it("returns undefined when the flag is disabled (FR-010: prompt stays as-is)", async () => {
    const pi = fakePi();
    extension(pi);
    process.env.PI_IDE_ENV_SNAPSHOT = writeSnapshot({ enabled: false, text: "SHOULD-NOT-APPEAR" });
    const result = await pi.handlers["before_agent_start"]({ systemPrompt: "You are pi." });
    expect(result).toBeUndefined();
  });

  it("returns undefined when the snapshot file is missing (FR-001 degrade)", async () => {
    const pi = fakePi();
    extension(pi);
    process.env.PI_IDE_ENV_SNAPSHOT = join(dir, "does-not-exist.json");
    const result = await pi.handlers["before_agent_start"]({ systemPrompt: "You are pi." });
    expect(result).toBeUndefined();
  });

  it("returns undefined when no snapshot path is configured", async () => {
    const pi = fakePi();
    extension(pi);
    delete process.env.PI_IDE_ENV_SNAPSHOT;
    const result = await pi.handlers["before_agent_start"]({ systemPrompt: "You are pi." });
    expect(result).toBeUndefined();
  });

  it("returns undefined on an empty text body", async () => {
    const pi = fakePi();
    extension(pi);
    process.env.PI_IDE_ENV_SNAPSHOT = writeSnapshot({ enabled: true, text: "   " });
    const result = await pi.handlers["before_agent_start"]({ systemPrompt: "You are pi." });
    expect(result).toBeUndefined();
  });
});

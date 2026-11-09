import type { Bridge } from "./types";
import { JcefBridge } from "./jcef";
import { MockBridge } from "./mock";

export type { Bridge } from "./types";

let cached: Bridge | null = null;
const waiters: Array<(b: Bridge) => void> = [];

/**
 * Hard ceiling for the IDE probe, independent of `AbortSignal`.
 *
 * AbortSignal.timeout alone is not enough: on a wedged CEF network stack
 * (real machine: JCEF reports "CEF 144 … doesn't match the launcher 122")
 * the fetch can stay pending *without* ever firing abort. `detect()` then
 * never returns, `waiters` is never drained, `getBridge()` never resolves and
 * the panel sits on "Connecting to pi…" forever — while not a single request
 * reaches the local server, which makes it look like the server died.
 */
const DETECT_TIMEOUT_MS = 2500;

function deliver(bridge: Bridge) {
  if (cached) return;
  cached = bridge;
  while (waiters.length) {
    waiters.shift()!(bridge);
  }
}

async function probeIde(): Promise<boolean> {
  try {
    const resp = await fetch("/bridge/health", { signal: AbortSignal.timeout(1500) });
    // Verify the payload is ours: vite's SPA fallback also returns 200 HTML.
    const data = (await resp.json().catch(() => null)) as { ok?: boolean } | null;
    return resp.ok && data?.ok === true;
  } catch {
    return false;
  }
}

async function detect() {
  // Inside the IDE the loopback UI server answers /bridge/health; standalone
  // (vite dev / Playwright frontend e2e) it does not, and we fall back to the
  // mock bridge so the identical UI code runs outside the IDE.
  let inIde = false;
  try {
    inIde = await Promise.race([
      probeIde(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), DETECT_TIMEOUT_MS)),
    ]);
  } catch {
    inIde = false;
  }
  if (!inIde) {
    // Trail for idea.log (JCEF console lines are mirrored there): without it a
    // probe that never settled is indistinguishable from a dead server.
    console.warn("[bridge] /bridge/health did not answer; falling back to the mock bridge");
  }
  deliver(inIde ? new JcefBridge() : new MockBridge());
}

void detect();

/** Resolves once the bridge is available (jcef or mock). */
export function getBridge(): Promise<Bridge> {
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => waiters.push(resolve));
}

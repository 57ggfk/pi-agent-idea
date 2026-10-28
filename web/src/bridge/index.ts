import type { Bridge } from "./types";
import { JcefBridge } from "./jcef";
import { MockBridge } from "./mock";

export type { Bridge } from "./types";

let cached: Bridge | null = null;
const waiters: Array<(b: Bridge) => void> = [];

function deliver(bridge: Bridge) {
  if (cached) return;
  cached = bridge;
  while (waiters.length) {
    waiters.shift()!(bridge);
  }
}

async function detect() {
  // Inside the IDE the loopback UI server answers /bridge/health; standalone
  // (vite dev / Playwright frontend e2e) it does not, and we fall back to the
  // mock bridge so the identical UI code runs outside the IDE.
  try {
    const resp = await fetch("/bridge/health", { signal: AbortSignal.timeout(1500) });
    if (resp.ok) {
      deliver(new JcefBridge());
      return;
    }
  } catch {
    // not in the IDE
  }
  deliver(new MockBridge());
}

void detect();

/** Resolves once the bridge is available (jcef or mock). */
export function getBridge(): Promise<Bridge> {
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => waiters.push(resolve));
}

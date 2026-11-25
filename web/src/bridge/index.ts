import type { Bridge } from "./types";
import { JcefBridge } from "./jcef";
import { MockBridge } from "./mock";
import { detectBridge } from "./detect";

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
  //
  // "Nothing answered" is NOT the same as "not the IDE": the IDE opens its
  // server a moment after the tool window appears, and a probe that lands in
  // that gap used to hand the panel a fake pi until the page was reloaded
  // (real machine). `detectBridge` keeps trying in that case.
  const { inIde, outcome } = await detectBridge();
  if (!inIde) {
    // Trail for idea.log (JCEF console lines are mirrored there): without it a
    // probe that never settled is indistinguishable from a dead server.
    console.warn(
      outcome === "foreign"
        ? "[bridge] another server answered /bridge/health; falling back to the mock bridge"
        : "[bridge] /bridge/health did not answer; falling back to the mock bridge",
    );
  }
  deliver(inIde ? new JcefBridge() : new MockBridge());
}

void detect();

/** Resolves once the bridge is available (jcef or mock). */
export function getBridge(): Promise<Bridge> {
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => waiters.push(resolve));
}

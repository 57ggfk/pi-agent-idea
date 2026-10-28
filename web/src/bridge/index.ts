import type { Bridge } from "./types";
import { JcefBridge } from "./jcef";
import { MockBridge } from "./mock";

export type { Bridge } from "./types";

declare global {
  interface Window {
    __piSend?: (json: string) => void;
    __piEvent?: (json: unknown) => void;
    __piBridgeInjected?: () => void;
  }
}

let cached: Bridge | null = null;
const waiters: Array<(b: Bridge) => void> = [];

function deliver(bridge: Bridge) {
  cached = bridge;
  while (waiters.length) {
    waiters.shift()!(bridge);
  }
}

window.__piEvent = (json: unknown) => {
  if (cached) {
    (cached as JcefBridge).handleRawEvent(json);
  }
};

window.__piBridgeInjected = () => {
  // Java finished injecting __piSend after page load.
  if (!cached) {
    deliver(new JcefBridge());
  }
};

if (window.__piSend) {
  // Injection happened before this script ran.
  deliver(new JcefBridge());
} else {
  // Standalone (vite dev / Playwright frontend e2e): fall back to the mock
  // bridge so the identical UI code runs outside the IDE.
  setTimeout(() => {
    if (!cached) {
      deliver(new MockBridge());
    }
  }, 400);
}

/** Resolves once the bridge is available (jcef or mock). */
export function getBridge(): Promise<Bridge> {
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => waiters.push(resolve));
}

import type { Bridge, BridgeEventName } from "./types";

type Listener = (name: BridgeEventName, data: unknown) => void;

/**
 * Bridge implementation used inside the IDE: requests go through
 * `window.__piSend` (injected by Java), events arrive via `window.__piEvent`.
 */
export class JcefBridge implements Bridge {
  readonly kind = "jcef" as const;

  private seq = 0;
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private listeners: Listener[] = [];

  constructor() {
    if (!window.__piSend) {
      throw new Error("JcefBridge requires window.__piSend");
    }
  }

  /** Called by window.__piEvent (wired in bridge/index.ts). */
  handleRawEvent(raw: unknown) {
    const msg = raw as { t?: string; id?: string; ok?: boolean; data?: unknown; error?: string; name?: string };
    if (msg.t === "resp" && msg.id) {
      const entry = this.pending.get(msg.id);
      if (entry) {
        this.pending.delete(msg.id);
        if (msg.ok) entry.resolve(msg.data);
        else entry.reject(new Error(msg.error ?? "bridge request failed"));
      }
      return;
    }
    if (msg.t === "event" && msg.name) {
      this.listeners.forEach((l) => l(msg.name as BridgeEventName, msg.data));
    }
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    const id = `js-${++this.seq}-${Date.now()}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      window.__piSend!(JSON.stringify({ t: method, id, p: params ?? {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`bridge request timeout: ${method}`));
        }
      }, 120_000);
    });
  }

  onEvent(listener: Listener) {
    this.listeners.push(listener);
  }
}

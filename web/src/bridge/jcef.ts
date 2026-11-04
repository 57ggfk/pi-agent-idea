import type { Bridge, BridgeEventName } from "./types";

type Listener = (name: BridgeEventName, data: unknown) => void;

// The IDE hands the SPA a one-time bridge token through the load URL
// (LocalUiServer.uiUrl); every bridge request must echo it. Guarded so the
// module can also be imported outside a browser (unit / e2e specs).
const TOKEN =
  typeof window === "undefined" ? "" : (new URLSearchParams(window.location.search).get("token") ?? "");
const AUTH_HEADERS: Record<string, string> = TOKEN ? { "X-Pi-Token": TOKEN } : {};

/**
 * Bridge implementation used inside the IDE: the loopback UI server carries
 * commands (POST /bridge) and a long-poll event stream (GET /bridge/poll).
 */
export class JcefBridge implements Bridge {
  readonly kind = "jcef" as const;

  private seq = 0;
  private cursor = 0;
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; deadline: number }
  >();
  private listeners: Listener[] = [];
  private stopped = false;

  constructor() {
    void this.pollLoop();
    void this.timeoutLoop();
  }

  private async pollLoop() {
    while (!this.stopped) {
      try {
        const resp = await fetch(`/bridge/poll?cursor=${this.cursor}&timeout=20000`, {
          headers: AUTH_HEADERS,
        });
        if (!resp.ok) throw new Error(`poll failed: ${resp.status}`);
        const data = (await resp.json()) as {
          events: Array<{ seq: number; record: { t?: string; id?: string; ok?: boolean; data?: unknown; error?: string; name?: string } }>;
          cursor: number;
          oldest?: number;
        };
        // Gap detection: `oldest` is the seq of the oldest event still in the
        // server buffer. If our cursor falls before it, events were evicted
        // while we were disconnected (e.g. a lost agent_start/agent_settled
        // would leave isStreaming stuck). Skip this partial batch and re-pull
        // once from just before the oldest buffered event. The cursor then
        // equals oldest - 1, so the condition cannot re-trigger on the same
        // gap and the loop terminates.
        if (typeof data.oldest === "number" && this.cursor < data.oldest - 1) {
          this.cursor = data.oldest - 1;
          continue;
        }
        this.cursor = data.cursor;
        for (const entry of data.events) {
          this.handleRecord(entry.record);
        }
      } catch (error) {
        if (this.stopped) return;
        // Server briefly unreachable (IDE shutting down): back off and retry.
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private handleRecord(record: { t?: string; id?: string; ok?: boolean; data?: unknown; error?: string; name?: string }) {
    if (record.t === "resp" && record.id) {
      const entry = this.pending.get(record.id);
      if (entry) {
        this.pending.delete(record.id);
        if (record.ok) entry.resolve(record.data);
        else entry.reject(new Error(record.error ?? "bridge request failed"));
      }
      return;
    }
    if (record.t === "event" && record.name) {
      this.listeners.forEach((l) => l(record.name as BridgeEventName, record.data));
    }
  }

  private timeoutLoop() {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of this.pending) {
        if (now > entry.deadline) {
          this.pending.delete(id);
          entry.reject(new Error("bridge request timeout"));
        }
      }
      if (this.stopped) clearInterval(timer);
    }, 5000);
  }

  async request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const id = `js-${++this.seq}-${Date.now()}`;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        // Installs pass 0: npm is stopped by the user, not by a clock.
        deadline: timeoutMs === 0 ? Number.POSITIVE_INFINITY : Date.now() + (timeoutMs ?? 360_000),
      });
    });
    const resp = await fetch("/bridge", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ t: method, id, p: params ?? {} }),
    });
    if (!resp.ok && resp.status !== 202) {
      this.pending.delete(id);
      throw new Error(`bridge request failed: ${resp.status}`);
    }
    return promise;
  }

  onEvent(listener: Listener) {
    this.listeners.push(listener);
  }
}

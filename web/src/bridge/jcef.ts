import type { Bridge, BridgeEventName } from "./types";

type Listener = (name: BridgeEventName, data: unknown) => void;

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
        const resp = await fetch(`/bridge/poll?cursor=${this.cursor}&timeout=20000`);
        if (!resp.ok) throw new Error(`poll failed: ${resp.status}`);
        const data = (await resp.json()) as {
          events: Array<{ seq: number; record: { t?: string; id?: string; ok?: boolean; data?: unknown; error?: string; name?: string } }>;
          cursor: number;
        };
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

  async request<T>(method: string, params?: unknown): Promise<T> {
    const id = `js-${++this.seq}-${Date.now()}`;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        deadline: Date.now() + 360_000, // package installs can be slow
      });
    });
    const resp = await fetch("/bridge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

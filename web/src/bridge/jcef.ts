import type { Bridge, BridgeEventName } from "./types";

type Listener = (name: BridgeEventName, data: unknown) => void;

// The IDE hands the SPA a one-time bridge token through the load URL
// (LocalUiServer.uiUrl); every bridge request must echo it. Guarded so the
// module can also be imported outside a browser (unit / e2e specs).
const TOKEN =
  typeof window === "undefined" ? "" : (new URLSearchParams(window.location.search).get("token") ?? "");
const AUTH_HEADERS: Record<string, string> = TOKEN ? { "X-Pi-Token": TOKEN } : {};

/**
 * Upper bound for one long-poll request. The server holds the request for at
 * most 20s (`timeout=20000`), so anything past 35s is a broken transport, not
 * a slow agent.
 */
const POLL_TIMEOUT_MS = 35_000;

/**
 * Upper bound for the POST that submits a command. The server acknowledges it
 * in milliseconds; anything slower is a dead transport.
 */
const POST_TIMEOUT_MS = 30_000;

/**
 * How long the page tolerates having no successful poll at all before it
 * reloads itself. Long enough to ride out a stalled request plus retries,
 * short enough that a user notices a self-heal instead of a dead panel.
 */
const WATCHDOG_MS = 90_000;

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
  /** Last time a poll response arrived; null until the first one does. */
  private lastOk: number | null = null;

  constructor() {
    void this.pollLoop();
    void this.timeoutLoop();
  }

  private async pollLoop() {
    while (!this.stopped) {
      // A poll that never settles is the failure mode this loop has to survive.
      // The server long-polls for at most 20s, so 35s means the transport is
      // gone, not that the agent is slow: a half-open loopback socket (IDE
      // slept, Chromium froze the page) leaves fetch pending forever, the
      // loop parks on the await, and the panel keeps painting its last frame
      // while nothing responds. The abort turns that into a retry.
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
      try {
        const resp = await fetch(`/bridge/poll?cursor=${this.cursor}&timeout=20000`, {
          headers: AUTH_HEADERS,
          signal: controller.signal,
        });
        if (!resp.ok) throw new Error(`poll failed: ${resp.status}`);
        const data = (await resp.json()) as {
          events: Array<{ seq: number; record: { t?: string; id?: string; ok?: boolean; data?: unknown; error?: string; name?: string } }>;
          cursor: number;
          oldest?: number;
        };
        this.lastOk = Date.now();
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
      } finally {
        clearTimeout(abortTimer);
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
      // Watchdog. A frozen renderer or a suspended page can stop the poll loop
      // without any error surfacing to the UI: requests sit in `pending` and
      // resolve to nothing. Nothing on this side can repair a dead transport,
      // but a full reload can — the load URL carries the bridge token, and all
      // conversation state lives in pi/the IDE, so nothing is lost.
      const lastOk = this.lastOk;
      if (!this.stopped && lastOk !== null && Date.now() - lastOk > WATCHDOG_MS) {
        this.stopped = true;
        clearInterval(timer);
        // Best-effort breadcrumb for idea.log: the *poll* connection is
        // usually what broke, while a plain POST still gets through — the
        // platform disables CEF's own logging, so without this the reload
        // leaves no trace at all. keepalive lets it finish across the reload.
        const silentMs = Date.now() - lastOk;
        void fetch("/bridge", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
          body: JSON.stringify({ t: "ui.reload", id: `watchdog-${Date.now()}`, p: { silentMs } }),
          keepalive: true,
        }).catch(() => undefined);
        location.reload();
        return;
      }
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
    // The server answers POST /bridge with 202 immediately (the work runs
    // async and reports back over the poll stream), so this request must never
    // take long: a stalled one means the transport is down and the caller
    // should see an error instead of a promise that never settles.
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    try {
      const resp = await fetch("/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({ t: method, id, p: params ?? {} }),
        signal: controller.signal,
      });
      if (!resp.ok && resp.status !== 202) {
        this.pending.delete(id);
        throw new Error(`bridge request failed: ${resp.status}`);
      }
    } catch (error) {
      this.pending.delete(id);
      throw error;
    } finally {
      clearTimeout(abortTimer);
    }
    return promise;
  }

  onEvent(listener: Listener) {
    this.listeners.push(listener);
  }
}

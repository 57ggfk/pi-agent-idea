/**
 * Bridge detection: is the loopback UI server the IDE's own?
 *
 * The answer decides whether the panel talks to the real pi or to the mock
 * bridge, so a wrong "no" is expensive: the panel shows a fake pi until the
 * page is reloaded (real machine: the IDE was still booting, the first probe
 * landed on nothing and the panel never recovered).
 *
 * Two failures must not be lumped together:
 *  - "some other server answered" (vite's SPA fallback in the standalone
 *    dev/e2e run) → definitely not the IDE, stop looking;
 *  - "nothing answered" (the IDE's server is not listening yet) → the IDE may
 *    still be booting, so keep trying for a while.
 */

/** What one probe attempt learned about the environment. */
export type ProbeOutcome = "ide" | "foreign" | "unreachable";

/**
 * Per-request ceiling.
 *
 * AbortSignal.timeout alone is not enough: on a wedged CEF network stack
 * (real machine: JCEF reports "CEF 144 … doesn't match the launcher 122")
 * the fetch can stay pending *without* ever firing abort. The hard race below
 * is what turns "forever" into "this attempt failed".
 */
const REQUEST_TIMEOUT_MS = 1500;

/** Hard ceiling for one attempt, independent of the abort signal. */
const PROBE_TIMEOUT_MS = 2500;

/**
 * How long to keep retrying while nothing answers. The IDE opens its UI
 * server a moment after the tool window appears, and the first probe
 * routinely lands in that gap (real machine: the probe answered 1.7s later).
 */
const RETRY_WINDOW_MS = 10_000;

/** Pause between attempts. */
const RETRY_DELAY_MS = 500;

export interface DetectOptions {
  /** How long to keep retrying while the server stays unreachable. */
  retryWindowMs?: number;
  /** Pause between attempts. */
  retryDelayMs?: number;
  /** Injected by tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected by tests. */
  now?: () => number;
}

/** One probe: did our own UI server answer? */
export async function probeIde(): Promise<ProbeOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const resp = await Promise.race([
      fetch("/bridge/health", { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("probe timeout")), PROBE_TIMEOUT_MS);
      }),
    ]);
    // Verify the payload is ours: vite's SPA fallback also returns 200 HTML.
    const data = (await resp.json().catch(() => null)) as { ok?: boolean } | null;
    if (resp.ok && data?.ok === true) return "ide";
    // Something answered, but it is not the IDE's bridge — the standalone
    // dev/e2e case. Waiting longer cannot change that.
    return "foreign";
  } catch {
    // Nothing answered: the IDE's server may not be listening yet.
    return "unreachable";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * True when the loopback server is the IDE's bridge.
 *
 * A failed attempt only ends the search when the answer was "foreign" or the
 * retry window is over — "unreachable" keeps trying, because that is what a
 * booting IDE looks like.
 */
export async function detectBridge(
  options: DetectOptions = {},
): Promise<{ inIde: boolean; outcome: ProbeOutcome }> {
  const retryWindowMs = options.retryWindowMs ?? RETRY_WINDOW_MS;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const deadline = now() + retryWindowMs;
  for (;;) {
    const outcome = await probeIde();
    if (outcome === "ide") return { inIde: true, outcome };
    if (outcome === "foreign") return { inIde: false, outcome };
    if (now() >= deadline) return { inIde: false, outcome };
    await sleep(retryDelayMs);
  }
}

/**
 * Local deadline for one bridge call (spec 026).
 *
 * The bridge's own deadline loop (`jcef.ts`) sweeps every 5s and its default is
 * 360s for long tasks — right for installs, far too slow for "switch session".
 * The store therefore races the promise against a plain setTimeout: exact
 * timing, testable with fake timers, and the bridge's global default stays
 * untouched. Cancelling here only stops the *wait* — pi has no cancel channel,
 * so a late answer still flows through the `then` handlers below instead of
 * surfacing as an unhandled rejection.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
  });
  // Both branches clear the timer first; a settlement after the timeout won is
  // swallowed by the already-settled race, which is exactly the "give up but
  // stay quiet" behaviour the switch flow needs.
  const guarded = promise.then(
    (v) => {
      clearTimeout(timer);
      return v;
    },
    (e) => {
      clearTimeout(timer);
      throw e;
    },
  );
  return Promise.race([guarded, timeout]) as Promise<T>;
}

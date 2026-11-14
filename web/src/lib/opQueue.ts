/**
 * Serial management-operation queue (spec 035): every mutating op on skills /
 * packages goes through one FIFO chain. Clicks enqueue instead of being
 * disabled — concurrent writes to the same agent dir and settings.json are
 * exactly what a queue prevents, while the UI shows who is running and who
 * is waiting.
 *
 * Snapshot is immutable and subscribe-based, so panels can use it with
 * React's useSyncExternalStore.
 */

export interface QueueSnapshot {
  /** Key of the operation currently running, or null when idle. */
  active: string | null;
  /** Keys waiting to run, in FIFO order. */
  waiting: string[];
}

type Waiter = {
  key: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  run: () => Promise<unknown>;
};

let active: string | null = null;
const waiting: Waiter[] = [];
const listeners = new Set<() => void>();

let currentSnap: QueueSnapshot = { active: null, waiting: [] };

function refreshSnapshot() {
  currentSnap = { active, waiting: waiting.map((w) => w.key) };
}

function snapshot(): QueueSnapshot {
  return currentSnap;
}

function notify() {
  listeners.forEach((cb) => cb());
}

let chain: Promise<unknown> = Promise.resolve();

function pump() {
  chain = chain.then(async () => {
    const next = waiting.shift();
    if (!next) {
      active = null;
      refreshSnapshot();
  notify();
      return;
    }
    active = next.key;
    refreshSnapshot();
  notify();
    try {
      next.resolve(await next.run());
    } catch (reason) {
      // FR-003: one failure must not stall the queue — the next item runs.
      next.reject(reason);
    } finally {
      active = null;
      refreshSnapshot();
  notify();
      pump();
    }
  });
}

/**
 * Runs [run] after every previously enqueued operation finishes (FIFO).
 * Failures propagate to this caller but never stop later items.
 */
export function managementQueueRun<T>(key: string, run: () => Promise<T>): Promise<T> {
  if (waiting.some((w) => w.key === key) || active === key) {
    // Same key already in flight: collapse the duplicate (buttons may double-
    // fire while their row is queued).
    return Promise.reject(new Error(`operation already queued: ${key}`));
  }
  const waiter: Waiter = {
    key,
    run,
    resolve: () => {},
    reject: () => {},
  };
  const result = new Promise<T>((resolve, reject) => {
    waiter.resolve = resolve as (value: unknown) => void;
    waiter.reject = reject;
  });
  waiting.push(waiter);
  refreshSnapshot();
  notify();
  pump();
  return result;
}

export function managementQueueSnapshot(): QueueSnapshot {
  return snapshot();
}

export function managementQueueSubscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Test seam: wait until the chain drains (queue empty and idle). */
export function managementQueueIdle(): Promise<void> {
  return chain.then(
    () => undefined,
    () => undefined,
  );
}

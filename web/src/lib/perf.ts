/**
 * Lightweight timing marks (021 D6, reused by 022 D7).
 *
 * The plugin already forwards every console line that starts with `[pi-agent]`
 * to `idea.log` (`PiAgentPanel`'s console handler), so a single formatted line
 * is all a real-machine measurement needs — no new bridge method, no DevTools
 * panel (not guaranteed to work inside JCEF OSR).
 *
 * Read back with: `grep "\[pi-agent\] perf" idea.log`.
 * Format: `[pi-agent] perf <event> <ms>[ key=value ...]` with sorted keys, so
 * lines diff cleanly between runs.
 */

export type PerfEvent =
  | "switch.tap"
  | "switch.pending"
  | "switch.content"
  | "switch.ready"
  // 026 FR-007: a discoverable failure mark (reason=timeout|rpc|abort_timeout),
  // so "pending without a matching ready" stops being the only stuck signature.
  | "switch.failed"
  | "scroll.frame"
  | "hover.render";

export function formatPerfLine(
  event: PerfEvent,
  ms: number,
  extra?: Record<string, string | number>,
): string {
  const tail = extra
    ? Object.keys(extra)
        .sort()
        .map((k) => ` ${k}=${extra[k]}`)
        .join("")
    : "";
  return `[pi-agent] perf ${event} ${Math.max(0, Math.round(ms))}${tail}`;
}

/** `startedAt` is a `performance.now()` reading. */
export function perfMark(
  event: PerfEvent,
  startedAt: number,
  extra?: Record<string, string | number>,
): void {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  console.log(formatPerfLine(event, now - startedAt, extra));
}

/**
 * 022 D7 / T404/T411 — `hover.render`: how many model-option rows rendered.
 * Hovering is supposed to render *nothing*, so the real-machine target is 0
 * for N wheel steps. Exposed on `window.__piPerf` in dev builds only (the
 * Playwright suite runs against the Vite dev server), and never logged on its
 * own — a counter, not a log line.
 */
let hoverRenders = 0;

export function bumpHoverRender(): void {
  hoverRenders += 1;
}

export function readHoverRenders(): number {
  return hoverRenders;
}

export function resetHoverRenders(): void {
  hoverRenders = 0;
}

const isDev = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
if (isDev && typeof window !== "undefined") {
  (window as unknown as { __piPerf?: unknown }).__piPerf = { hoverRenders: readHoverRenders, resetHoverRenders };
}

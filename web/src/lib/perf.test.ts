import { describe, expect, it } from "vitest";
import { formatPerfLine } from "./perf";

/**
 * 021 T314: the measurement channel is a single `[pi-agent] perf …` line —
 * the plugin's console handler copies that prefix into idea.log, so the format
 * is the contract. Keys are sorted so two runs diff cleanly.
 */
describe("formatPerfLine", () => {
  it("renders event and rounded milliseconds", () => {
    expect(formatPerfLine("switch.pending", 12.4)).toBe("[pi-agent] perf switch.pending 12");
    expect(formatPerfLine("switch.content", 12.6)).toBe("[pi-agent] perf switch.content 13");
  });

  it("never writes a negative duration", () => {
    expect(formatPerfLine("switch.tap", -5)).toBe("[pi-agent] perf switch.tap 0");
  });

  it("appends extra keys in a stable (sorted) order", () => {
    expect(formatPerfLine("switch.ready", 320, { kind: "history", file: "a.jsonl" })).toBe(
      "[pi-agent] perf switch.ready 320 file=a.jsonl kind=history",
    );
    expect(formatPerfLine("switch.ready", 320, { kind: "history", file: "a.jsonl" })).toBe(
      formatPerfLine("switch.ready", 320, { file: "a.jsonl", kind: "history" }),
    );
  });
});

describe("switch.failed (026 FR-007)", () => {
  it("renders the failure mark with its reason key", () => {
    expect(formatPerfLine("switch.failed", 5_012, { reason: "timeout" })).toBe(
      "[pi-agent] perf switch.failed 5012 reason=timeout",
    );
    expect(formatPerfLine("switch.failed", 3_004, { reason: "abort_timeout" })).toBe(
      "[pi-agent] perf switch.failed 3004 reason=abort_timeout",
    );
  });
});

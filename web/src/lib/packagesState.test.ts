import { describe, expect, it } from "vitest";
import { packagesListState } from "./packagesState";
import type { PackagesListResult } from "../manage";

/** 037 US2/US3: loading (null), error, empty and list must never cross over. */
describe("packagesListState", () => {
  it("null result = loading (first load / explicit refresh)", () => {
    expect(packagesListState(null)).toBe("loading");
  });

  it("result with error = error, even when entries are also present", () => {
    const withError: PackagesListResult = { ok: false, error: "pi list failed" };
    expect(packagesListState(withError)).toBe("error");
    const withErrorAndEntries: PackagesListResult = {
      ok: false,
      error: "partial failure",
      entries: [{ source: "npm:@example/pi-tools", scope: "user", broken: false }],
    };
    expect(packagesListState(withErrorAndEntries)).toBe("error");
  });

  it("real result without entries = empty (the genuinely-not-installed copy)", () => {
    expect(packagesListState({ ok: true })).toBe("empty");
    expect(packagesListState({ ok: true, entries: [] })).toBe("empty");
  });

  it("result with entries = list", () => {
    const res: PackagesListResult = {
      ok: true,
      entries: [{ source: "npm:@example/pi-tools@1.0.0", scope: "user", broken: false }],
    };
    expect(packagesListState(res)).toBe("list");
  });
});

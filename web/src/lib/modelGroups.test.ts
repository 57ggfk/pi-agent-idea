import { describe, expect, test } from "vitest";
import type { ModelInfo } from "../store/types";
import {
  buildModelGroups,
  buildPickerData,
  ensureVisible,
  filterModels,
  flattenGroups,
  MODEL_RENDER_CAP,
} from "./modelGroups";

/** T004 (011): grouping/truncation pure functions. Cases from
 *  specs/011-0.5.4-defects tasks.md T004 — empty list, single group, current
 *  group pinned first, cross-group filtering, empty provider fallback, cap,
 *  same id different provider, mixed-case providers. */

const m = (provider: string, id: string, name?: string): ModelInfo => ({
  provider,
  id,
  name: name ?? id,
});

describe("filterModels", () => {
  const models = [m("mock", "pro"), m("alpha", "mini"), m("beta", "promax")];

  test("empty keywords return everything in original order", () => {
    expect(filterModels(models, [])).toHaveLength(3);
  });

  test("space-separated keywords are ANDed across provider/id/name", () => {
    expect(filterModels(models, ["pro"])).toHaveLength(2);
    expect(filterModels(models, ["beta", "pro"])).toEqual([models[2]]);
    expect(filterModels(models, ["mock", "mini"])).toEqual([]);
  });
});

describe("buildModelGroups", () => {
  test("empty list → no groups, no active", () => {
    const r = buildModelGroups([], null, []);
    expect(r.groups).toEqual([]);
    expect(r.activeGroupIndex).toBeNull();
    expect(r.total).toBe(0);
  });

  test("single group keeps pi order and count", () => {
    const models = [m("mock", "a"), m("mock", "b"), m("mock", "c")];
    const r = buildModelGroups(models, models[1], []);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].provider).toBe("mock");
    expect(r.groups[0].models.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(r.activeGroupIndex).toBe(0);
  });

  test("current group is pinned first, other groups keep first-seen order", () => {
    const models = [
      m("mock", "p1"),
      m("mock", "p2"),
      m("alpha", "a1"),
      m("beta", "b1"),
      m("beta", "b2"),
    ];
    const r = buildModelGroups(models, models[3], []); // current: beta/b1
    expect(r.groups.map((g) => g.provider)).toEqual(["beta", "mock", "alpha"]);
    expect(r.activeGroupIndex).toBe(0);
    expect(r.groups[0].models.map((x) => x.id)).toEqual(["b1", "b2"]);
  });

  test("filter rebuilds groups and drops groups without hits", () => {
    const models = [m("mock", "pro"), m("mock", "mini"), m("alpha", "alphonse"), m("beta", "promax")];
    const r = buildModelGroups(models, null, ["pro"]);
    expect(r.groups.map((g) => g.provider)).toEqual(["mock", "beta"]);
    expect(r.groups[0].models.map((x) => x.id)).toEqual(["pro"]);
    expect(r.groups[1].models.map((x) => x.id)).toEqual(["promax"]);
    expect(r.total).toBe(2);
  });

  test("empty provider models land in the fallback group, last", () => {
    const models = [m("", "orphan-1"), m("mock", "a"), m("", "orphan-2")];
    const r = buildModelGroups(models, models[1], []);
    expect(r.groups.map((g) => g.provider)).toEqual(["mock", ""]);
    expect(r.groups[1].models.map((x) => x.id)).toEqual(["orphan-1", "orphan-2"]);
  });

  test("current model inside the fallback group pins the fallback first", () => {
    const models = [m("", "orphan"), m("mock", "a")];
    const r = buildModelGroups(models, models[0], []);
    expect(r.groups.map((g) => g.provider)).toEqual(["", "mock"]);
  });

  test("same id under different providers stays in distinct groups", () => {
    const models = [m("mock", "x"), m("alpha", "x")];
    const r = buildModelGroups(models, null, []);
    expect(r.groups).toHaveLength(2);
    expect(r.groups[0].models[0]).toEqual(models[0]);
    expect(r.groups[1].models[0]).toEqual(models[1]);
  });

  test("mixed-case providers are distinct groups (no silent normalization)", () => {
    const models = [m("OpenRouter", "a"), m("openrouter", "b")];
    const r = buildModelGroups(models, null, []);
    expect(r.groups.map((g) => g.provider)).toEqual(["OpenRouter", "openrouter"]);
  });
});

describe("flattenGroups", () => {
  test("cap keeps group headers for partially rendered groups only", () => {
    const groups = [
      { provider: "mock", models: [m("mock", "1"), m("mock", "2"), m("mock", "3")] },
      { provider: "alpha", models: [m("alpha", "a")] },
    ];
    const r = flattenGroups(groups, 2);
    expect(r.groups.map((g) => g.provider)).toEqual(["mock"]);
    expect(r.flat.map((f) => f.model.id)).toEqual(["1", "2"]);
    expect(r.flat.map((f) => f.groupIndex)).toEqual([0, 0]);
    expect(r.hidden).toBe(2); // mock#3 + alpha#a
  });

  test("cap larger than total renders everything and hides nothing", () => {
    const groups = [{ provider: "mock", models: [m("mock", "1"), m("mock", "2")] }];
    const r = flattenGroups(groups, MODEL_RENDER_CAP);
    expect(r.flat).toHaveLength(2);
    expect(r.hidden).toBe(0);
  });

  test("empty groups produce an empty flat list", () => {
    const r = flattenGroups([], 10);
    expect(r.groups).toEqual([]);
    expect(r.flat).toEqual([]);
    expect(r.hidden).toBe(0);
  });
});

describe("buildPickerData", () => {
  test("locates the current model's flat index after filtering", () => {
    const models = [m("mock", "p1"), m("beta", "b1"), m("beta", "b2"), m("alpha", "a1")];
    const data = buildPickerData(models, { provider: "beta", id: "b2" }, []);
    expect(data.activeFlatIndex).toBe(1); // beta pinned first: b1=0, b2=1
    expect(data.groups[0].provider).toBe("beta");
    expect(data.hidden).toBe(0);
  });

  test("current model filtered out → activeFlatIndex null, no crash", () => {
    const models = [m("mock", "p1"), m("mock", "p2")];
    const data = buildPickerData(models, { provider: "ghost", id: "g" }, ["p1"]);
    expect(data.activeFlatIndex).toBeNull();
    expect(data.flat).toHaveLength(1);
  });

  test("long list truncates to the cap with a visible remainder", () => {
    const models: ModelInfo[] = [];
    for (let i = 0; i < 205; i++) models.push(m("mock", `id-${String(i).padStart(3, "0")}`));
    const current = models[180];
    const data = buildPickerData(models, current, []);
    expect(data.total).toBe(205);
    expect(data.flat).toHaveLength(MODEL_RENDER_CAP);
    expect(data.hidden).toBe(5);
    expect(data.activeFlatIndex).toBe(180);
  });
});

describe("ensureVisible", () => {
  const rect = (top: number, height: number) =>
    ({ top, height, bottom: top + height }) as DOMRect;
  const fakeEl = (top: number, height: number) =>
    ({ getBoundingClientRect: () => rect(top, height) }) as HTMLElement;
  const fakeList = (scrollTop: number, height: number) => {
    const list = {
      getBoundingClientRect: () => rect(0, height),
      scrollTop,
      clientHeight: height,
    };
    return list as unknown as HTMLElement & { scrollTop: number };
  };

  test("fully visible element is not scrolled", () => {
    const list = fakeList(100, 400);
    const scrolled = ensureVisible(list, fakeEl(150, 40));
    expect(scrolled).toBe(false);
    expect(list.scrollTop).toBe(100);
  });

  test("element above the viewport scrolls up to its top", () => {
    const list = fakeList(300, 400);
    const scrolled = ensureVisible(list, fakeEl(-40, 40));
    expect(scrolled).toBe(true);
    expect(list.scrollTop).toBe(260); // absolute offset: -40 viewport-relative + 300 scrolled
  });

  test("element below the viewport scrolls down to its bottom", () => {
    const list = fakeList(0, 400);
    const scrolled = ensureVisible(list, fakeEl(380, 50));
    expect(scrolled).toBe(true);
    expect(list.scrollTop).toBe(30); // 430 - 400
  });

  test("partial overlap at the bottom edge is corrected", () => {
    const list = fakeList(0, 400);
    const scrolled = ensureVisible(list, fakeEl(390, 20));
    expect(scrolled).toBe(true);
    expect(list.scrollTop).toBe(10);
  });

  test("assignment goes through the scrollTop setter (capture check)", () => {
    let assigned: number | null = null;
    const list = {
      getBoundingClientRect: () => rect(0, 100),
      get scrollTop() {
        return 0;
      },
      set scrollTop(v: number) {
        assigned = v;
      },
      clientHeight: 100,
    } as unknown as HTMLElement;
    ensureVisible(list, fakeEl(-10, 10));
    expect(assigned).toBe(-10);
  });
});

// -- 018 US5: collapsing provider groups -------------------------------------

describe("buildPickerData with collapsed groups", () => {
  const catalog = [
    { provider: "openrouter", id: "m1", name: "M1" },
    { provider: "openrouter", id: "m2", name: "M2" },
    { provider: "deepseek", id: "d1", name: "D1" },
  ] as unknown as Parameters<typeof buildPickerData>[0];

  test("collapsed groups leave visibleFlat (and the index space) entirely", () => {
    const data = buildPickerData(catalog, null, [], undefined, new Set(["openrouter"]));
    expect(data.visibleFlat.map((e) => e.model.id)).toEqual(["d1"]);
    // `flat` still accounts for everything the cap rendered.
    expect(data.flat).toHaveLength(3);
  });

  test("activeFlatIndex is null while the current model's group is collapsed", () => {
    const data = buildPickerData(catalog, { provider: "openrouter", id: "m2" }, [], undefined, new Set(["openrouter"]));
    expect(data.activeFlatIndex).toBeNull();
    const open = buildPickerData(catalog, { provider: "openrouter", id: "m2" }, [], undefined, null);
    expect(open.activeFlatIndex).toBe(1);
  });

  test("an empty collapsed set makes visibleFlat identical to flat", () => {
    const data = buildPickerData(catalog, null, [], undefined, new Set());
    expect(data.visibleFlat).toEqual(data.flat);
  });
});

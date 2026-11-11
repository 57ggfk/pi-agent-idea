import { describe, expect, test } from "vitest";
import type { ModelInfo } from "../store/types";
import {
  buildModelGroups,
  buildPickerData,
  ensureVisible,
  filterModels,
  flattenGroups,
  groupCap,
  GROUP_CAP_MAX,
  GROUP_CAP_MIN,
  PROVIDER_LIMIT,
} from "./modelGroups";

/** T004 (011): grouping/truncation pure functions. Cases from
 *  specs/011-0.5.4-defects tasks.md T004 — empty list, single group, current
 *  group pinned first, cross-group filtering, empty provider fallback, cap,
 *  same id different provider, mixed-case providers.
 *  020 US1–US5: per-group cap, provider limit, current-model exemption, and
 *  the two-level truncation notice (specs/020-model-picker-group-cap). */

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

describe("groupCap", () => {
  // 020 plan「每家上限数值表」— the single source of truth for the formula.
  const table: Array<[number, number]> = [
    [1, 200], [2, 200], [3, 200], [4, 200], [5, 200],
    [6, 166], [8, 125], [10, 100], [12, 83], [15, 66],
    [20, 50], [25, 40], [30, 33], [40, 25], [50, 20],
  ];

  test("matches the plan table for n = 1…50", () => {
    for (const [n, expected] of table) expect([n, groupCap(n)]).toEqual([n, expected]);
  });

  test("n <= 0 returns the ceiling (no division, no NaN)", () => {
    expect(groupCap(0)).toBe(GROUP_CAP_MAX);
    expect(groupCap(-3)).toBe(GROUP_CAP_MAX);
    expect(groupCap(Number.NaN)).toBe(GROUP_CAP_MAX);
  });

  test("never drops below the floor, however many providers", () => {
    expect(groupCap(500)).toBe(GROUP_CAP_MIN);
    expect(groupCap(PROVIDER_LIMIT)).toBe(20);
  });

  test("budget / ceiling / floor are single-knob overrides (D11)", () => {
    expect(groupCap(10, 500)).toBe(50);
    expect(groupCap(1, 1000, 120)).toBe(120);
    expect(groupCap(500, 1000, 200, 7)).toBe(7);
  });
});

describe("flattenGroups", () => {
  const group = (provider: string, ids: string[]) => ({
    provider,
    models: ids.map((id) => m(provider, id)),
  });
  const ids = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

  test("truncates every group on its own and reports shown/total/hidden", () => {
    const r = flattenGroups([group("mock", ids(3, "a")), group("alpha", ids(1, "b"))], 2);
    expect(r.groups.map((g) => [g.provider, g.shown, g.total, g.hidden])).toEqual([
      ["mock", 2, 3, 1],
      ["alpha", 1, 1, 0],
    ]);
    expect(r.flat.map((f) => f.model.id)).toEqual(["a-0", "a-1", "b-0"]);
    expect(r.flat.map((f) => f.groupIndex)).toEqual([0, 0, 1]);
    expect(r.hiddenProviders).toBe(0);
  });

  test("a huge first group no longer squeezes the small ones out (020 US1)", () => {
    const r = flattenGroups([group("big", ids(355, "x")), group("tiny", ids(4, "y"))], 200);
    expect(r.groups.map((g) => g.provider)).toEqual(["big", "tiny"]);
    expect(r.groups[1].shown).toBe(4);
  });

  test("providers beyond providerLimit are counted, not rendered", () => {
    const many = Array.from({ length: 55 }, (_, i) => group(`p${String(i).padStart(2, "0")}`, ids(3, `m${i}`)));
    const r = flattenGroups(many, 20, { providerLimit: PROVIDER_LIMIT });
    expect(r.groups).toHaveLength(PROVIDER_LIMIT);
    expect(r.hiddenProviders).toBe(5);
    expect(r.flat).toHaveLength(150);
    // dropped providers only feed hiddenProviders — no group claims their rows
    expect(r.groups.reduce((n, g) => n + g.hidden, 0)).toBe(0);
  });

  test("cap larger than total renders everything and hides nothing", () => {
    const r = flattenGroups([group("mock", ids(2, "a"))], GROUP_CAP_MAX);
    expect(r.flat).toHaveLength(2);
    expect(r.groups[0].hidden).toBe(0);
  });

  test("empty input stays empty", () => {
    const r = flattenGroups([], 10);
    expect(r.groups).toEqual([]);
    expect(r.flat).toEqual([]);
    expect(r.hiddenProviders).toBe(0);
  });

  test("the current model is moved to its group's head when truncated away (D4)", () => {
    const models = ids(10, "a").map((id) => m("mock", id));
    const r = flattenGroups([{ provider: "mock", models }], 3, { current: { provider: "mock", id: "a-7" } });
    expect(r.groups[0].models.map((x) => x.id)).toEqual(["a-7", "a-0", "a-1"]);
    expect(r.groups[0].shown).toBe(3);
    expect(r.groups[0].hidden).toBe(7);
    // no duplicate row
    expect(new Set(r.flat.map((f) => f.model.id)).size).toBe(r.flat.length);
  });

  test("a current model already inside the slice keeps pi's order", () => {
    const models = ids(10, "a").map((id) => m("mock", id));
    const r = flattenGroups([{ provider: "mock", models }], 3, { current: { provider: "mock", id: "a-1" } });
    expect(r.groups[0].models.map((x) => x.id)).toEqual(["a-0", "a-1", "a-2"]);
  });
});

describe("buildPickerData", () => {
  const ids = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

  test("locates the current model's flat index after filtering", () => {
    const models = [m("mock", "p1"), m("beta", "b1"), m("beta", "b2"), m("alpha", "a1")];
    const data = buildPickerData(models, { provider: "beta", id: "b2" }, []);
    expect(data.activeFlatIndex).toBe(1); // beta pinned first: b1=0, b2=1
    expect(data.groups[0].provider).toBe("beta");
    expect(data.groups[0].hidden).toBe(0);
    expect(data.hiddenProviders).toBe(0);
  });

  test("current model filtered out → activeFlatIndex null, no crash", () => {
    const models = [m("mock", "p1"), m("mock", "p2")];
    const data = buildPickerData(models, { provider: "ghost", id: "g" }, ["p1"]);
    expect(data.activeFlatIndex).toBeNull();
    expect(data.flat).toHaveLength(1);
  });

  test("each group truncates at 200 with n = 1…5 (was: one global 200 cap)", () => {
    // 020 scenario A: 355 + 4
    const models = [
      ...ids(355, "big").map((id) => m("big", id)),
      ...ids(4, "tiny").map((id) => m("tiny", id)),
    ];
    const data = buildPickerData(models, { provider: "big", id: "big-300" }, []);
    expect(data.groups.map((g) => [g.provider, g.shown, g.total, g.hidden])).toEqual([
      ["big", 200, 355, 155],
      ["tiny", 4, 4, 0],
    ]);
    expect(data.total).toBe(359);
    // D4: buried current model surfaces at the head and is locatable
    expect(data.groups[0].models[0].id).toBe("big-300");
    expect(data.activeFlatIndex).toBe(0);
    expect(data.flat).toHaveLength(204);
  });

  test("020 scenario B: three uneven groups all keep their own quota", () => {
    const models = [
      ...ids(355, "a").map((id) => m("a", id)),
      ...ids(200, "b").map((id) => m("b", id)),
      ...ids(4, "c").map((id) => m("c", id)),
    ];
    const data = buildPickerData(models, null, []);
    expect(data.groups.map((g) => [g.shown, g.total])).toEqual([[200, 355], [200, 200], [4, 4]]);
  });

  test("020 scenario C: 10 groups × 40 fit completely, no notice", () => {
    const models = Array.from({ length: 10 }, (_, p) => ids(40, `p${p}`).map((id) => m(`p${p}`, id))).flat();
    const data = buildPickerData(models, null, []);
    expect(data.groups.every((g) => g.hidden === 0)).toBe(true);
    expect(data.hiddenProviders).toBe(0);
    expect(data.flat).toHaveLength(400);
  });

  test("020 scenario D: 20 groups × 100 → groupCap 50 each", () => {
    const models = Array.from({ length: 20 }, (_, p) => ids(100, `p${p}`).map((id) => m(`p${p}`, id))).flat();
    const data = buildPickerData(models, null, []);
    expect(groupCap(data.groups.length)).toBe(50);
    expect(data.groups.every((g) => g.shown === 50 && g.hidden === 50)).toBe(true);
    expect(data.flat).toHaveLength(1000);
  });

  test("020 scenario E: 55 groups × 3 → 50 headers + 5 dropped providers", () => {
    const models = Array.from({ length: 55 }, (_, p) => ids(3, `p${String(p).padStart(2, "0")}`).map((id) => m(`p${String(p).padStart(2, "0")}`, id))).flat();
    const data = buildPickerData(models, null, []);
    expect(data.groups).toHaveLength(PROVIDER_LIMIT);
    expect(data.hiddenProviders).toBe(5);
    expect(data.groups.every((g) => g.shown === 3 && g.hidden === 0)).toBe(true);
  });

  test("020 scenario G: collapsing does not change any group's shown count (D5)", () => {
    const models = Array.from({ length: 20 }, (_, p) => ids(100, `p${p}`).map((id) => m(`p${p}`, id))).flat();
    const collapsed = new Set(["p1", "p5", "p9"]);
    const data = buildPickerData(models, null, [], { collapsed });
    expect(data.groups.every((g) => g.shown === 50)).toBe(true);
    expect(data.visibleFlat).toHaveLength(1000 - 3 * 50);
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
    const data = buildPickerData(catalog, null, [], { collapsed: new Set(["openrouter"]) });
    expect(data.visibleFlat.map((e) => e.model.id)).toEqual(["d1"]);
    // `flat` still accounts for everything the caps rendered.
    expect(data.flat).toHaveLength(3);
  });

  test("collapsing participates even with a non-empty search (020 US3)", () => {
    // 018 forced every group open while searching; 020 hands the caller the
    // effective set instead, so a search-time fold really folds.
    const data = buildPickerData(catalog, null, ["m"], { collapsed: new Set(["openrouter"]) });
    expect(data.groups.map((g) => g.provider)).toEqual(["openrouter"]);
    expect(data.visibleFlat).toEqual([]);
  });

  test("activeFlatIndex is null while the current model's group is collapsed", () => {
    const data = buildPickerData(catalog, { provider: "openrouter", id: "m2" }, [], {
      collapsed: new Set(["openrouter"]),
    });
    expect(data.activeFlatIndex).toBeNull();
    const open = buildPickerData(catalog, { provider: "openrouter", id: "m2" }, [], { collapsed: null });
    expect(open.activeFlatIndex).toBe(1);
  });

  test("an empty collapsed set makes visibleFlat identical to flat", () => {
    const data = buildPickerData(catalog, null, [], { collapsed: new Set() });
    expect(data.visibleFlat).toEqual(data.flat);
  });
});

import type { ModelInfo } from "../store/types";

/**
 * Model-picker grouping helpers (011 US1/US2, T004; 020 US1–US5).
 *
 * pi returns one flat list; the picker groups it by provider with the current
 * model's group pinned first, an optional fallback group for entries without a
 * provider, and two orthogonal caps that keep the DOM bounded (~360 models from
 * the real catalog, distribution wildly uneven: 355 + 4):
 *
 * - `PROVIDER_LIMIT` — at most 50 provider groups are rendered at all;
 * - `groupCap(n)` — each rendered group shows at most `clamp(1000/n, 5, 200)`
 *   entries. Every group is truncated on its own; quotas are never moved
 *   between groups, so a huge provider cannot squeeze a small one out
 *   (specs/020-model-picker-group-cap, D1–D3).
 *
 * Deliberately NOT a virtual list — 011 locks that in.
 */

/** Provider groups rendered at most (020 US1). Applies to search too (D1). */
export const PROVIDER_LIMIT = 50;
/** Per-group budget base: total rendered entries land near this (D2). */
export const GROUP_BASE_BUDGET = 1000;
/** Per-group cap ceiling — also the value for n <= 5 and for n <= 0. */
export const GROUP_CAP_MAX = 200;
/** Per-group cap floor: a group never shows fewer than this (D2). */
export const GROUP_CAP_MIN = 5;

/**
 * Per-group display cap for `providerCount` rendered groups: `n <= 5 → 200`,
 * `n = 10 → 100`, `n = 50 → 20`. The 1000 base (not 200) keeps the threshold
 * continuous — with a 200 base, going from 4 to 5 providers would drop every
 * group from 200 to 40 at once. `n <= 0` returns the ceiling (no division).
 */
export function groupCap(
  providerCount: number,
  baseBudget: number = GROUP_BASE_BUDGET,
  capMax: number = GROUP_CAP_MAX,
  capMin: number = GROUP_CAP_MIN,
): number {
  if (!Number.isFinite(providerCount) || providerCount <= 0) return capMax;
  const raw = Math.floor(baseBudget / providerCount);
  return Math.min(capMax, Math.max(capMin, raw));
}

/** A group as produced by `buildModelGroups` — untruncated. */
export interface GroupInput {
  /** Provider name; "" is the fallback group for entries without one. */
  provider: string;
  /** Filtered models in pi's original order. */
  models: ModelInfo[];
}

/** A group as rendered: truncated, with the numbers the UI has to show. */
export interface ModelGroup extends GroupInput {
  /** Entries this provider actually has after filtering (020 US5). */
  total: number;
  /** Entries rendered (<= `groupCap`). */
  shown: number;
  /** `total - shown`, surfaced as "…N more" at the group's end. */
  hidden: number;
}

export interface FlatModelEntry {
  model: ModelInfo;
  /** Index into the rendered groups array. */
  groupIndex: number;
  /** Index into the rendered flat list (drives highlight/keyboard nav). */
  flatIndex: number;
}

export interface GroupedModels {
  /** Groups in render order: current group pinned first, fallback last. */
  groups: GroupInput[];
  /** Index of the group containing the current model, or null. */
  activeGroupIndex: number | null;
  /** Filtered count across all groups (uncapped). */
  total: number;
}

export interface FlattenedGroups {
  /** Rendered groups (per-group truncated), in render order. */
  groups: ModelGroup[];
  flat: FlatModelEntry[];
  /** Providers dropped by `PROVIDER_LIMIT`: "…N more providers" at the end.
   *  Their entries are counted here only, never in a group's `hidden`. */
  hiddenProviders: number;
}

export interface PickerModelData extends FlattenedGroups {
  /** Filtered count across all groups (uncapped). */
  total: number;
  /** Flat index of the current model among VISIBLE rendered entries, or null. */
  activeFlatIndex: number | null;
  /** Entries whose group is not collapsed, in render order — the DOM order
   *  of `[data-model-key]` rows and the one index space for highlight /
   *  keyboard / locate (018 US5). Equals `flat` when nothing is collapsed. */
  visibleFlat: FlatModelEntry[];
}

/** Overrides for one picker build (020 D8 / D11). All optional: omitting them
 *  reproduces the shipped defaults, and `baseBudget` is the single knob a
 * 真机 downgrade needs (Q1: 1000 → 500). */
export interface PickerOptions {
  collapsed?: ReadonlySet<string> | null;
  providerLimit?: number;
  baseBudget?: number;
  capMax?: number;
  capMin?: number;
}

/** Space-separated keywords, each required somewhere in `provider id name`. */
export function filterModels(models: ModelInfo[], keywords: string[]): ModelInfo[] {
  if (keywords.length === 0) return models;
  return models.filter((mo) => {
    const haystack = `${mo.provider} ${mo.id} ${mo.name ?? ""}`.toLowerCase();
    return keywords.every((k) => haystack.includes(k));
  });
}

/**
 * Group by provider preserving pi's original order; the current model's group
 * moves to the front and the empty-provider fallback group sits last. Providers
 * are compared case-sensitively — pi's catalog is consistent and silently
 * merging "OpenRouter"/"openrouter" would hide real differences (T003 evidence).
 */
export function buildModelGroups(
  models: ModelInfo[],
  current: { provider: string; id: string } | null,
  keywords: string[],
): GroupedModels {
  const filtered = filterModels(models, keywords);

  const order: string[] = [];
  const byProvider = new Map<string, ModelInfo[]>();
  for (const mo of filtered) {
    let list = byProvider.get(mo.provider);
    if (!list) {
      list = [];
      byProvider.set(mo.provider, list);
      order.push(mo.provider);
    }
    list.push(mo);
  }

  const groups: GroupInput[] = order.map((provider) => ({ provider, models: byProvider.get(provider)! }));

  // Empty-provider fallback group goes last; the pinned current group first.
  const fallbackIndex = order.indexOf("");
  if (fallbackIndex >= 0) {
    const [fallback] = groups.splice(fallbackIndex, 1);
    groups.push(fallback);
  }

  let activeGroupIndex: number | null = null;
  if (current) {
    activeGroupIndex = groups.findIndex((g) =>
      g.models.some((mo) => mo.provider === current.provider && mo.id === current.id),
    );
    if (activeGroupIndex > 0) {
      const [pinned] = groups.splice(activeGroupIndex, 1);
      groups.unshift(pinned);
      activeGroupIndex = 0;
    }
  }

  return { groups, activeGroupIndex, total: filtered.length };
}

/**
 * Truncate every group on its own (`020` D2/D5) and drop providers beyond
 * `providerLimit` (D1). Never moves quota between groups, and never looks at
 * the collapse state: expanding a group must not shrink its neighbours.
 *
 * D4: the current model is exempt — if its group truncates it away it is
 * moved to that group's head (deduped, still `cap` entries), because 011 US1
 * promises "opening the picker locates the current model".
 */
export function flattenGroups(
  groups: GroupInput[],
  perGroupCap: number,
  opts: { providerLimit?: number; current?: { provider: string; id: string } | null } = {},
): FlattenedGroups {
  const providerLimit = opts.providerLimit ?? PROVIDER_LIMIT;
  const limit = Number.isFinite(providerLimit) ? Math.max(0, Math.floor(providerLimit)) : PROVIDER_LIMIT;
  const flat: FlatModelEntry[] = [];
  const rendered: ModelGroup[] = [];
  let hiddenProviders = 0;

  groups.forEach((group, order) => {
    if (order >= limit) {
      hiddenProviders += 1;
      return;
    }
    if (group.models.length === 0) return;

    let slice = group.models.slice(0, Math.max(0, perGroupCap));
    const current = opts.current;
    if (
      current &&
      group.models.some((mo) => mo.provider === current.provider && mo.id === current.id) &&
      !slice.some((mo) => mo.provider === current.provider && mo.id === current.id)
    ) {
      const exempt = group.models.find((mo) => mo.provider === current.provider && mo.id === current.id)!;
      slice = [exempt, ...slice.slice(0, Math.max(0, perGroupCap - 1))];
    }

    const groupIndex = rendered.length;
    const total = group.models.length;
    rendered.push({ provider: group.provider, models: slice, total, shown: slice.length, hidden: total - slice.length });
    for (const model of slice) {
      flat.push({ model, groupIndex, flatIndex: flat.length });
    }
  });

  return { groups: rendered, flat, hiddenProviders };
}

/** Current model's flat index among VISIBLE rendered entries, or null when
 *  filtered out / truncated away / not present / inside a collapsed group.
 *  `collapsed` maps provider → folded (018 US5); null/undefined keeps every
 *  group open. Since 020 the caller passes the *effective* set (search state
 *  included) and the "a keyword force-expands everything" rule is gone (D6). */
export function buildPickerData(
  models: ModelInfo[],
  current: { provider: string; id: string } | null,
  keywords: string[],
  opts: PickerOptions = {},
): PickerModelData {
  const { groups, activeGroupIndex, total } = buildModelGroups(models, current, keywords);

  // D3: the cap is derived from the number of groups actually rendered, not
  // from the raw provider count — otherwise 200 providers would squeeze every
  // group down to the floor while only 50 are shown.
  const providerLimit = opts.providerLimit ?? PROVIDER_LIMIT;
  const renderedCount = Math.min(groups.length, Math.max(0, providerLimit));
  const perGroupCap = groupCap(renderedCount, opts.baseBudget, opts.capMax, opts.capMin);

  const { groups: renderedGroups, flat, hiddenProviders } = flattenGroups(groups, perGroupCap, {
    providerLimit,
    current,
  });

  const collapsed = opts.collapsed ?? null;
  const visibleFlat = collapsed
    ? flat.filter((f) => !collapsed.has(renderedGroups[f.groupIndex].provider))
    : flat;

  let activeFlatIndex: number | null = null;
  if (current) {
    activeFlatIndex =
      visibleFlat.find((f) => f.model.provider === current.provider && f.model.id === current.id)
        ?.flatIndex ?? null;
  }
  void activeGroupIndex;

  return { groups: renderedGroups, flat, hiddenProviders, total, activeFlatIndex, visibleFlat };
}

/**
 * Scroll `el` into `list`'s view only when it is not fully visible (011 T008).
 * Reads geometry once, writes `scrollTop` directly instead of the previous
 * unconditional `scrollIntoView` — a picker that is already showing the
 * current model must not move, and neither may the page behind it.
 * Returns true when a scroll adjustment happened.
 */
export function ensureVisible(list: HTMLElement, el: HTMLElement): boolean {
  const listRect = list.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const top = elRect.top - listRect.top + list.scrollTop;
  const bottom = top + elRect.height;

  const viewTop = list.scrollTop;
  const viewBottom = viewTop + list.clientHeight;
  if (top >= viewTop && bottom <= viewBottom) return false;

  list.scrollTop = top < viewTop ? top : bottom - list.clientHeight;
  return true;
}

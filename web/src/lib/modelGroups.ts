import type { ModelInfo } from "../store/types";

/**
 * Model-picker grouping helpers (011 US1/US2, T004).
 *
 * pi returns one flat list; the picker groups it by provider with the current
 * model's group pinned first, an optional fallback group for entries without a
 * provider, and a render cap that keeps the DOM bounded (~360 models from the
 * real catalog). Deliberately NOT a virtual list — specs/011-0.5.4-defects
 * locks in a 200-entry cap instead.
 */

export const MODEL_RENDER_CAP = 200;

export interface ModelGroup {
  /** Provider name; "" is the fallback group for entries without one. */
  provider: string;
  /** Filtered models in pi's original order. */
  models: ModelInfo[];
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
  groups: ModelGroup[];
  /** Index of the group containing the current model, or null. */
  activeGroupIndex: number | null;
  /** Filtered count across all groups (uncapped). */
  total: number;
}

export interface FlattenedGroups {
  /** Groups that have at least one rendered entry, in render order. */
  groups: ModelGroup[];
  flat: FlatModelEntry[];
  /** Entries beyond the cap: surfaced as "…and N more". */
  hidden: number;
}

export interface PickerModelData extends FlattenedGroups {
  /** Filtered count across all groups (uncapped). */
  total: number;
  /** Flat index of the current model among rendered entries, or null. */
  activeFlatIndex: number | null;
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

  const groups: ModelGroup[] = order.map((provider) => ({ provider, models: byProvider.get(provider)! }));

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

/** Walk groups in render order, stopping at `cap` entries; groups with no
 *  rendered entry are dropped so headers never sit over an empty slice. */
export function flattenGroups(groups: ModelGroup[], cap: number): FlattenedGroups {
  const flat: FlatModelEntry[] = [];
  const rendered: ModelGroup[] = [];
  let hidden = 0;

  for (const group of groups) {
    const remaining = cap - flat.length;
    if (remaining <= 0) {
      hidden += group.models.length;
      continue;
    }
    const slice = group.models.slice(0, remaining);
    if (slice.length === 0) continue;
    const groupIndex = rendered.length;
    rendered.push({ provider: group.provider, models: slice });
    for (const model of slice) {
      flat.push({ model, groupIndex, flatIndex: flat.length });
    }
    hidden += group.models.length - slice.length;
  }

  return { groups: rendered, flat, hidden };
}

/** Current model's flat index among rendered entries, or null when filtered
 *  out / beyond the cap / not present (custom model, load failure). */
export function buildPickerData(
  models: ModelInfo[],
  current: { provider: string; id: string } | null,
  keywords: string[],
  cap: number = MODEL_RENDER_CAP,
): PickerModelData {
  const { groups, activeGroupIndex, total } = buildModelGroups(models, current, keywords);
  const { groups: renderedGroups, flat, hidden } = flattenGroups(groups, cap);

  let activeFlatIndex: number | null = null;
  if (current) {
    activeFlatIndex =
      flat.find((f) => f.model.provider === current.provider && f.model.id === current.id)
        ?.flatIndex ?? null;
  }
  void activeGroupIndex;

  return { groups: renderedGroups, flat, hidden, total, activeFlatIndex };
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

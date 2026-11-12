/**
 * 027 — the client half of the custom-provider form. The WRITE-side schema
 * lives in Kotlin (`PiModels`); this module only validates what the user
 * typed before it leaves the panel and normalizes the thinking-level
 * checkbox state. Same rules, two layers — the bridge answers with the same
 * refusal codes, so the form never guesses.
 */

/** pi's `THINKING_LEVELS` order (virtual-models.js 1.5.0). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** What a fresh "supports thinking" checkbox expands to (spec FR-002). */
export const DEFAULT_THINKING_LEVELS: string[] = ["low", "medium", "high"];

/** The four wire formats pi 1.5.0 accepts for `models.json` `providers.<n>.api`. */
export const API_FORMATS = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "google-generative-ai",
] as const;

export const PROVIDER_NAME_RE = /^[a-z0-9-_.]{1,64}$/;

/** Levels → ordered, de-duplicated, only table levels (the payload array). */
export function normalizeThinkingLevels(levels: string[]): string[] {
  return THINKING_LEVELS.filter((l) => levels.includes(l));
}

/**
 * "Supports thinking" is true only when a level OTHER than "off" is checked
 * (mirrors PiModels.buildThinkingLevelMap: off alone means no map, no
 * reasoning). The Kotlin side re-derives this from the same array.
 */
export function hasRealThinkingLevel(levels: string[]): boolean {
  return normalizeThinkingLevels(levels).some((l) => l !== "off");
}

export interface CustomProviderFormModel {
  id: string;
  name: string;
  reasoning: boolean;
  inputImage: boolean;
  thinkingLevels: string[];
  contextWindow: string;
  maxTokens: string;
}

export interface CustomProviderFormState {
  name: string;
  displayName: string;
  api: string;
  baseUrl: string;
  apiKey: string;
  thinkingFormat: string;
  models: CustomProviderFormModel[];
}

export interface CustomProviderDraftModel {
  id: string;
  name?: string;
  reasoning: boolean;
  inputImage: boolean;
  thinkingLevels: string[];
  contextWindow?: number;
  maxTokens?: number;
}

export function emptyModel(): CustomProviderFormModel {
  return { id: "", name: "", reasoning: false, inputImage: false, thinkingLevels: [], contextWindow: "", maxTokens: "" };
}

/** i18n keys for every validation failure the form can show (both locales). */
export type ProviderFormError =
  | "cprov.badName"
  | "cprov.badApi"
  | "cprov.badUrl"
  | "cprov.noModels"
  | "cprov.badModelId"
  | "cprov.dupModelId";

/** Same rules as PiModels.providerSave — visible BEFORE the round trip. */
export function validateCustomProvider(form: CustomProviderFormState): ProviderFormError | null {
  if (!PROVIDER_NAME_RE.test(form.name.trim())) return "cprov.badName";
  if (!API_FORMATS.includes(form.api as (typeof API_FORMATS)[number])) return "cprov.badApi";
  if (!/^https?:\/\//.test(form.baseUrl.trim())) return "cprov.badUrl";
  const ids = form.models.map((m) => m.id.trim());
  if (ids.length === 0 || ids.some((id) => id.length === 0)) return "cprov.noModels";
  if (new Set(ids).size !== ids.length) return "cprov.dupModelId";
  return null;
}

/** The bridge payload — blank numbers/names dropped, levels normalized. */
export function toPayload(form: CustomProviderFormState): {
  name: string;
  displayName?: string;
  api: string;
  baseUrl: string;
  apiKey?: string;
  thinkingFormat?: string;
  models: CustomProviderDraftModel[];
} {
  return {
    name: form.name.trim(),
    displayName: form.displayName.trim() || undefined,
    api: form.api,
    baseUrl: form.baseUrl.trim(),
    apiKey: form.apiKey.trim() || undefined,
    thinkingFormat: form.thinkingFormat.trim() || undefined,
    models: form.models.map((m) => {
      const levels = normalizeThinkingLevels(m.thinkingLevels);
      const reasoning = hasRealThinkingLevel(m.thinkingLevels);
      return {
        id: m.id.trim(),
        ...(m.name.trim() ? { name: m.name.trim() } : {}),
        reasoning,
        inputImage: m.inputImage,
        thinkingLevels: reasoning ? levels : [],
        ...(Number.isFinite(Number(m.contextWindow)) && m.contextWindow.trim()
          ? { contextWindow: Number(m.contextWindow) }
          : {}),
        ...(Number.isFinite(Number(m.maxTokens)) && m.maxTokens.trim() ? { maxTokens: Number(m.maxTokens) } : {}),
      };
    }),
  };
}

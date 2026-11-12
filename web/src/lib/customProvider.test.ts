import { describe, expect, it } from "vitest";
import {
  API_FORMATS,
  DEFAULT_THINKING_LEVELS,
  hasRealThinkingLevel,
  normalizeThinkingLevels,
  toPayload,
  validateCustomProvider,
  type CustomProviderFormState,
} from "./customProvider";

/** 027 FR-002 / FR-001 — the client-side half of the schema contract. */
describe("custom provider helpers (027)", () => {
  const base: CustomProviderFormState = {
    name: "my-relay",
    displayName: "",
    api: "openai-completions",
    baseUrl: "https://relay.example.com",
    apiKey: "sk-x",
    thinkingFormat: "",
    models: [{ id: "m1", name: "", reasoning: false, inputImage: false, thinkingLevels: [], contextWindow: "", maxTokens: "" }],
  };

  it("validates name, api, url and model ids", () => {
    expect(validateCustomProvider(base)).toBeNull();
    expect(validateCustomProvider({ ...base, name: "Bad Name" })).toBe("cprov.badName");
    expect(validateCustomProvider({ ...base, api: "grpc" })).toBe("cprov.badApi");
    expect(validateCustomProvider({ ...base, baseUrl: "relay.example.com" })).toBe("cprov.badUrl");
    expect(validateCustomProvider({ ...base, models: [] })).toBe("cprov.noModels");
    expect(validateCustomProvider({ ...base, models: [{ ...base.models[0], id: "  " }] })).toBe("cprov.noModels");
    expect(
      validateCustomProvider({
        ...base,
        models: [base.models[0], { ...base.models[0], id: "m1" }],
      }),
    ).toBe("cprov.dupModelId");
    // The four wire formats all pass.
    API_FORMATS.forEach((api) => expect(validateCustomProvider({ ...base, api })).toBeNull());
  });

  it("normalizes thinking levels to pi's order", () => {
    expect(normalizeThinkingLevels(["high", "off", "low", "bogus", "high"])).toEqual(["off", "low", "high"]);
    expect(DEFAULT_THINKING_LEVELS).toEqual(["low", "medium", "high"]);
  });

  it("reasoning requires a level other than off", () => {
    expect(hasRealThinkingLevel(["off"])).toBe(false);
    expect(hasRealThinkingLevel([])).toBe(false);
    expect(hasRealThinkingLevel(["low"])).toBe(true);
  });

  it("toPayload drops blanks and maps the flags", () => {
    const payload = toPayload({
      ...base,
      displayName: "  ",
      models: [
        {
          id: " m1 ",
          name: "",
          reasoning: true,
          inputImage: true,
          thinkingLevels: ["off", "high"],
          contextWindow: "128000",
          maxTokens: "not-a-number",
        },
      ],
    });
    expect(payload.displayName).toBeUndefined();
    const m = payload.models[0];
    expect(m.id).toBe("m1");
    // reasoning true (a real level is checked) but only "high" normalized.
    expect(m.reasoning).toBe(true);
    expect(m.thinkingLevels).toEqual(["off", "high"]);
    expect(m.inputImage).toBe(true);
    expect(m.contextWindow).toBe(128000);
    expect(m.maxTokens).toBeUndefined();
  });
});

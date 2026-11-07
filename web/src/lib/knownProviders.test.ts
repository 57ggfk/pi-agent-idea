import { describe, expect, test } from "vitest";
import { KNOWN_PROVIDERS, mergeProviderOptions } from "./knownProviders";

/** Bundled builtin table ∪ live authOverview merge. The table mirrors the
 *  pi 1.4.0 registry; the merge is what the ProviderForm dropdown renders. */

describe("KNOWN_PROVIDERS", () => {
  test("table is unique and covers both auth methods somewhere", () => {
    const ids = new Set(KNOWN_PROVIDERS.map((k) => k.id));
    expect(ids.size).toBe(KNOWN_PROVIDERS.length);
    expect(KNOWN_PROVIDERS.some((k) => k.oauth)).toBe(true);
    expect(KNOWN_PROVIDERS.some((k) => k.apiKey)).toBe(true);
  });

  test("OAuth-only provider has no apiKey method (legacy Codex login)", () => {
    const codex = KNOWN_PROVIDERS.find((k) => k.id === "openai-codex");
    expect(codex?.oauth).toBe(true);
    expect(codex?.apiKey).toBe(false);
  });
});

describe("mergeProviderOptions", () => {
  test("null overview → just the bundled table, nothing configured", () => {
    const options = mergeProviderOptions(KNOWN_PROVIDERS, null);
    expect(options.length).toBe(KNOWN_PROVIDERS.length);
    expect(options.every((o) => o.credType === null && o.custom === false)).toBe(true);
  });

  test("models.json provider missing from the table joins as custom", () => {
    const options = mergeProviderOptions(KNOWN_PROVIDERS, {
      providers: ["my-relay"],
      withCredentials: [],
    });
    const custom = options.find((o) => o.id === "my-relay");
    expect(custom).toMatchObject({ custom: true, oauth: false, apiKey: true, credType: null });
  });

  test("table provider with stored credential keeps its table shape and gets credType", () => {
    const options = mergeProviderOptions(KNOWN_PROVIDERS, {
      providers: ["anthropic"],
      withCredentials: ["anthropic"],
      credentialTypes: { anthropic: "oauth" },
    });
    const anthropic = options.find((o) => o.id === "anthropic");
    expect(anthropic).toMatchObject({ custom: false, oauth: true, credType: "oauth" });
    // overview names never duplicate table entries
    expect(options.filter((o) => o.id === "anthropic")).toHaveLength(1);
  });

  test("unknown credType degrades to null, credential-only id becomes selectable", () => {
    const options = mergeProviderOptions(KNOWN_PROVIDERS, {
      providers: [],
      withCredentials: ["ghost"],
      credentialTypes: { ghost: "weird" },
    });
    const ghost = options.find((o) => o.id === "ghost");
    expect(ghost).toMatchObject({ custom: false, oauth: true, apiKey: true, credType: null });
  });

  test("sorted by display name", () => {
    const names = mergeProviderOptions(KNOWN_PROVIDERS, {
      providers: ["aaa-custom"],
      withCredentials: [],
    }).map((o) => o.name);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });
});

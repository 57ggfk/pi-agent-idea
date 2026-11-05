import { beforeAll, describe, expect, it } from "vitest";
import { en } from "./locales/en";
import { zh } from "./locales/zh";
import { FALLBACK, LANGUAGES, isRegistered } from "./languages";
import { i18n, initI18n, resolveLanguage } from "./index";

/** Locale module names derived from the same glob the loader uses. */
const localeFiles = Object.keys(import.meta.glob("./locales/*.ts"))
  .map((p) => /\/([^/]+)\.ts$/.exec(p)?.[1])
  .filter((n): n is string => n != null);

describe("registry and dictionaries (SC-002 / FR-016)", () => {
  it("registers exactly the languages that have a dictionary file", () => {
    expect(localeFiles.sort()).toEqual(LANGUAGES.map((l) => l.code).sort());
  });

  it("the fallback language is registered", () => {
    expect(isRegistered(FALLBACK)).toBe(true);
    expect(LANGUAGES.find((l) => l.code === FALLBACK)?.fallback).toBe(true);
  });

  it("zh covers every key of en", () => {
    const enKeys = Object.keys(en);
    const zhKeys = new Set(Object.keys(zh));
    const missing = enKeys.filter((k) => !zhKeys.has(k));
    expect(missing, `zh is missing: ${missing.join(", ")}`).toEqual([]);
  });

  it("no empty values and no key-identical values in any locale", () => {
    const dicts: Array<[Record<string, string>, string]> = [
      [en, "en"],
      [zh, "zh"],
    ];
    for (const [dict, name] of dicts) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value.trim().length, `${name}:${key} is empty`).toBeGreaterThan(0);
        expect(value, `${name}:${key} equals its key`).not.toBe(key);
        expect(value.includes("⟦"), `${name}:${key} contains the missing-marker`).toBe(false);
      }
    }
  });

  it("both locales disagree somewhere (the zh bundle is actually translated)", () => {
    const enRecord = en as Record<string, string>;
    const zhRecord = zh as Record<string, string>;
    const differing = Object.keys(enRecord).filter((k) => enRecord[k] !== zhRecord[k]);
    expect(differing.length).toBeGreaterThan(0);
  });
});

describe("plural coverage (FR-015 / SC-006)", () => {
  const pluralBases = Object.keys(en)
    .filter((k) => /_(one|other|few|many|two|zero)$/.test(k))
    .map((k) => k.replace(/_(one|other|few|many|two|zero)$/, ""));

  it.each(LANGUAGES)("$code covers every CLDR category its plural keys need", ({ code, bcp47 }) => {
    const dict: Record<string, string> = code === FALLBACK ? en : zh;
    const categories = new Intl.PluralRules(bcp47).resolvedOptions().pluralCategories;
    for (const base of pluralBases) {
      for (const cat of categories) {
        expect(dict[`${base}_${cat}`], `${code} misses ${base}_${cat}`).toBeTruthy();
      }
    }
  });

  it("en requires one+other where zh only requires other (sanity of the mechanism)", () => {
    expect(new Intl.PluralRules("en").resolvedOptions().pluralCategories).toEqual(["one", "other"]);
    expect(new Intl.PluralRules("zh-CN").resolvedOptions().pluralCategories).toEqual(["other"]);
  });
});

describe("runtime behavior (FR-009)", () => {
  beforeAll(async () => {
    await initI18n("system", "en");
  });

  it("a missing key renders ⟦key⟧ instead of a blank", () => {
    expect(i18n.t("does.not.exist" as never)).toBe("⟦does.not.exist⟧");
  });

  it("a known key renders its value", () => {
    expect(i18n.t("chat.tabs.chat")).toBe("Chat");
  });
});

describe("resolveLanguage (D1 / FR-004)", () => {
  it("prefers an explicitly registered code", () => {
    expect(resolveLanguage("zh", "en")).toBe("zh");
    expect(resolveLanguage("en", "zh-CN")).toBe("en");
  });

  it("system follows the IDE locale by BCP-47 prefix", () => {
    expect(resolveLanguage("system", "zh-CN")).toBe("zh");
    expect(resolveLanguage("system", "zh")).toBe("zh");
    expect(resolveLanguage("system", "en-US")).toBe("en");
    expect(resolveLanguage(undefined, "zh-TW")).toBe("zh");
  });

  it("falls back to the base language when nothing matches", () => {
    expect(resolveLanguage("system", "ja")).toBe("en");
    expect(resolveLanguage("system", "")).toBe("en");
    expect(resolveLanguage(undefined, undefined)).toBe("en");
  });

  it("an unregistered leftover code (e.g. removed ja) follows the IDE again", () => {
    expect(resolveLanguage("ja", "en-US")).toBe("en");
    expect(resolveLanguage("ja", "zh-CN")).toBe("zh");
  });
});

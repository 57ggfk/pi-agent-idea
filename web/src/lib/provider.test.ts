import { describe, expect, test } from "vitest";
import { isValidProviderName } from "./provider";

/** T129: the name rules both the form and the Kotlin writer enforce. */
describe("isValidProviderName", () => {
  test("accepts ordinary provider ids", () => {
    expect(isValidProviderName("openrouter")).toBe(true);
    expect(isValidProviderName("custom-provider_2")).toBe(true);
  });

  test("rejects empty, spaces, special characters and overlong names", () => {
    expect(isValidProviderName("")).toBe(false);
    expect(isValidProviderName("  ")).toBe(false);
    expect(isValidProviderName("bad name!")).toBe(false);
    expect(isValidProviderName("openai/official")).toBe(false);
    expect(isValidProviderName("x".repeat(65))).toBe(false);
  });
});

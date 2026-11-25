import { describe, expect, it } from "vitest";
import { injectionTrailing, trailingFor } from "./injectionTrailing";

/** 045 FR-001/FR-002/FR-003: one rule, applied once, never stacked. */
describe("injectionTrailing", () => {
  it("multi-line content ends with exactly one newline", () => {
    expect(injectionTrailing("a\nb")).toBe("a\nb\n");
    expect(injectionTrailing("a\nb\n")).toBe("a\nb\n");
    expect(injectionTrailing("a\nb\n\n\n")).toBe("a\nb\n");
  });

  it("single-line content ends with exactly two spaces", () => {
    expect(injectionTrailing("abc")).toBe("abc  ");
    expect(injectionTrailing("abc ")).toBe("abc  ");
    expect(injectionTrailing("abc   ")).toBe("abc  ");
  });

  it("never stacks when the equivalent trailing already exists", () => {
    expect(injectionTrailing("x\n")).toBe("x\n");
    expect(injectionTrailing("x  ")).toBe("x  ");
  });

  it("never trims whitespace inside the content", () => {
    expect(injectionTrailing("a  \nb")).toBe("a  \nb\n");
    expect(injectionTrailing("code();\n    ")).toBe("code();\n");
  });
});

describe("trailingFor (044 fold chip)", () => {
  it("multi-line paste → newline after the token", () => {
    expect(trailingFor("a\nb")).toBe("\n");
    expect(trailingFor("a\nb\n")).toBe("\n");
  });

  it("single-line paste → two spaces after the token", () => {
    expect(trailingFor("one long line")).toBe("  ");
  });
});

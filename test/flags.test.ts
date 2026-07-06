import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { intFlag, parseFlags } from "../src/flags.js";

const KNOWN = { "--limit": { takesValue: true }, "--full": { takesValue: false } };

describe("parseFlags", () => {
  it("separates positionals from flags in both value forms", () => {
    expect(parseFlags("q", ["a", "--limit", "5", "b", "--full"], KNOWN)).toEqual({
      positionals: ["a", "b"],
      flags: { "--limit": "5", "--full": true },
    });
    expect(parseFlags("q", ["--limit=5"], KNOWN).flags).toEqual({ "--limit": "5" });
  });

  it("fails loud on unknown flags, listing valid ones", () => {
    try {
      parseFlags("query", ["--stat"], KNOWN);
      throw new Error("should have thrown");
    } catch (error) {
      const axi = error as AxiError;
      expect(axi.code).toBe("VALIDATION_ERROR");
      expect(axi.message).toContain("--stat");
      expect(axi.suggestions[0]).toContain("--limit");
    }
  });

  it("rejects a value flag with no value", () => {
    expect(() => parseFlags("q", ["--limit"], KNOWN)).toThrow(/requires a value/);
    expect(() => parseFlags("q", ["--limit", "--full"], KNOWN)).toThrow(/requires a value/);
  });

  it("rejects a value on a boolean flag", () => {
    expect(() => parseFlags("q", ["--full=yes"], KNOWN)).toThrow(/does not take a value/);
  });

  it("always allows --help", () => {
    expect(parseFlags("q", ["--help"], {}).flags).toEqual({});
  });
});

describe("intFlag", () => {
  it("applies fallback and bounds", () => {
    expect(intFlag({}, "--limit", { fallback: 50, min: 1, max: 1000 })).toBe(50);
    expect(intFlag({ "--limit": "10" }, "--limit", { fallback: 50, min: 1, max: 1000 })).toBe(10);
    expect(() => intFlag({ "--limit": "0" }, "--limit", { fallback: 50, min: 1, max: 1000 })).toThrow();
    expect(() => intFlag({ "--limit": "1001" }, "--limit", { fallback: 50, min: 1, max: 1000 })).toThrow();
    expect(() => intFlag({ "--limit": "abc" }, "--limit", { fallback: 50, min: 1, max: 1000 })).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { cellValue, coerceNumeric, humanBytes, money, pct, shapeRows, startTimer } from "../src/format.js";

describe("startTimer", () => {
  it("renders a non-negative elapsed-seconds label", () => {
    const elapsed = startTimer();
    expect(elapsed()).toMatch(/^\d+\.\d+s$/);
  });
});

describe("humanBytes", () => {
  it("formats with one decimal below 100, none above", () => {
    expect(humanBytes(0)).toBe("0B");
    expect(humanBytes(1024)).toBe("1KB");
    expect(humanBytes(19_549_651_968)).toBe("18.2GB");
    expect(humanBytes(150 * 1024 ** 3)).toBe("150GB");
    expect(humanBytes(null)).toBe("");
  });
});

describe("coerceNumeric", () => {
  it("turns clean numeric strings into numbers", () => {
    expect(coerceNumeric("12456789.00")).toBe(12456789);
    expect(coerceNumeric("-3.5")).toBe(-3.5);
    expect(coerceNumeric("2026-05-31")).toBe("2026-05-31");
    expect(coerceNumeric("1234567890123456789")).toBe("1234567890123456789");
  });
});

describe("cellValue / shapeRows", () => {
  it("truncates long text with a marker and counts truncations", () => {
    const long = "x".repeat(300);
    const { rows, truncatedCells } = shapeRows([{ a: long, b: "short", c: null }], { maxCellChars: 200 });
    expect(rows[0].a).toBe(`${"x".repeat(200)}...`);
    expect(rows[0].b).toBe("short");
    expect(rows[0].c).toBe("");
    expect(truncatedCells).toBe(1);
  });

  it("coerces only columns flagged numeric, keeping leading zeros in text", () => {
    const { rows } = shapeRows([{ CODE: "007", AMT: "12456789.00" }], {
      maxCellChars: 200,
      numericColumns: new Set(["AMT"]),
    });
    expect(rows[0].CODE).toBe("007");
    expect(rows[0].AMT).toBe(12456789);
  });

  it("never coerces without numeric column metadata", () => {
    expect(cellValue("00120", 200).value).toBe("00120");
    expect(cellValue("42", 200).value).toBe("42");
    expect(cellValue("42", 200, true).value).toBe(42);
  });

  it("leaves cells alone with maxCellChars null", () => {
    const long = "x".repeat(300);
    expect(cellValue(long, null).value).toBe(long);
  });

  it("stringifies objects (VARIANT columns)", () => {
    expect(cellValue({ a: 1 }, 200).value).toBe('{"a":1}');
  });
});

describe("money / pct", () => {
  it("rounds money and computes safe percentages", () => {
    expect(money("12456789.44")).toBe(12456789);
    expect(money(null)).toBe(0);
    expect(pct(3632001, 12456789)).toBe(29.2);
    expect(pct(1, 0)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  bytesCell,
  cellValue,
  countCell,
  day,
  humanBytes,
  money,
  pct,
  revealFlags,
  shapeRows,
  shortHash,
  startTimer,
  truncationHint,
} from "../src/format.js";

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

describe("numeric coercion (via cellValue)", () => {
  it("turns clean numeric strings into numbers on numeric columns only", () => {
    expect(cellValue("12456789.00", 200, true).value).toBe(12456789);
    expect(cellValue("-3.5", 200, true).value).toBe(-3.5);
    expect(cellValue("2026-05-31", 200, true).value).toBe("2026-05-31");
    expect(cellValue("1234567890123456789", 200, true).value).toBe("1234567890123456789");
  });
});

describe("small formatters", () => {
  it("slices days and commit hashes, coalescing null", () => {
    expect(day("2026-05-31T10:00:00Z")).toBe("2026-05-31");
    expect(day(null)).toBe("");
    expect(shortHash("0123456789abcdef0123")).toBe("0123456789ab");
  });

  it("renders count/bytes cells with empty for unknown", () => {
    expect(countCell("48210332")).toBe(48210332);
    expect(countCell(null)).toBe("");
    expect(bytesCell("19549651968")).toBe("18.2GB");
    expect(bytesCell(undefined)).toBe("");
  });

  it("builds the standard truncation hint", () => {
    expect(truncationHint(3, 200)).toBe("3 cell(s) truncated at 200 chars; rerun with --full");
    expect(truncationHint(1, 100, "comment")).toBe("1 comment(s) truncated at 100 chars; rerun with --full");
  });
});

describe("cellValue / shapeRows", () => {
  it("truncates long text with the total size and counts truncations", () => {
    const long = "x".repeat(300);
    const { rows, truncatedCells } = shapeRows([{ a: long, b: "short", c: null }], { maxCellChars: 200 });
    expect(rows[0].a).toBe(`${"x".repeat(200)}... (300 chars total)`);
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

describe("revealFlags", () => {
  it("carries the filters that scoped the listing", () => {
    expect(revealFlags({})).toBe("");
    expect(revealFlags({ like: "fact" })).toBe(" --like fact");
    expect(revealFlags({ like: "FCT%" })).toBe(" --like FCT%");
    expect(revealFlags({ views: true })).toBe(" --views");
    expect(revealFlags({ like: "fact", views: true })).toBe(" --like fact --views");
  });

  it("quotes patterns the shell would mangle", () => {
    expect(revealFlags({ like: "FOO$BAR" })).toBe(" --like 'FOO$BAR'");
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

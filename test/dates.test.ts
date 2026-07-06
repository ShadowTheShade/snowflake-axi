import { describe, expect, it } from "vitest";
import { addMonthsEnd, lastCompletedMonthEnd, monthEnd } from "../src/dates.js";

describe("monthEnd", () => {
  it("returns the month-end for YYYY-MM and YYYY-MM-DD", () => {
    expect(monthEnd("2026-01")).toBe("2026-01-31");
    expect(monthEnd("2026-02")).toBe("2026-02-28");
    expect(monthEnd("2024-02")).toBe("2024-02-29");
    expect(monthEnd("2026-04-15")).toBe("2026-04-30");
  });

  it("rejects malformed periods", () => {
    expect(() => monthEnd("2026")).toThrow(/Invalid period/);
    expect(() => monthEnd("2026-13")).toThrow(/Invalid period/);
    expect(() => monthEnd("May 2026")).toThrow(/Invalid period/);
  });
});

describe("addMonthsEnd", () => {
  it("moves across year boundaries and short months", () => {
    expect(addMonthsEnd("2026-06-30", -11)).toBe("2025-07-31");
    expect(addMonthsEnd("2026-01-31", -1)).toBe("2025-12-31");
    expect(addMonthsEnd("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonthsEnd("2026-01-31", 1)).toBe("2026-02-28");
  });
});

describe("lastCompletedMonthEnd", () => {
  it("returns the previous month's end, including across January", () => {
    expect(lastCompletedMonthEnd(new Date(Date.UTC(2026, 6, 6)))).toBe("2026-06-30");
    expect(lastCompletedMonthEnd(new Date(Date.UTC(2026, 0, 15)))).toBe("2025-12-31");
    expect(lastCompletedMonthEnd(new Date(Date.UTC(2026, 6, 1)))).toBe("2026-06-30");
  });
});

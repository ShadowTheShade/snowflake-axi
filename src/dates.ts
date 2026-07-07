import { AxiError } from "axi-sdk-js";

function lastDayOf(year: number, monthIndex: number): string {
  const date = new Date(Date.UTC(year, monthIndex + 1, 0));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Accepts YYYY-MM or YYYY-MM-DD and returns the month-end date for that month. */
export function monthEnd(period: string): string {
  const match = period.match(/^(\d{4})-(\d{2})(-\d{2})?$/);
  if (!match) {
    throw new AxiError(`Invalid period '${period}'`, "VALIDATION_ERROR", ["Use YYYY-MM (e.g. --period 2026-05)"]);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new AxiError(`Invalid period '${period}'`, "VALIDATION_ERROR", ["Use YYYY-MM (e.g. --period 2026-05)"]);
  }
  return lastDayOf(year, month - 1);
}

/** Month-end of the month `delta` months away from the given month-end date. */
export function addMonthsEnd(monthEndDate: string, delta: number): string {
  const [year, month] = monthEndDate.split("-").map(Number);
  const index = year * 12 + (month - 1) + delta;
  return lastDayOf(Math.floor(index / 12), index % 12);
}

/** End of the previous month: the latest period that is ever allowed to surface. */
export function lastCompletedMonthEnd(now: Date = new Date()): string {
  return lastDayOf(now.getUTCFullYear(), now.getUTCMonth() - 1);
}

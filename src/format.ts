import { homedir } from "node:os";

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function collapseHome(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export function humanBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded}${UNITS[unit]}`;
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

/**
 * Renders a numeric-column string (the driver fetches numbers as strings for
 * precision) as a bare TOON number; '12456789.00' becomes 12456789. Only apply
 * to columns whose Snowflake type is numeric, never to text columns, where
 * values like '007' must keep their digits.
 */
function coerceNumeric(value: unknown): unknown {
  if (typeof value !== "string" || !NUMERIC.test(value)) return value;
  const integerDigits = value.replace(/^-/, "").split(".")[0].length;
  if (integerDigits > 15) return value;
  return Number(value);
}

export function cellValue(
  value: unknown,
  maxChars: number | null,
  numeric = false,
): { value: unknown; truncated: boolean } {
  if (value === null || value === undefined) return { value: "", truncated: false };
  const coerced = numeric ? coerceNumeric(value) : value;
  if (typeof coerced === "number" || typeof coerced === "boolean") {
    return { value: coerced, truncated: false };
  }
  const text = typeof coerced === "string" ? coerced : JSON.stringify(coerced);
  if (maxChars !== null && text.length > maxChars) {
    return { value: `${text.slice(0, maxChars)}... (${text.length} chars total)`, truncated: true };
  }
  return { value: text, truncated: false };
}

export function shapeRows(
  rows: Record<string, unknown>[],
  options: { maxCellChars: number | null; numericColumns?: Set<string> },
): { rows: Record<string, unknown>[]; truncatedCells: number } {
  let truncatedCells = 0;
  const shaped = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(row)) {
      const { value, truncated } = cellValue(raw, options.maxCellChars, options.numericColumns?.has(key));
      if (truncated) truncatedCells++;
      out[key] = value;
    }
    return out;
  });
  return { rows: shaped, truncatedCells };
}

/** Date-only slice of a timestamp-ish value, e.g. "2026-05-31". */
export function day(value: unknown): string {
  return String(value ?? "").slice(0, 10);
}

/** First 12 characters of a commit hash. */
export function shortHash(value: unknown): string {
  return String(value ?? "").slice(0, 12);
}

/** Row-count cell: numeric when known, empty when the catalog has no value. */
export function countCell(value: unknown): number | string {
  return value === null || value === undefined ? "" : Number(value);
}

/** Size cell: human-readable bytes, empty when the catalog has no value. */
export function bytesCell(value: unknown): string {
  return humanBytes(value === null || value === undefined ? null : Number(value));
}

/** The standard truncated-cells help line, pointing at the --full escape hatch. */
export function truncationHint(count: number, limit: number, noun = "cell"): string {
  return `${count} ${noun}(s) truncated at ${limit} chars; rerun with --full`;
}

/**
 * Flag tail for reveal hints, carrying the filters that scoped the current
 * listing so the suggested rerun returns the same slice, not an unfiltered one.
 */
export function revealFlags(options: { like?: string; views?: boolean }): string {
  const parts: string[] = [];
  if (options.like !== undefined) {
    parts.push(/^[A-Za-z0-9_%]+$/.test(options.like) ? `--like ${options.like}` : `--like '${options.like}'`);
  }
  if (options.views) parts.push("--views");
  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

/** Elapsed-seconds label on the monotonic clock, immune to wall-clock steps (WSL NTP corrections). */
export function startTimer(): () => string {
  const started = performance.now();
  return () => `${((performance.now() - started) / 1000).toFixed(1)}s`;
}

export function money(value: unknown): number {
  return Math.round(Number(value ?? 0));
}

export function pct(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

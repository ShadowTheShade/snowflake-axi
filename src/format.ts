const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

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

/** Renders numeric strings as bare TOON numbers; '12456789.00' becomes 12456789. */
export function coerceNumeric(value: unknown): unknown {
  if (typeof value !== "string" || !NUMERIC.test(value)) return value;
  const integerDigits = value.replace(/^-/, "").split(".")[0].length;
  if (integerDigits > 15) return value;
  return Number(value);
}

export function cellValue(value: unknown, maxChars: number | null): { value: unknown; truncated: boolean } {
  if (value === null || value === undefined) return { value: "", truncated: false };
  const coerced = coerceNumeric(value);
  if (typeof coerced === "number" || typeof coerced === "boolean") {
    return { value: coerced, truncated: false };
  }
  const text = typeof coerced === "string" ? coerced : JSON.stringify(coerced);
  if (maxChars !== null && text.length > maxChars) {
    return { value: `${text.slice(0, maxChars)}...`, truncated: true };
  }
  return { value: text, truncated: false };
}

export function shapeRows(
  rows: Record<string, unknown>[],
  options: { maxCellChars: number | null },
): { rows: Record<string, unknown>[]; truncatedCells: number } {
  let truncatedCells = 0;
  const shaped = rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(row)) {
      const { value, truncated } = cellValue(raw, options.maxCellChars);
      if (truncated) truncatedCells++;
      out[key] = value;
    }
    return out;
  });
  return { rows: shaped, truncatedCells };
}

export function money(value: unknown): number {
  return Math.round(Number(value ?? 0));
}

export function pct(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

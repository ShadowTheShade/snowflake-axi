import { shapeRows } from "./format.js";
import type { QueryResult } from "./snowflake.js";

export const CELL_LIMIT = 200;

/** Shapes a query result the way `query` reports it: definitive counts, cell truncation, follow-up hints. */
export function presentRows(result: QueryResult, full: boolean): Record<string, unknown> {
  const { rows, total, numericColumns } = result;
  if (total === 0) {
    return { count: "0 rows" };
  }
  const { rows: shaped, truncatedCells } = shapeRows(rows, {
    maxCellChars: full ? null : CELL_LIMIT,
    numericColumns,
  });
  const help: string[] = [];
  if (rows.length < total) {
    help.push(`Run with --limit ${Math.min(total, 1000)} to fetch more of the ${total} rows`);
  }
  if (truncatedCells > 0) {
    help.push(`${truncatedCells} cell(s) truncated at ${CELL_LIMIT} chars; rerun with --full`);
  }
  const count = rows.length < total ? `${rows.length} of ${total} total` : `${total} (complete)`;
  return {
    count,
    rows: shaped,
    ...(help.length > 0 ? { help } : {}),
  };
}

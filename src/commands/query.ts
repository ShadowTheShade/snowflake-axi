import { AxiError } from "axi-sdk-js";
import { intFlag, parseFlags } from "../flags.js";
import { shapeRows } from "../format.js";
import { runQuery } from "../snowflake.js";
import { assertReadOnly } from "../validate.js";
import type { CommandSpec } from "../command.js";

const FLAGS = {
  "--limit": { takesValue: true },
  "--full": { takesValue: false },
  "--timeout": { takesValue: true },
};

const CELL_LIMIT = 200;

async function run(args: string[]): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseFlags("query", args, FLAGS);
  const limit = intFlag(flags, "--limit", { fallback: 50, min: 1, max: 1000 });
  const timeout = intFlag(flags, "--timeout", { fallback: 60, min: 1, max: 3600 });
  const full = flags["--full"] === true;

  const rawSql = positionals.join(" ").trim();
  if (!rawSql) {
    throw new AxiError("No SQL provided", "VALIDATION_ERROR", [
      'Run `snowflake-axi query "SELECT ..."`',
    ]);
  }
  const { sql } = assertReadOnly(rawSql);

  await runQuery(`ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = ${timeout}`);
  const started = Date.now();
  const { rows, total } = await runQuery(sql, { maxRows: limit });
  const elapsed = `${((Date.now() - started) / 1000).toFixed(1)}s`;

  if (total === 0) {
    return { count: "0 rows", elapsed };
  }

  const { rows: shaped, truncatedCells } = shapeRows(rows, { maxCellChars: full ? null : CELL_LIMIT });
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
    elapsed,
    ...(help.length > 0 ? { help } : {}),
  };
}

export const queryCommand: CommandSpec = {
  summary: "Run read-only SQL (SELECT/WITH/SHOW/DESC/EXPLAIN)",
  help: `command: query
description: Run one read-only SQL statement; write statements are rejected with the SQL handed back
usage: snowflake-axi query "<sql>" [flags]
flags:
  --limit <n>: max rows fetched (default 50, max 1000); total count is always reported
  --full: disable 200-char cell truncation
  --timeout <s>: statement timeout in seconds (default 60)
notes:
  Unqualified table names resolve against the configured default database.schema.
  Allowed statement heads: SELECT, WITH, SHOW, DESC, DESCRIBE, EXPLAIN.
examples:
  snowflake-axi query "SELECT COUNT(*) FROM FCT_ORDERS"
  snowflake-axi query "SHOW SCHEMAS IN DATABASE ANALYTICS_DB"
  snowflake-axi query "SELECT * FROM DIM_CUSTOMERS WHERE REGION = 'EMEA'" --limit 100
`,
  run,
};

import { AxiError } from "axi-sdk-js";
import { type CommandArgs, defineCommand } from "../command.js";
import { shapeRows } from "../format.js";
import { runQuery } from "../snowflake.js";
import { assertReadOnly } from "../validate.js";

const CELL_LIMIT = 200;

async function run(args: CommandArgs): Promise<Record<string, unknown>> {
  const limit = args.int("--limit");
  const timeout = args.int("--timeout");
  const full = args.bool("--full");

  const rawSql = args.positionals.join(" ").trim();
  if (!rawSql) {
    throw new AxiError("No SQL provided", "VALIDATION_ERROR", ['Run `snowflake-axi query "SELECT ..."`']);
  }
  const { sql } = assertReadOnly(rawSql);

  const started = Date.now();
  const { rows, total, numericColumns } = await runQuery(sql, { maxRows: limit, timeoutSeconds: timeout });
  const elapsed = `${((Date.now() - started) / 1000).toFixed(1)}s`;

  if (total === 0) {
    return { count: "0 rows", elapsed };
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
    elapsed,
    ...(help.length > 0 ? { help } : {}),
  };
}

export const queryCommand = defineCommand("query", {
  summary: "Run read-only SQL (SELECT/WITH/SHOW/DESC/EXPLAIN)",
  action: {
    description: "Run one read-only SQL statement; write statements are rejected with the SQL handed back",
    positionals: { usage: '"<sql>"', min: 0, max: Number.POSITIVE_INFINITY },
    flags: {
      "--limit": {
        type: "int",
        placeholder: "<n>",
        description: "max rows fetched; total count is always reported",
        default: 50,
        min: 1,
        max: 1000,
      },
      "--full": { type: "boolean", description: `disable ${CELL_LIMIT}-char cell truncation` },
      "--timeout": {
        type: "int",
        placeholder: "<s>",
        description: "statement timeout in seconds",
        default: 60,
        min: 1,
        max: 3600,
      },
    },
    notes: [
      "Unqualified table names resolve against the configured default database.schema.",
      "Allowed statement heads: SELECT, WITH, SHOW, DESC, DESCRIBE, EXPLAIN.",
    ],
    examples: [
      'snowflake-axi query "SELECT COUNT(*) FROM FCT_ORDERS"',
      'snowflake-axi query "SHOW SCHEMAS IN DATABASE ANALYTICS_DB"',
      "snowflake-axi query \"SELECT * FROM DIM_CUSTOMERS WHERE REGION = 'EMEA'\" --limit 100",
    ],
    run,
  },
});

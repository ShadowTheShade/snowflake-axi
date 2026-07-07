import { AxiError } from "axi-sdk-js";
import { type CommandArgs, defineCommand } from "../command.js";
import { shapeRows } from "../format.js";
import { IDENTIFIER, resolveTableName } from "../names.js";
import { runQuery } from "../snowflake.js";
import { assertReadOnly } from "../validate.js";

const CELL_LIMIT = 200;

async function run(args: CommandArgs): Promise<Record<string, unknown>> {
  const name = resolveTableName(args.positionals[0]);
  const limit = args.int("--limit");
  const full = args.bool("--full");

  let select = "*";
  const fields = args.str("--fields");
  if (fields !== undefined) {
    const list = fields.split(",").map((f) => f.trim().toUpperCase());
    const bad = list.filter((f) => !IDENTIFIER.test(f));
    if (list.length === 0 || bad.length > 0) {
      throw new AxiError(`Invalid --fields value${bad.length ? ` '${bad[0]}'` : ""}`, "VALIDATION_ERROR", [
        "Use a comma-separated list of column names: --fields ORDER_DATE,ORDER_TOTAL",
      ]);
    }
    select = list.join(", ");
  }

  const where = args.str("--where");
  const whereClause = where === undefined ? "" : ` WHERE ${where}`;

  const sql = `SELECT ${select} FROM ${name.fqn}${whereClause} LIMIT ${limit}`;
  assertReadOnly(sql);
  const { rows, numericColumns } = await runQuery(sql, { maxRows: limit });

  if (rows.length === 0) {
    const scope = whereClause ? ` matching --where in ${name.fqn}` : ` in ${name.fqn}`;
    return { table: name.fqn, count: `0 rows${scope}` };
  }

  const { rows: shaped, truncatedCells } = shapeRows(rows, {
    maxCellChars: full ? null : CELL_LIMIT,
    numericColumns,
  });
  return {
    table: name.fqn,
    rows: shaped,
    ...(truncatedCells > 0
      ? { help: [`${truncatedCells} cell(s) truncated at ${CELL_LIMIT} chars; rerun with --full`] }
      : {}),
  };
}

export const sampleCommand = defineCommand("sample", {
  summary: "Preview rows from a table, optionally filtered and projected",
  action: {
    description: "Preview rows from a table or view",
    positionals: { usage: "<table>", min: 1, max: 1 },
    flags: {
      "--limit": { type: "int", placeholder: "<n>", description: "rows to fetch", default: 5, min: 1, max: 100 },
      "--fields": { type: "string", placeholder: "<a,b,c>", description: "columns to select (default all)" },
      "--where": { type: "string", placeholder: '"<predicate>"', description: "SQL predicate to filter by" },
      "--full": { type: "boolean", description: `disable ${CELL_LIMIT}-char cell truncation` },
    },
    examples: [
      "snowflake-axi sample FCT_ORDERS --limit 3 --fields ORDER_DATE,CUSTOMER_ID,ORDER_TOTAL",
      "snowflake-axi sample DIM_CUSTOMERS --where \"REGION = 'EMEA'\"",
    ],
    run,
  },
});

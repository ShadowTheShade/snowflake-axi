import { type CommandArgs, defineCommand } from "../command.js";
import { shapeRows, truncationHint } from "../format.js";
import { parseFields, resolveTableName } from "../names.js";
import { CELL_LIMIT } from "../present.js";
import { runQuery } from "../snowflake.js";
import { assertReadOnly } from "../validate.js";

async function run(args: CommandArgs): Promise<Record<string, unknown>> {
  const name = resolveTableName(args.positionals[0]);
  const limit = args.int("--limit");
  const full = args.bool("--full");

  const fields = args.str("--fields");
  const select = fields === undefined ? "*" : parseFields(fields, "upper");

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
    ...(truncatedCells > 0 ? { help: [truncationHint(truncatedCells, CELL_LIMIT)] } : {}),
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

import { AxiError } from "axi-sdk-js";
import { intFlag, parseFlags } from "../flags.js";
import { shapeRows } from "../format.js";
import { IDENTIFIER, resolveTableName } from "../names.js";
import { runQuery } from "../snowflake.js";
import { assertReadOnly } from "../validate.js";
import type { CommandSpec } from "../command.js";

const FLAGS = {
  "--limit": { takesValue: true },
  "--fields": { takesValue: true },
  "--where": { takesValue: true },
  "--full": { takesValue: false },
};

const CELL_LIMIT = 200;

async function run(args: string[]): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseFlags("sample", args, FLAGS);
  if (positionals.length !== 1) {
    throw new AxiError("sample takes exactly one table name", "VALIDATION_ERROR", [
      "Run `snowflake-axi sample <table> [--fields a,b] [--where \"<predicate>\"]`",
    ]);
  }
  const name = resolveTableName(positionals[0]);
  const limit = intFlag(flags, "--limit", { fallback: 5, min: 1, max: 100 });
  const full = flags["--full"] === true;

  let select = "*";
  const fields = flags["--fields"];
  if (typeof fields === "string") {
    const list = fields.split(",").map((f) => f.trim().toUpperCase());
    const bad = list.filter((f) => !IDENTIFIER.test(f));
    if (list.length === 0 || bad.length > 0) {
      throw new AxiError(`Invalid --fields value${bad.length ? ` '${bad[0]}'` : ""}`, "VALIDATION_ERROR", [
        "Use a comma-separated list of column names: --fields ORDER_DATE,ORDER_TOTAL",
      ]);
    }
    select = list.join(", ");
  }

  let whereClause = "";
  const where = flags["--where"];
  if (typeof where === "string") {
    whereClause = ` WHERE ${where}`;
  }

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

export const sampleCommand: CommandSpec = {
  summary: "Preview rows from a table, optionally filtered and projected",
  help: `command: sample
description: Preview rows from a table or view
usage: snowflake-axi sample <table> [flags]
flags:
  --limit <n>: rows to fetch (default 5, max 100)
  --fields <a,b,c>: columns to select (default all)
  --where "<predicate>": SQL predicate to filter by
  --full: disable 200-char cell truncation
examples:
  snowflake-axi sample FCT_ORDERS --limit 3 --fields ORDER_DATE,CUSTOMER_ID,ORDER_TOTAL
  snowflake-axi sample DIM_CUSTOMERS --where "REGION = 'EMEA'"
`,
  run,
};

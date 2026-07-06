import { AxiError } from "axi-sdk-js";
import { parseFlags } from "../flags.js";
import { humanBytes } from "../format.js";
import { resolveTableName } from "../names.js";
import { runQuery } from "../snowflake.js";
import type { CommandSpec } from "../command.js";

async function run(args: string[]): Promise<Record<string, unknown>> {
  const { positionals } = parseFlags("schema", args, {});
  if (positionals.length !== 1) {
    throw new AxiError("schema takes exactly one table name", "VALIDATION_ERROR", [
      "Run `snowflake-axi schema <table>`",
    ]);
  }
  const name = resolveTableName(positionals[0]);

  const [columns, meta] = await Promise.all([
    runQuery(`DESC TABLE ${name.fqn}`),
    runQuery(
      `SELECT TABLE_TYPE, ROW_COUNT, BYTES FROM ${name.database}.INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      { binds: [name.schema, name.table] },
    ),
  ]);

  const info = meta.rows[0];
  return {
    table: name.fqn,
    kind: info?.TABLE_TYPE === "BASE TABLE" ? "TABLE" : (info?.TABLE_TYPE ?? "TABLE"),
    rows: info?.ROW_COUNT === null || info?.ROW_COUNT === undefined ? "" : Number(info.ROW_COUNT),
    size: humanBytes(info?.BYTES === null || info?.BYTES === undefined ? null : Number(info.BYTES)),
    columns: columns.rows.map((row) => ({
      name: row.name,
      type: String(row.type).replace(",", "."),
      null: row["null?"],
    })),
    help: [`Run \`snowflake-axi sample ${positionals[0]} --fields <a,b>\` to preview data`],
  };
}

export const schemaCommand: CommandSpec = {
  summary: "Columns, types, row count, and size for a table or view",
  help: `command: schema
description: Columns with types and nullability, plus row count and size
usage: snowflake-axi schema <table>
notes:
  Table names resolve as table, schema.table, or db.schema.table against the configured defaults.
  NUMBER(38.2) means NUMBER(38,2); the comma is dotted to keep TOON rows unquoted.
examples:
  snowflake-axi schema FCT_ORDERS
  snowflake-axi schema ANALYTICS_DB.PUBLIC.DIM_CUSTOMERS
`,
  run,
};

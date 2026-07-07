import { type CommandArgs, defineCommand } from "../command.js";
import { humanBytes } from "../format.js";
import { resolveTableName } from "../names.js";
import { runQuery } from "../snowflake.js";

async function run(args: CommandArgs): Promise<Record<string, unknown>> {
  const name = resolveTableName(args.positionals[0]);

  const infoSchema = name.database ? `${name.database}.INFORMATION_SCHEMA.TABLES` : "INFORMATION_SCHEMA.TABLES";
  const schemaFilter = name.schema ? "TABLE_SCHEMA = ?" : "TABLE_SCHEMA = CURRENT_SCHEMA()";
  const binds = name.schema ? [name.schema, name.table] : [name.table];
  const [columns, meta] = await Promise.all([
    runQuery(`DESC TABLE ${name.fqn}`),
    runQuery(`SELECT TABLE_TYPE, ROW_COUNT, BYTES FROM ${infoSchema} WHERE ${schemaFilter} AND TABLE_NAME = ?`, {
      binds,
    }),
  ]);

  const info = meta.rows[0];
  return {
    table: name.fqn,
    kind: info?.TABLE_TYPE === "BASE TABLE" ? "TABLE" : (info?.TABLE_TYPE ?? "TABLE"),
    rows: info?.ROW_COUNT === null || info?.ROW_COUNT === undefined ? "" : Number(info.ROW_COUNT),
    size: humanBytes(info?.BYTES === null || info?.BYTES === undefined ? null : Number(info.BYTES)),
    columns: columns.rows.map((row) => ({
      name: row.name,
      type: row.type,
      null: row["null?"],
    })),
    help: [`Run \`snowflake-axi sample ${args.positionals[0]} --fields <a,b>\` to preview data`],
  };
}

export const schemaCommand = defineCommand("schema", {
  summary: "Columns, types, row count, and size for a table or view",
  action: {
    description: "Columns with types and nullability, plus row count and size",
    positionals: { usage: "<table>", min: 1, max: 1 },
    notes: [
      "Table names resolve as table, schema.table, or db.schema.table; unqualified parts use the session's default namespace.",
    ],
    examples: ["snowflake-axi schema FCT_ORDERS", "snowflake-axi schema ANALYTICS_DB.PUBLIC.DIM_CUSTOMERS"],
    run,
  },
});

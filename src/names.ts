import { AxiError } from "axi-sdk-js";
import { IDENTIFIER, loadConfig } from "./config.js";

export { IDENTIFIER };

export interface TableName {
  database: string;
  schema: string;
  table: string;
  fqn: string;
}

/** Resolves table, schema.table, or db.schema.table against configured defaults. */
export function resolveTableName(raw: string): TableName {
  const parts = raw.split(".");
  if (parts.length > 3 || !parts.every((p) => IDENTIFIER.test(p))) {
    throw new AxiError(`Invalid table name '${raw}'`, "VALIDATION_ERROR", [
      "Use `table`, `schema.table`, or `db.schema.table` with unquoted identifiers",
    ]);
  }
  const config = loadConfig();
  const upper = parts.map((p) => p.toUpperCase());
  const [database, schema, table] =
    upper.length === 3
      ? upper
      : upper.length === 2
        ? [config.database?.toUpperCase(), ...upper]
        : [config.database?.toUpperCase(), config.schema?.toUpperCase(), upper[0]];
  if (!database || !schema) {
    throw new AxiError(`Cannot resolve '${raw}' without a default database and schema`, "VALIDATION_ERROR", [
      "Qualify the name as db.schema.table or set SNOWFLAKE_DATABASE and SNOWFLAKE_SCHEMA in the env file",
    ]);
  }
  return { database, schema, table: table!, fqn: `${database}.${schema}.${table}` };
}

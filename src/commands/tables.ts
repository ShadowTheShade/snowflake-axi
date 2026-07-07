import { AxiError } from "axi-sdk-js";
import type { CommandSpec } from "../command.js";
import { IDENTIFIER, loadConfig } from "../config.js";
import { intFlag, parseFlags } from "../flags.js";
import { humanBytes } from "../format.js";
import { runQuery } from "../snowflake.js";

const FLAGS = {
  "--like": { takesValue: true },
  "--views": { takesValue: false },
  "--limit": { takesValue: true },
};

function parseScope(positionals: string[]): { database?: string; schema?: string } {
  if (positionals.length === 0) return {};
  if (positionals.length > 1) {
    throw new AxiError("tables takes at most one scope argument", "VALIDATION_ERROR", [
      "Run `snowflake-axi tables [db[.schema]]`",
    ]);
  }
  const parts = positionals[0].split(".");
  if (parts.length > 2 || !parts.every((p) => IDENTIFIER.test(p))) {
    throw new AxiError(`Invalid scope '${positionals[0]}'`, "VALIDATION_ERROR", [
      "Use `db` or `db.schema` with unquoted identifiers",
    ]);
  }
  const [database, schema] = parts.map((p) => p.toUpperCase());
  return { database, schema };
}

function likePattern(raw: string): string {
  return raw.includes("%") || raw.includes("_") ? raw : `%${raw}%`;
}

async function schemasSummary(
  database: string,
  options: { like?: string; limit: number },
): Promise<Record<string, unknown>> {
  const binds: string[] = [];
  let filter = "";
  if (options.like !== undefined) {
    filter = " AND TABLE_SCHEMA ILIKE ?";
    binds.push(likePattern(options.like));
  }
  const { rows } = await runQuery(
    `SELECT TABLE_SCHEMA AS NAME, COUNT(*) AS TABLES, SUM(BYTES) AS BYTES
     FROM ${database}.INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA != 'INFORMATION_SCHEMA'${filter}
     GROUP BY 1 ORDER BY 3 DESC NULLS LAST, 1`,
    { binds },
  );
  const matchLabel = options.like !== undefined ? ` matching '${likePattern(options.like)}'` : "";
  if (rows.length === 0) {
    return { database, count: `0 schemas with tables${matchLabel}` };
  }
  const shown = rows.slice(0, options.limit);
  const help = [`Run \`snowflake-axi tables ${database}.<schema>\` to list a schema's tables`];
  if (shown.length < rows.length) {
    help.unshift(`Run \`snowflake-axi tables ${database} --limit ${rows.length}\` for all ${rows.length} schemas`);
  }
  return {
    database,
    schemas: shown.map((row) => ({
      name: row.NAME,
      tables: Number(row.TABLES),
      size: humanBytes(row.BYTES === null ? null : Number(row.BYTES)),
    })),
    help,
  };
}

async function run(args: string[]): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseFlags("tables", args, FLAGS);
  const config = loadConfig();
  const scope = parseScope(positionals);
  const includeViews = flags["--views"] === true;
  const limit = intFlag(flags, "--limit", { fallback: 100, min: 1, max: 10000 });
  const like = typeof flags["--like"] === "string" ? flags["--like"] : undefined;

  const database = scope.database ?? config.database?.toUpperCase();
  if (!database) {
    throw new AxiError("No database in scope", "VALIDATION_ERROR", [
      "Run `snowflake-axi tables <db>[.<schema>]` or set SNOWFLAKE_DATABASE in the env file",
    ]);
  }
  const schema = scope.schema ?? (scope.database ? undefined : config.schema?.toUpperCase());
  if (!schema) {
    if (includeViews) {
      throw new AxiError("Flag --views applies to a schema scope", "VALIDATION_ERROR", [
        `Run \`snowflake-axi tables ${database}.<schema> --views\``,
      ]);
    }
    return schemasSummary(database, { like, limit });
  }

  const binds: string[] = [schema];
  let filter = "";
  if (like !== undefined) {
    filter = " AND TABLE_NAME ILIKE ?";
    binds.push(likePattern(like));
  }
  const { rows } = await runQuery(
    `SELECT TABLE_NAME AS NAME, TABLE_TYPE AS KIND, ROW_COUNT, BYTES
     FROM ${database}.INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = ?${filter}
     ORDER BY ROW_COUNT DESC NULLS LAST, TABLE_NAME`,
    { binds },
  );

  const scopeLabel = `${database}.${schema}`;
  const matchLabel = like !== undefined ? ` matching '${likePattern(like)}'` : "";
  const views = rows.filter((row) => row.KIND === "VIEW");
  const listed = includeViews ? rows : rows.filter((row) => row.KIND !== "VIEW");

  if (listed.length === 0) {
    const viewNote = !includeViews && views.length > 0 ? ` (${views.length} views excluded; use --views)` : "";
    return { scope: scopeLabel, count: `0 tables${matchLabel} in ${scopeLabel}${viewNote}` };
  }

  const shown = listed.slice(0, limit);
  const viewNote = includeViews ? "" : views.length > 0 ? ` (${views.length} views excluded; use --views)` : "";
  const help = [
    "Run `snowflake-axi schema <table>` for columns",
    'Run `snowflake-axi query "SELECT ..."` to aggregate or filter',
  ];
  if (shown.length < listed.length) {
    help.unshift(`Run \`snowflake-axi tables ${scopeLabel} --limit ${listed.length}\` for all ${listed.length}`);
  }
  return {
    scope: scopeLabel,
    count: `${listed.length} tables${matchLabel}, largest first${viewNote}`,
    tables: shown.map((row) => ({
      name: row.NAME,
      ...(includeViews ? { kind: row.KIND === "BASE TABLE" ? "TABLE" : row.KIND } : {}),
      rows: row.ROW_COUNT === null || row.ROW_COUNT === undefined ? "" : Number(row.ROW_COUNT),
      size: humanBytes(row.BYTES === null || row.BYTES === undefined ? null : Number(row.BYTES)),
    })),
    help,
  };
}

export const tablesCommand: CommandSpec = {
  summary: "List tables with row counts and sizes; db scope lists schemas",
  help: `command: tables
description: List tables with row counts and sizes, largest first (INFORMATION_SCHEMA, no scan)
usage: snowflake-axi tables [db[.schema]] [flags]
scopes:
  (none): tables in the configured default database.schema
  db: schema summary for that database
  db.schema: tables in that schema
flags:
  --like <pattern>: filter tables (schema scope) or schemas (db scope), case-insensitive; bare words match as contains
  --views: include views, adds a kind column (schema scope only)
  --limit <n>: max rows shown (default 100)
examples:
  snowflake-axi tables
  snowflake-axi tables ANALYTICS_DB
  snowflake-axi tables ANALYTICS_DB.PUBLIC --like fact
`,
  run,
};

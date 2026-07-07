import { AxiError } from "axi-sdk-js";
import { type CommandArgs, defineCommand } from "../command.js";
import { humanBytes } from "../format.js";
import { likePattern } from "../names.js";
import { runQuery } from "../snowflake.js";

// SHOW LIKE takes a string literal, not a bind; a strict charset keeps the
// embedded pattern safe and fails loud on anything surprising.
const PATTERN = /^[A-Za-z0-9_$%]+$/;

async function run(args: CommandArgs): Promise<Record<string, unknown>> {
  const raw = args.positionals[0];
  if (!PATTERN.test(raw)) {
    throw new AxiError(`Invalid search pattern '${raw}'`, "VALIDATION_ERROR", [
      "Use letters, digits, _, $, and % wildcards, e.g. `snowflake-axi find flavor`",
    ]);
  }
  const limit = args.int("--limit");
  const pattern = likePattern(raw).toUpperCase();

  const { rows } = await runQuery(`SHOW OBJECTS LIKE '${pattern}' IN ACCOUNT`);
  const matches = rows
    .filter((row) => row.schema_name !== "INFORMATION_SCHEMA")
    .sort((a, b) => Number(b.rows ?? -1) - Number(a.rows ?? -1));

  if (matches.length === 0) {
    return { count: `0 tables or views match '${pattern}' account-wide with this role` };
  }

  const shown = matches.slice(0, limit);
  const help = [
    "Run `snowflake-axi schema <db.schema.table>` for columns",
    "Run `snowflake-axi sample <db.schema.table>` to preview data",
  ];
  if (shown.length < matches.length) {
    help.unshift(`Run \`snowflake-axi find ${raw} --limit ${matches.length}\` for all ${matches.length}`);
  }
  return {
    count: `${matches.length} objects match '${pattern}' account-wide, largest first`,
    objects: shown.map((row) => ({
      name: `${row.database_name}.${row.schema_name}.${row.name}`,
      kind: row.kind === "BASE TABLE" ? "TABLE" : row.kind,
      rows: row.rows === null || row.rows === undefined ? "" : Number(row.rows),
      size: humanBytes(row.bytes === null || row.bytes === undefined ? null : Number(row.bytes)),
    })),
    help,
  };
}

export const findCommand = defineCommand("find", {
  summary: "Search tables and views by name across the whole account",
  action: {
    description:
      "Search all databases for tables and views whose name matches a pattern; visibility follows the active roles",
    positionals: { usage: "<pattern>", min: 1, max: 1 },
    flags: {
      "--limit": { type: "int", placeholder: "<n>", description: "max rows shown", default: 100, min: 1, max: 10000 },
    },
    notes: [
      "Bare words match as contains (case-insensitive); % and _ wildcards pass through.",
      "INFORMATION_SCHEMA views are excluded from matches.",
    ],
    examples: ["snowflake-axi find flavor", "snowflake-axi find FCT_%"],
    run,
  },
});

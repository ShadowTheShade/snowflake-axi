import { type CommandArgs, defineCommand } from "../command.js";
import { bytesCell, countCell } from "../format.js";
import { objectFqn, safeLike } from "../names.js";
import { runQuery } from "../snowflake.js";

async function run(args: CommandArgs): Promise<Record<string, unknown>> {
  const raw = args.positionals[0];
  const limit = args.int("--limit");
  const pattern = safeLike(raw, "search").toUpperCase();

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
      name: objectFqn(row),
      kind: row.kind === "BASE TABLE" ? "TABLE" : row.kind,
      rows: countCell(row.rows),
      size: bytesCell(row.bytes),
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

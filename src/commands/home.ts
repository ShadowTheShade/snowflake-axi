import { loadConfig, loadPgConfig } from "../config.js";
import { runQuery } from "../snowflake.js";

function pgConfigured(): boolean {
  try {
    loadPgConfig();
    return true;
  } catch {
    return false;
  }
}

// The home view is the highest-traffic surface, so the database list is
// capped; the full list stays one suggested command away. `tables` cannot be
// that command (with a default namespace it lists tables, not databases), so
// the hint goes through `query "SHOW DATABASES"`, which is right in any state.
const DATABASE_LIMIT = 100;

export async function homeView(pluginHelp: string[]): Promise<Record<string, unknown>> {
  const config = loadConfig();
  const [session, databases] = await Promise.all([
    runQuery(
      "SELECT CURRENT_ACCOUNT() AS ACCOUNT, CURRENT_USER() AS USER, CURRENT_ROLE() AS ROLE, CURRENT_WAREHOUSE() AS WAREHOUSE, CURRENT_DATABASE() AS DATABASE, CURRENT_SCHEMA() AS SCHEMA",
    ),
    runQuery("SHOW DATABASES"),
  ]);
  const current = session.rows[0] ?? {};
  const shown = databases.rows.slice(0, DATABASE_LIMIT);
  const truncated = shown.length < databases.rows.length;
  return {
    connection: {
      account: current.ACCOUNT ?? config.account,
      user: current.USER ?? config.user,
      role: current.ROLE ?? "",
      warehouse: current.WAREHOUSE ?? "",
      default: [current.DATABASE, current.SCHEMA].filter(Boolean).join(".") || "(none)",
    },
    ...(truncated ? { count: `${databases.rows.length} databases, first ${shown.length} shown` } : {}),
    databases: shown.map((row) => ({ name: row.name })),
    help: [
      ...(truncated
        ? [
            `Run \`snowflake-axi query "SHOW DATABASES" --limit ${databases.rows.length}\` for all ${databases.rows.length} databases`,
          ]
        : []),
      "Run `snowflake-axi tables [db[.schema]]` to list tables with row counts",
      'Run `snowflake-axi query "SELECT ..."` to run read-only SQL',
      "Run `snowflake-axi semantics` for the curated map of metrics and verified queries",
      "Run `snowflake-axi find <pattern>` to search tables and views by name account-wide",
      ...(pgConfigured() ? ["Run `snowflake-axi pg` for the Snowflake Postgres side (read-only)"] : []),
      ...pluginHelp,
    ],
  };
}

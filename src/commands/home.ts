import { loadConfig } from "../config.js";
import { runQuery } from "../snowflake.js";

export async function homeView(pluginHelp: string[]): Promise<Record<string, unknown>> {
  const config = loadConfig();
  const [session, databases] = await Promise.all([
    runQuery(
      "SELECT CURRENT_ACCOUNT() AS ACCOUNT, CURRENT_USER() AS USER, CURRENT_ROLE() AS ROLE, CURRENT_WAREHOUSE() AS WAREHOUSE",
    ),
    runQuery("SHOW DATABASES"),
  ]);
  const current = session.rows[0] ?? {};
  return {
    connection: {
      account: current.ACCOUNT ?? config.account,
      user: current.USER ?? config.user,
      role: current.ROLE ?? "",
      warehouse: current.WAREHOUSE ?? "",
      default: [config.database, config.schema].filter(Boolean).join(".") || "(none)",
    },
    databases: databases.rows.map((row) => ({ name: row.name })),
    help: [
      "Run `snowflake-axi tables [db[.schema]]` to list tables with row counts",
      'Run `snowflake-axi query "SELECT ..."` to run read-only SQL',
      ...pluginHelp,
    ],
  };
}

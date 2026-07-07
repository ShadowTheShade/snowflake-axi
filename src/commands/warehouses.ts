import { parseFlags } from "../flags.js";
import { cellValue } from "../format.js";
import { loadConfig } from "../config.js";
import { runQuery } from "../snowflake.js";
import type { CommandSpec } from "../command.js";

const COMMENT_LIMIT = 100;

async function creditsBy7d(): Promise<Map<string, number> | undefined> {
  const config = loadConfig();
  if (!config.database) return undefined;
  try {
    const { rows } = await runQuery(
      `SELECT WAREHOUSE_NAME, SUM(CREDITS_USED) AS CREDITS
       FROM TABLE(${config.database}.INFORMATION_SCHEMA.WAREHOUSE_METERING_HISTORY(
         DATEADD('day', -7, CURRENT_TIMESTAMP()), CURRENT_TIMESTAMP()))
       GROUP BY 1`,
    );
    if (rows.length === 0) return undefined;
    return new Map(rows.map((row) => [String(row.WAREHOUSE_NAME), Number(Number(row.CREDITS).toFixed(1))]));
  } catch {
    return undefined;
  }
}

async function run(args: string[]): Promise<Record<string, unknown>> {
  parseFlags("warehouses", args, {});
  const [show, credits] = await Promise.all([runQuery("SHOW WAREHOUSES"), creditsBy7d()]);

  if (show.rows.length === 0) {
    return { count: "0 warehouses visible to this role" };
  }
  return {
    count: `${show.rows.length} warehouses`,
    ...(credits === undefined ? { note: "credits_7d omitted: no metering history visible to this role" } : {}),
    warehouses: show.rows.map((row) => ({
      name: row.name,
      size: row.size,
      state: row.state,
      ...(credits === undefined ? {} : { credits_7d: credits.get(String(row.name)) ?? 0 }),
      comment: cellValue(row.comment, COMMENT_LIMIT).value,
    })),
  };
}

export const warehousesCommand: CommandSpec = {
  summary: "Warehouses with state and 7-day credit burn",
  help: `command: warehouses
description: List warehouses with size, state, 7-day credit usage, and usage-guidance comments
usage: snowflake-axi warehouses
notes:
  credits_7d comes from INFORMATION_SCHEMA.WAREHOUSE_METERING_HISTORY; if the role
  lacks MONITOR the column is omitted with a note instead of failing.
examples:
  snowflake-axi warehouses
`,
  run,
};

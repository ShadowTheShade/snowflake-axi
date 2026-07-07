import { type CommandArgs, defineCommand } from "../command.js";
import { cellValue } from "../format.js";
import { runQuery } from "../snowflake.js";

const COMMENT_LIMIT = 100;

type Metering = { credits: Map<string, number> } | { note: string };

async function creditsBy7d(): Promise<Metering> {
  try {
    const { rows } = await runQuery(
      `SELECT WAREHOUSE_NAME, SUM(CREDITS_USED) AS CREDITS
       FROM TABLE(SNOWFLAKE.INFORMATION_SCHEMA.WAREHOUSE_METERING_HISTORY(
         DATEADD('day', -7, CURRENT_TIMESTAMP()), CURRENT_TIMESTAMP()))
       GROUP BY 1`,
    );
    if (rows.length === 0) {
      return {
        note: "credits_7d omitted: no metering rows in the last 7 days (idle warehouses, or the role lacks MONITOR)",
      };
    }
    return {
      credits: new Map(rows.map((row) => [String(row.WAREHOUSE_NAME), Number(Number(row.CREDITS).toFixed(1))])),
    };
  } catch {
    return { note: "credits_7d omitted: the metering lookup failed for this role" };
  }
}

async function run(args: CommandArgs): Promise<Record<string, unknown>> {
  const full = args.bool("--full");
  const [show, metering] = await Promise.all([runQuery("SHOW WAREHOUSES"), creditsBy7d()]);

  if (show.rows.length === 0) {
    return { count: "0 warehouses visible to this role" };
  }
  let truncatedComments = 0;
  const warehouses = show.rows.map((row) => {
    const comment = cellValue(row.comment, full ? null : COMMENT_LIMIT);
    if (comment.truncated) truncatedComments++;
    return {
      name: row.name,
      size: row.size,
      state: row.state,
      ...("credits" in metering ? { credits_7d: metering.credits.get(String(row.name)) ?? 0 } : {}),
      comment: comment.value,
    };
  });
  return {
    count: `${show.rows.length} warehouses`,
    ...("note" in metering ? { note: metering.note } : {}),
    warehouses,
    ...(truncatedComments > 0
      ? { help: [`${truncatedComments} comment(s) truncated at ${COMMENT_LIMIT} chars; rerun with --full`] }
      : {}),
  };
}

export const warehousesCommand = defineCommand("warehouses", {
  summary: "Warehouses with state and 7-day credit burn",
  action: {
    description: "List warehouses with size, state, 7-day credit usage, and usage-guidance comments",
    flags: {
      "--full": { type: "boolean", description: `disable ${COMMENT_LIMIT}-char comment truncation` },
    },
    notes: [
      "credits_7d comes from INFORMATION_SCHEMA.WAREHOUSE_METERING_HISTORY and needs a",
      "default database; when unavailable (no SNOWFLAKE_DATABASE, or the role lacks",
      "MONITOR) the column is omitted with a note instead of failing.",
    ],
    examples: ["snowflake-axi warehouses"],
    run,
  },
});

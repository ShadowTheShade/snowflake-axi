import { AxiError } from "axi-sdk-js";
import { type CommandArgs, defineCommand } from "../command.js";
import { CELL_LIMIT, presentRows } from "../present.js";
import { runQuery } from "../snowflake.js";
import { assertReadOnly } from "../validate.js";

async function run(args: CommandArgs): Promise<Record<string, unknown>> {
  const limit = args.int("--limit");
  const timeout = args.int("--timeout");
  const full = args.bool("--full");

  const rawSql = args.positionals.join(" ").trim();
  if (!rawSql) {
    throw new AxiError("No SQL provided", "VALIDATION_ERROR", ['Run `snowflake-axi query "SELECT ..."`']);
  }
  const { sql } = assertReadOnly(rawSql);

  const started = Date.now();
  const result = await runQuery(sql, {
    maxRows: limit,
    timeoutSeconds: timeout,
    warehouse: args.str("--warehouse"),
    role: args.str("--role"),
  });
  const elapsed = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  return { ...presentRows(result, full), elapsed };
}

export const queryCommand = defineCommand("query", {
  summary: "Run read-only SQL (SELECT/WITH/SHOW/DESC/EXPLAIN)",
  action: {
    description: "Run one read-only SQL statement; write statements are rejected with the SQL handed back",
    positionals: { usage: '"<sql>"', min: 0, max: Number.POSITIVE_INFINITY },
    flags: {
      "--limit": {
        type: "int",
        placeholder: "<n>",
        description: "max rows fetched; total count is always reported",
        default: 50,
        min: 1,
        max: 1000,
      },
      "--full": { type: "boolean", description: `disable ${CELL_LIMIT}-char cell truncation` },
      "--timeout": {
        type: "int",
        placeholder: "<s>",
        description: "statement timeout in seconds",
        default: 60,
        min: 1,
        max: 3600,
      },
      "--warehouse": {
        type: "string",
        placeholder: "<name>",
        description: "run this statement on a specific warehouse instead of the user's default",
      },
      "--role": {
        type: "string",
        placeholder: "<name>",
        description: "run this statement as another role granted to the user, instead of the default role",
      },
    },
    notes: [
      "Unqualified table names resolve against the session's default namespace.",
      "Allowed statement heads: SELECT, WITH, SHOW, DESC, DESCRIBE, EXPLAIN.",
      "Long statements print their handle to stderr; `snowflake-axi result <handle>` collects the output later.",
    ],
    examples: [
      'snowflake-axi query "SELECT COUNT(*) FROM FCT_ORDERS"',
      'snowflake-axi query "SHOW SCHEMAS IN DATABASE SCOOPS_DB"',
      "snowflake-axi query \"SELECT * FROM DIM_CUSTOMERS WHERE REGION = 'EMEA'\" --limit 100",
    ],
    run,
  },
});

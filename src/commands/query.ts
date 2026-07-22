import { AxiError } from "axi-sdk-js";
import { type CommandArgs, defineCommand } from "../command.js";
import { startTimer } from "../format.js";
import { requireGrant } from "../grants.js";
import { CELL_LIMIT, presentRows, presentWrite } from "../present.js";
import { runQuery } from "../snowflake.js";
import { classifyStatement } from "../validate.js";

// A COPY into/from a stage on a large fact routinely runs minutes, and other
// writes outlast a read; when --timeout is not given, pick a default matched to
// the statement instead of the 60s read default so big unloads don't fail.
const READ_TIMEOUT = 60;
const WRITE_TIMEOUT = 300;
const COPY_TIMEOUT = 900;

function timeoutProvided(raw: string[]): boolean {
  return raw.some((arg) => arg === "--timeout" || arg.startsWith("--timeout="));
}

function defaultTimeout(kind: string, sql: string): number {
  if (kind !== "write") return READ_TIMEOUT;
  return /^\s*COPY\b/i.test(sql) ? COPY_TIMEOUT : WRITE_TIMEOUT;
}

async function run(args: CommandArgs): Promise<Record<string, unknown>> {
  const limit = args.int("--limit");
  const full = args.bool("--full");

  const rawSql = args.positionals.join(" ").trim();
  if (!rawSql) {
    throw new AxiError("No SQL provided", "VALIDATION_ERROR", ['Run `snowflake-axi query "SELECT ..."`']);
  }
  const { sql, kind } = classifyStatement(rawSql);
  if (kind === "write") requireGrant("sql.write");

  const timeout = timeoutProvided(args.raw) ? args.int("--timeout") : defaultTimeout(kind, sql);

  const elapsed = startTimer();
  const result = await runQuery(sql, {
    maxRows: limit,
    timeoutSeconds: timeout,
    warehouse: args.str("--warehouse"),
    role: args.str("--role"),
  });
  const presented = kind === "write" ? presentWrite(result, full) : presentRows(result, full);
  return { ...presented, elapsed: elapsed() };
}

export const queryCommand = defineCommand("query", {
  summary: "Run one SQL statement; reads are free, writes need the sql.write grant",
  action: {
    description:
      "Run one Snowflake SQL statement over the SQL API. Reads run for free; a write (anything that is not SELECT/WITH/SHOW/DESC/EXPLAIN) is refused until the user grants sql.write",
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
        description:
          "statement timeout in seconds; when omitted, defaults to 60 for reads, 300 for writes, 900 for a COPY",
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
      "Reads (SELECT, WITH, SHOW, DESC, DESCRIBE, EXPLAIN) need no grant; any other statement is a write.",
      "Writes are refused with WRITE_NOT_ALLOWED until the user grants sql.write (see `snowflake-axi allow --help`); the role stays the hard boundary on what can change.",
      "Single statement only. A write reports Snowflake's count/status row; long statements print a handle to stderr for `snowflake-axi result <handle>`.",
      "The timeout default adapts when --timeout is omitted: 60s for reads, 300s for writes, 900s for a COPY (large unloads still may need a higher --timeout).",
    ],
    examples: [
      'snowflake-axi query "SELECT COUNT(*) FROM FCT_ORDERS"',
      'snowflake-axi query "SHOW SCHEMAS IN DATABASE SCOOPS_DB"',
      "snowflake-axi query \"UPDATE FCT_ORDERS SET STATUS = 'SHIPPED' WHERE ID = 42\"",
    ],
    run,
  },
});

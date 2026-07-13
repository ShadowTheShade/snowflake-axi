import { AxiError } from "axi-sdk-js";
import { type CommandArgs, defineCommand } from "../command.js";
import { requireGrant } from "../grants.js";
import { CELL_LIMIT, presentWrite } from "../present.js";
import { runQuery } from "../snowflake.js";
import { assertWrite } from "../validate.js";

async function run(args: CommandArgs): Promise<Record<string, unknown>> {
  requireGrant("sql.write");
  const limit = args.int("--limit");
  const timeout = args.int("--timeout");
  const full = args.bool("--full");

  const rawSql = args.positionals.join(" ").trim();
  if (!rawSql) {
    throw new AxiError("No SQL provided", "VALIDATION_ERROR", ['Run `snowflake-axi exec "UPDATE ..."`']);
  }
  const { sql } = assertWrite(rawSql);

  const started = Date.now();
  const result = await runQuery(sql, {
    maxRows: limit,
    timeoutSeconds: timeout,
    warehouse: args.str("--warehouse"),
    role: args.str("--role"),
  });
  const elapsed = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  return { ...presentWrite(result, full), elapsed };
}

export const execCommand = defineCommand("exec", {
  summary: "Run one write SQL statement (DML/DDL/COPY/CALL); needs the sql.write grant",
  action: {
    description: "Run one write statement over the Snowflake SQL API; refused until the user grants sql.write",
    positionals: { usage: '"<sql>"', min: 0, max: Number.POSITIVE_INFINITY },
    flags: {
      "--limit": {
        type: "int",
        placeholder: "<n>",
        description: "max result rows fetched (COPY/CALL can return many); count is always reported",
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
      "Refused with WRITE_NOT_ALLOWED until the user grants sql.write (see `snowflake-axi allow --help`).",
      "Allowed statement heads: INSERT, UPDATE, DELETE, MERGE, TRUNCATE, CREATE, ALTER, DROP, UNDROP, COPY, CALL; single statement only.",
      "Reads go through `snowflake-axi query`; EXECUTE IMMEDIATE and other dynamic-SQL forms are handed to the operator.",
      "What the token's role is granted to do remains the hard boundary on what can actually change.",
    ],
    examples: [
      "snowflake-axi exec \"UPDATE FCT_ORDERS SET STATUS = 'SHIPPED' WHERE ID = 42\"",
      'snowflake-axi exec "CREATE TABLE MY_DB.MY_SCHEMA.T (A INT)"',
      'snowflake-axi exec "COPY INTO STAGED_ORDERS FROM @MY_STAGE" --role LOADER',
    ],
    run,
  },
});

import { AxiError } from "axi-sdk-js";
import { type CommandArgs, defineCommand } from "../command.js";
import { CELL_LIMIT, presentRows } from "../present.js";
import { fetchStatementResult } from "../snowflake.js";

const HANDLE = /^[0-9a-fA-F-]{16,64}$/;

async function run(args: CommandArgs): Promise<Record<string, unknown>> {
  const handle = args.positionals[0];
  if (!HANDLE.test(handle)) {
    throw new AxiError(`Invalid statement handle '${handle}'`, "VALIDATION_ERROR", [
      "Use the handle a long-running query printed to stderr, e.g. 01b66701-0000-23c5-0000-45a100012345",
    ]);
  }
  const limit = args.int("--limit");
  const full = args.bool("--full");

  const result = await fetchStatementResult(handle, { maxRows: limit });
  if ("running" in result) {
    return {
      status: "still running",
      handle,
      help: [`Rerun \`snowflake-axi result ${handle}\` once the statement finishes`],
    };
  }
  return { handle, ...presentRows(result, full) };
}

export const resultCommand = defineCommand("result", {
  summary: "Collect the output of an earlier statement by handle",
  action: {
    description: "Fetch the result of a previously submitted statement without re-running it",
    positionals: { usage: "<handle>", min: 1, max: 1 },
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
    },
    notes: [
      "Queries that outlive their invocation print their handle to stderr; results stay collectable for about 24 hours.",
      "Handles are only visible to the user that submitted the statement.",
    ],
    examples: ["snowflake-axi result 01b66701-0000-23c5-0000-45a100012345"],
    run,
  },
});

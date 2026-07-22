import { AxiError } from "axi-sdk-js";
import { type CommandArgs, defineCommand } from "../command.js";
import { loadConfig } from "../config.js";
import { humanBytes, shapeRows, truncationHint } from "../format.js";
import { CELL_LIMIT } from "../present.js";
import { runQuery } from "../snowflake.js";

const STAGE_PATH = /^@[A-Za-z0-9_$.~/-]+$/;
const FILE_FORMAT = /^[A-Za-z_][A-Za-z0-9_$.]*$/;

function assertStagePath(raw: string, usage: string): string {
  if (!STAGE_PATH.test(raw)) {
    throw new AxiError(`Invalid stage path '${raw}'`, "VALIDATION_ERROR", [usage]);
  }
  return raw;
}

async function list(args: CommandArgs): Promise<Record<string, unknown>> {
  const path = assertStagePath(args.positionals[0], "Run `snowflake-axi stage @db.schema.stage[/prefix]`");
  const limit = args.int("--limit");

  const { rows } = await runQuery(`LIST ${path}`);
  if (rows.length === 0) {
    return { stage: path, count: `0 files under ${path}` };
  }
  const totalBytes = rows.reduce((sum, row) => sum + Number(row.size ?? 0), 0);
  const shown = rows.slice(0, limit);
  const truncated = shown.length < rows.length;
  const help = [`Run \`snowflake-axi stage read ${path.replace(/\/+$/, "")}/<file> --limit 5\` to peek rows`];
  if (truncated) {
    help.unshift(`Showing ${shown.length} of ${rows.length}; rerun with --limit ${rows.length} for all`);
  }
  // When truncated the count leads with shown-of-total so a skim of `count`
  // never reads the capped `files[]` array as the whole listing.
  const count = truncated
    ? `${shown.length} of ${rows.length} files shown, ${humanBytes(totalBytes)} total`
    : `${rows.length} files, ${humanBytes(totalBytes)} total`;
  return {
    stage: path,
    count,
    files: shown.map((row) => ({
      path: row.name,
      size: humanBytes(Number(row.size ?? 0)),
      modified: row.last_modified,
    })),
    help,
  };
}

async function read(args: CommandArgs): Promise<Record<string, unknown>> {
  const path = assertStagePath(
    args.positionals[0],
    "Run `snowflake-axi stage read @db.schema.stage/path/file --limit 5`",
  );
  const limit = args.int("--limit");
  const full = args.bool("--full");

  const config = loadConfig();
  const format = args.str("--format") ?? config.defaultFileFormat;
  if (!format) {
    throw new AxiError("No named file format available", "VALIDATION_ERROR", [
      "Pass --format <db.schema.format> or set SNOWFLAKE_AXI_DEFAULT_FILE_FORMAT in the env file",
    ]);
  }
  if (!FILE_FORMAT.test(format)) {
    throw new AxiError(`Invalid file format name '${format}'`, "VALIDATION_ERROR", [
      "Use a plain identifier like MY_DB.MY_SCHEMA.MY_PARQUET_FORMAT",
    ]);
  }

  const { rows, numericColumns } = await runQuery(
    `SELECT $1 AS RECORD FROM ${path} (FILE_FORMAT => '${format}') LIMIT ${limit}`,
    { maxRows: limit },
  );
  if (rows.length === 0) {
    return { file: path, format, count: "0 records in file" };
  }
  const { rows: shaped, truncatedCells } = shapeRows(rows, {
    maxCellChars: full ? null : CELL_LIMIT,
    numericColumns,
  });
  return {
    file: path,
    format,
    records: shaped.map((row) => row.RECORD),
    ...(truncatedCells > 0 ? { help: [truncationHint(truncatedCells, CELL_LIMIT, "record")] } : {}),
  };
}

export const stageCommand = defineCommand("stage", {
  summary: "List stage files or peek rows from staged parquet/CSV files",
  description: "List files in a stage, or read records from a staged file via a named file format",
  defaultSubcommand: "list",
  subcommands: {
    list: {
      description: "List files under a stage path",
      positionals: { usage: "@db.schema.stage[/prefix]", min: 1, max: 1 },
      flags: {
        "--limit": {
          type: "int",
          placeholder: "<n>",
          description: "max files shown",
          default: 100,
          min: 1,
          max: 10000,
        },
      },
      examples: ["snowflake-axi stage @SCOOPS_DB.RAW.POS_EXPORTS_STAGE"],
      run: list,
    },
    read: {
      description: "Read records from a staged file via a named file format",
      positionals: { usage: "@db.schema.stage/path/file", min: 1, max: 1 },
      flags: {
        "--limit": { type: "int", placeholder: "<n>", description: "records to fetch", default: 5, min: 1, max: 100 },
        "--format": {
          type: "string",
          placeholder: "<name>",
          description: "named file format (default from SNOWFLAKE_AXI_DEFAULT_FILE_FORMAT)",
        },
        "--full": { type: "boolean", description: `disable ${CELL_LIMIT}-char record truncation` },
      },
      examples: ["snowflake-axi stage read @SCOOPS_DB.RAW.POS_EXPORTS_STAGE/2026/file.parquet --limit 3"],
      run: read,
    },
  },
});

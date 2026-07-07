import { AxiError } from "axi-sdk-js";
import { loadConfig } from "../config.js";
import { intFlag, parseFlags } from "../flags.js";
import { humanBytes, shapeRows } from "../format.js";
import { runQuery } from "../snowflake.js";
import type { CommandSpec } from "../command.js";

const LIST_FLAGS = { "--limit": { takesValue: true } };
const READ_FLAGS = { "--limit": { takesValue: true }, "--format": { takesValue: true }, "--full": { takesValue: false } };

const STAGE_PATH = /^@[A-Za-z0-9_$.~/-]+$/;
const FILE_FORMAT = /^[A-Za-z_][A-Za-z0-9_$.]*$/;
const CELL_LIMIT = 200;

function assertStagePath(positionals: string[], usage: string): string {
  if (positionals.length > 1) {
    throw new AxiError("Expected exactly one stage path", "VALIDATION_ERROR", [usage]);
  }
  const raw = positionals[0];
  if (!raw || !STAGE_PATH.test(raw)) {
    throw new AxiError(`Invalid stage path '${raw ?? ""}'`, "VALIDATION_ERROR", [usage]);
  }
  return raw;
}

async function list(args: string[]): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseFlags("stage", args, LIST_FLAGS);
  const path = assertStagePath(positionals, "Run `snowflake-axi stage @db.schema.stage[/prefix]`");
  const limit = intFlag(flags, "--limit", { fallback: 100, min: 1, max: 10000 });

  const { rows } = await runQuery(`LIST ${path}`);
  if (rows.length === 0) {
    return { stage: path, count: `0 files under ${path}` };
  }
  const totalBytes = rows.reduce((sum, row) => sum + Number(row.size ?? 0), 0);
  const shown = rows.slice(0, limit);
  const help = [`Run \`snowflake-axi stage read ${path.replace(/\/+$/, "")}/<file> --limit 5\` to peek rows`];
  if (shown.length < rows.length) {
    help.unshift(`Showing ${shown.length} of ${rows.length}; rerun with --limit ${rows.length} for all`);
  }
  return {
    stage: path,
    count: `${rows.length} files, ${humanBytes(totalBytes)} total`,
    files: shown.map((row) => ({
      path: row.name,
      size: humanBytes(Number(row.size ?? 0)),
      modified: row.last_modified,
    })),
    help,
  };
}

async function read(args: string[]): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseFlags("stage read", args, READ_FLAGS);
  const path = assertStagePath(positionals, "Run `snowflake-axi stage read @db.schema.stage/path/file --limit 5`");
  const limit = intFlag(flags, "--limit", { fallback: 5, min: 1, max: 100 });
  const full = flags["--full"] === true;

  const config = loadConfig();
  const format = typeof flags["--format"] === "string" ? flags["--format"] : config.defaultFileFormat;
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
    ...(truncatedCells > 0
      ? { help: [`${truncatedCells} record(s) truncated at ${CELL_LIMIT} chars; rerun with --full`] }
      : {}),
  };
}

async function run(args: string[]): Promise<Record<string, unknown>> {
  if (args[0] === "read") {
    return read(args.slice(1));
  }
  return list(args);
}

export const stageCommand: CommandSpec = {
  summary: "List stage files or peek rows from staged parquet/CSV files",
  help: `command: stage
description: List files in a stage, or read records from a staged file via a named file format
usage:
  snowflake-axi stage @db.schema.stage[/prefix] [--limit <n>]
  snowflake-axi stage read @db.schema.stage/path/file [flags]
flags (read):
  --limit <n>: records to fetch (default 5, max 100)
  --format <name>: named file format (default from SNOWFLAKE_AXI_DEFAULT_FILE_FORMAT)
  --full: disable 200-char record truncation
examples:
  snowflake-axi stage @ANALYTICS_DB.RAW.EVENTS_STAGE
  snowflake-axi stage read @ANALYTICS_DB.RAW.EVENTS_STAGE/2026/file.parquet --limit 3
`,
  run,
};

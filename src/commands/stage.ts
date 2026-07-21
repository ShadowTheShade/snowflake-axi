import { AxiError } from "axi-sdk-js";
import { type CommandArgs, defineCommand } from "../command.js";
import { loadConfig } from "../config.js";
import { humanBytes, shapeRows, startTimer, truncationHint } from "../format.js";
import { requireGrant } from "../grants.js";
import { IDENTIFIER } from "../names.js";
import { CELL_LIMIT, presentWrite } from "../present.js";
import { runQuery } from "../snowflake.js";

const STAGE_PATH = /^@[A-Za-z0-9_$.~/-]+$/;
const FILE_FORMAT = /^[A-Za-z_][A-Za-z0-9_$.]*$/;
// COPY into/from a stage on a large fact routinely runs minutes.
const COPY_TIMEOUT = 900;
const UNLOAD_FORMATS = new Set(["parquet", "csv", "json"]);

function assertStagePath(raw: string, usage: string): string {
  if (!STAGE_PATH.test(raw)) {
    throw new AxiError(`Invalid stage path '${raw}'`, "VALIDATION_ERROR", [usage]);
  }
  return raw;
}

/** Validates a `table`, `schema.table`, or `db.schema.table` reference; unqualified names resolve against the session namespace. */
function assertTable(raw: string): string {
  const parts = raw.split(".");
  if (parts.length > 3 || !parts.every((part) => IDENTIFIER.test(part))) {
    throw new AxiError(`Invalid table '${raw}'`, "VALIDATION_ERROR", [
      "Use `table`, `schema.table`, or `db.schema.table` with unquoted identifiers",
    ]);
  }
  return parts.join(".");
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

function copyOptions(args: CommandArgs): { timeoutSeconds: number; warehouse?: string; role?: string } {
  const provided = args.raw.some((arg) => arg === "--timeout" || arg.startsWith("--timeout="));
  return {
    timeoutSeconds: provided ? args.int("--timeout") : COPY_TIMEOUT,
    warehouse: args.str("--warehouse"),
    role: args.str("--role"),
  };
}

async function copy(args: CommandArgs): Promise<Record<string, unknown>> {
  requireGrant("stage.write");
  const usage = "Run `snowflake-axi stage copy @db.schema.src/path @db.schema.dst/path`";
  const src = assertStagePath(args.positionals[0], usage);
  const dst = assertStagePath(args.positionals[1], usage);
  const pattern = args.str("--pattern");
  // PATTERN is a regex string; single quotes are the only SQL-literal hazard.
  const patternClause = pattern === undefined ? "" : ` PATTERN='${pattern.replace(/'/g, "''")}'`;

  const elapsed = startTimer();
  const result = await runQuery(`COPY FILES INTO ${dst} FROM ${src}${patternClause}`, copyOptions(args));
  return { source: src, target: dst, ...presentWrite(result, args.bool("--full")), elapsed: elapsed() };
}

async function unload(args: CommandArgs): Promise<Record<string, unknown>> {
  requireGrant("stage.write");
  const table = assertTable(args.positionals[0]);
  const dst = assertStagePath(args.positionals[1], "Run `snowflake-axi stage unload <table> @db.schema.dst/path`");
  const format = (args.str("--format") ?? "parquet").toLowerCase();
  if (!UNLOAD_FORMATS.has(format)) {
    throw new AxiError(`Invalid --format '${format}'`, "VALIDATION_ERROR", ["Use parquet (default), csv, or json"]);
  }
  const header = args.bool("--header");
  if (header && format !== "csv") {
    throw new AxiError("--header applies to --format csv only", "VALIDATION_ERROR", [
      "Parquet and JSON carry their own schema; drop --header or switch to csv",
    ]);
  }

  const options = [`TYPE = ${format.toUpperCase()}`];
  if (header) options.push("HEADER = TRUE");
  // FILE_FORMAT holds the type/header; the copy options (SINGLE, OVERWRITE,
  // MAX_FILE_SIZE) sit outside it.
  const copyClauses = [`FILE_FORMAT = (${options.join(" ")})`];
  if (args.bool("--single")) copyClauses.push("SINGLE = TRUE");
  if (args.bool("--overwrite")) copyClauses.push("OVERWRITE = TRUE");
  const maxFileSize = args.int("--max-file-size");
  if (maxFileSize > 0) copyClauses.push(`MAX_FILE_SIZE = ${maxFileSize}`);

  const elapsed = startTimer();
  const result = await runQuery(`COPY INTO ${dst} FROM ${table} ${copyClauses.join(" ")}`, copyOptions(args));
  return { table, target: dst, format, ...presentWrite(result, args.bool("--full")), elapsed: elapsed() };
}

const COPY_FLAGS = {
  "--warehouse": {
    type: "string" as const,
    placeholder: "<name>",
    description: "warehouse to run on instead of the user's default (a COPY needs compute)",
  },
  "--role": {
    type: "string" as const,
    placeholder: "<name>",
    description: "run as another role granted to the user",
  },
  "--timeout": {
    type: "int" as const,
    placeholder: "<s>",
    description: "statement timeout in seconds (default 900, matched to large COPY runs)",
    default: COPY_TIMEOUT,
    min: 1,
    max: 14400,
  },
  "--full": { type: "boolean" as const, description: `disable ${CELL_LIMIT}-char cell truncation of the result rows` },
};

export const stageCommand = defineCommand("stage", {
  summary: "List stage files, peek staged records, or copy/unload files (writes via stage.write)",
  description:
    "List files in a stage, read records from a staged file via a named file format, copy files between stages, or unload a table into a stage",
  defaultSubcommand: "list",
  verbHints: {
    put: ["Uploading local files is out of scope; use the snow CLI or Snowsight for PUT"],
    get: ["Downloading stage files is out of scope; use the snow CLI or Snowsight for GET"],
  },
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
    copy: {
      description: "Copy files from one stage path to another (COPY FILES; write, needs the stage.write grant)",
      positionals: { usage: "@src/path @dst/path", min: 2, max: 2 },
      flags: {
        "--pattern": {
          type: "string",
          placeholder: "<regex>",
          description: "copy only files whose path matches this regex (COPY FILES PATTERN)",
        },
        ...COPY_FLAGS,
      },
      notes: [
        "Refused with WRITE_NOT_ALLOWED until the user grants stage.write (see `snowflake-axi allow --help`).",
        "Both arguments are stage paths (@db.schema.stage/prefix); this copies files between stages, it does not upload from local disk.",
      ],
      examples: [
        "snowflake-axi stage copy @DB.S.SRC_STAGE/x/ @DB.S.DST_STAGE/dev/x/",
        "snowflake-axi stage copy @DB.S.SRC_STAGE/ @DB.S.DST_STAGE/ --pattern '.*[.]parquet'",
      ],
      run: copy,
    },
    unload: {
      description: "Unload a table into a stage as files (COPY INTO stage; write, needs the stage.write grant)",
      positionals: { usage: "<table> @dst/path", min: 2, max: 2 },
      flags: {
        "--format": {
          type: "string",
          placeholder: "<fmt>",
          description: "output file format: parquet (default), csv, or json",
        },
        "--single": { type: "boolean", description: "write a single file instead of many (SINGLE = TRUE)" },
        "--header": { type: "boolean", description: "write a header row (csv only; HEADER = TRUE)" },
        "--overwrite": {
          type: "boolean",
          description: "overwrite existing files at the destination (OVERWRITE = TRUE)",
        },
        "--max-file-size": {
          type: "int",
          placeholder: "<bytes>",
          description: "upper bound per output file in bytes (MAX_FILE_SIZE)",
          default: 0,
          min: 0,
          max: 5_000_000_000,
        },
        ...COPY_FLAGS,
      },
      notes: [
        "Refused with WRITE_NOT_ALLOWED until the user grants stage.write (see `snowflake-axi allow --help`).",
        "Parquet is SNAPPY-compressed by default; --header applies to csv only. Without --overwrite an existing file at the destination fails the COPY.",
        "The table resolves as table, schema.table, or db.schema.table; a COPY needs compute, so pass --warehouse if the user has no default.",
      ],
      examples: [
        "snowflake-axi stage unload FCT_ORDERS @DB.S.EXPORTS/orders/ --single --overwrite",
        "snowflake-axi stage unload DB.S.FCT_ORDERS @DB.S.EXPORTS/orders/ --format csv --header",
      ],
      run: unload,
    },
  },
});

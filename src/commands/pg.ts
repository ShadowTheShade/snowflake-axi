import { AxiError } from "axi-sdk-js";
import { type CommandArgs, defineCommand } from "../command.js";
import { loadPgConfig } from "../config.js";
import { humanBytes, shapeRows } from "../format.js";
import { requireGrant } from "../grants.js";
import { IDENTIFIER, likePattern } from "../names.js";
import { type PgQueryResult, type PgWriteResult, runPgQuery, runPgWrite } from "../pg.js";
import { CELL_LIMIT } from "../present.js";
import { assertPgReadOnly, classifyPgStatement } from "../validate.js";

const KIND_LABELS: Record<string, string> = { r: "TABLE", p: "TABLE", v: "VIEW", m: "MATVIEW" };

// System schemas: information_schema plus everything pg-prefixed
// (pg_catalog, pg_toast, pg_temp_*). The backslash keeps the underscore
// literal in LIKE.
const USER_SCHEMAS = `n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'`;

function connectionLabel(): string {
  const config = loadPgConfig();
  return `${config.user}@${config.host}:${config.port}/${config.database} (read-only)`;
}

/** Shapes rows the way `pg query` reports them: definitive completeness, cell truncation, follow-up hints. */
function presentPgRows(result: PgQueryResult, full: boolean, limit: number): Record<string, unknown> {
  if (result.complete && result.rows.length === 0) {
    return { count: "0 rows" };
  }
  const { rows: shaped, truncatedCells } = shapeRows(result.rows, {
    maxCellChars: full ? null : CELL_LIMIT,
    numericColumns: result.numericColumns,
  });
  const help: string[] = [];
  if (!result.complete) {
    help.push(`Rerun with --limit ${Math.min(limit * 10, 1000)} for more, or run a COUNT(*) query for the total`);
  }
  if (truncatedCells > 0) {
    help.push(`${truncatedCells} cell(s) truncated at ${CELL_LIMIT} chars; rerun with --full`);
  }
  const count = result.complete ? `${result.rows.length} (complete)` : `first ${result.rows.length} rows (more exist)`;
  return { count, rows: shaped, ...(help.length > 0 ? { help } : {}) };
}

interface PgTableName {
  schema?: string;
  table: string;
}

/** Parses `table` or `schema.table`; matching against the catalog is case-insensitive. */
function parsePgName(raw: string | undefined): PgTableName {
  const parts = (raw ?? "").split(".");
  if (raw === undefined || parts.length > 2 || !parts.every((p) => IDENTIFIER.test(p))) {
    throw new AxiError(`Invalid table name '${raw ?? ""}'`, "VALIDATION_ERROR", [
      "Use `table` or `schema.table` with unquoted identifiers",
    ]);
  }
  return parts.length === 2 ? { schema: parts[0], table: parts[1] } : { table: parts[0] };
}

const LOOKUP_FIELDS = `n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
       c.reltuples::bigint AS est_rows, pg_total_relation_size(c.oid) AS bytes`;
const LOOKUP_FROM = `FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace`;
const LOOKUP_WHERE = `c.relkind IN ('r','p','v','m') AND NOT c.relispartition AND ${USER_SCHEMAS}`;

/** Finds the one relation a name refers to; ambiguity and misses fail loud with the candidates. */
async function resolvePgTable(raw: string, extraFields = ""): Promise<Record<string, unknown>> {
  const name = parsePgName(raw);
  const binds: unknown[] = [name.table];
  let filter = "lower(c.relname) = lower($1)";
  if (name.schema !== undefined) {
    filter += " AND lower(n.nspname) = lower($2)";
    binds.push(name.schema);
  }
  const { rows } = await runPgQuery(
    `SELECT ${LOOKUP_FIELDS}${extraFields} ${LOOKUP_FROM} WHERE ${LOOKUP_WHERE} AND ${filter} ORDER BY 1`,
    { binds },
  );
  if (rows.length === 0) {
    throw new AxiError(`Table '${raw}' not found`, "PG_ERROR", [
      `Run \`snowflake-axi pg tables --like ${name.table}\` to find the right table`,
    ]);
  }
  if (rows.length > 1) {
    const candidates = rows.map((row) => `${row.schema}.${row.name}`).join(", ");
    throw new AxiError(`Table name '${raw}' is ambiguous: ${candidates}`, "VALIDATION_ERROR", [
      "Qualify it as schema.table",
    ]);
  }
  return rows[0];
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function estRowsCell(value: unknown): number | string {
  const n = Number(value);
  // reltuples is -1 until the first ANALYZE/VACUUM touches the table.
  return n < 0 ? "" : n;
}

async function runTables(args: CommandArgs): Promise<Record<string, unknown>> {
  const schema = args.positionals[0];
  if (schema !== undefined && !IDENTIFIER.test(schema)) {
    throw new AxiError(`Invalid schema '${schema}'`, "VALIDATION_ERROR", ["Use an unquoted identifier"]);
  }
  const like = args.str("--like");
  const limit = args.int("--limit");
  const includeViews = args.bool("--views");

  const binds: unknown[] = [];
  let filter = "";
  if (schema !== undefined) {
    binds.push(schema);
    filter += ` AND lower(n.nspname) = lower($${binds.length})`;
  }
  if (like !== undefined) {
    binds.push(likePattern(like));
    filter += ` AND c.relname ILIKE $${binds.length}`;
  }
  const { rows } = await runPgQuery(
    `SELECT ${LOOKUP_FIELDS} ${LOOKUP_FROM}
     WHERE ${LOOKUP_WHERE}${filter}
     ORDER BY pg_total_relation_size(c.oid) DESC, 1, 2`,
    { binds },
  );

  const scopeLabel = schema === undefined ? loadPgConfig().database : `${loadPgConfig().database}.${schema}`;
  const matchLabel = like !== undefined ? ` matching '${likePattern(like)}'` : "";
  const views = rows.filter((row) => row.kind === "v" || row.kind === "m");
  const listed = includeViews ? rows : rows.filter((row) => row.kind !== "v" && row.kind !== "m");

  if (listed.length === 0) {
    const viewNote = !includeViews && views.length > 0 ? ` (${views.length} views excluded; use --views)` : "";
    return {
      connection: connectionLabel(),
      count: `0 tables${matchLabel} in ${scopeLabel}${viewNote}`,
    };
  }

  const shown = listed.slice(0, limit);
  const viewNote = includeViews ? "" : views.length > 0 ? ` (${views.length} views excluded; use --views)` : "";
  const help = [
    "Run `snowflake-axi pg schema <table>` for columns",
    'Run `snowflake-axi pg query "SELECT ..."` to aggregate or filter',
  ];
  if (shown.length < listed.length) {
    help.unshift(
      `Run \`snowflake-axi pg tables${schema ? ` ${schema}` : ""} --limit ${listed.length}\` for all ${listed.length}`,
    );
  }
  return {
    connection: connectionLabel(),
    count: `${listed.length} tables${matchLabel} in ${scopeLabel}, largest first (rows are planner estimates)${viewNote}`,
    tables: shown.map((row) => ({
      ...(schema === undefined ? { schema: row.schema } : {}),
      name: row.name,
      ...(includeViews ? { kind: KIND_LABELS[String(row.kind)] ?? row.kind } : {}),
      rows: estRowsCell(row.est_rows),
      size: humanBytes(Number(row.bytes)),
    })),
    help,
  };
}

const SCHEMA_DETAILS = `,
       (SELECT json_agg(json_build_object(
                 'name', a.attname,
                 'type', format_type(a.atttypid, a.atttypmod),
                 'null', CASE WHEN a.attnotnull THEN 'N' ELSE 'Y' END,
                 'default', pg_get_expr(d.adbin, d.adrelid)) ORDER BY a.attnum)
          FROM pg_attribute a
          LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
       (SELECT json_agg(a.attname ORDER BY x.ord)
          FROM pg_index i
          CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS x(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = x.attnum
         WHERE i.indrelid = c.oid AND i.indisprimary) AS pk`;

async function runSchema(args: CommandArgs): Promise<Record<string, unknown>> {
  const raw = args.positionals[0];
  const row = await resolvePgTable(raw, SCHEMA_DETAILS);
  const columns = (row.columns ?? []) as { name: string; type: string; null: string; default: string | null }[];
  const pk = row.pk as string[] | null;
  const qualified = `${row.schema}.${row.name}`;
  return {
    table: qualified,
    kind: KIND_LABELS[String(row.kind)] ?? row.kind,
    rows: estRowsCell(row.est_rows),
    size: humanBytes(Number(row.bytes)),
    ...(pk && pk.length > 0 ? { pk: pk.join(", ") } : {}),
    columns: columns.map((column) => ({
      name: column.name,
      type: column.type,
      null: column.null,
      default: column.default ?? "",
    })),
    help: [`Run \`snowflake-axi pg sample ${qualified} --fields <a,b>\` to preview data`],
  };
}

async function runSample(args: CommandArgs): Promise<Record<string, unknown>> {
  const limit = args.int("--limit");
  const full = args.bool("--full");

  let select = "*";
  const fields = args.str("--fields");
  if (fields !== undefined) {
    const list = fields.split(",").map((f) => f.trim().toLowerCase());
    const bad = list.filter((f) => !IDENTIFIER.test(f));
    if (list.length === 0 || bad.length > 0) {
      throw new AxiError(`Invalid --fields value${bad.length ? ` '${bad[0]}'` : ""}`, "VALIDATION_ERROR", [
        "Use a comma-separated list of column names: --fields created_at,status",
      ]);
    }
    select = list.join(", ");
  }

  const row = await resolvePgTable(args.positionals[0]);
  const qualified = `${row.schema}.${row.name}`;
  const where = args.str("--where");
  const whereClause = where === undefined ? "" : ` WHERE ${where}`;

  const sql = `SELECT ${select} FROM ${quoteIdent(String(row.schema))}.${quoteIdent(String(row.name))}${whereClause} LIMIT ${limit}`;
  assertPgReadOnly(sql);
  const result = await runPgQuery(sql, { maxRows: limit });

  if (result.rows.length === 0) {
    const scope = whereClause ? ` matching --where in ${qualified}` : ` in ${qualified}`;
    return { table: qualified, count: `0 rows${scope}` };
  }

  const { rows: shaped, truncatedCells } = shapeRows(result.rows, {
    maxCellChars: full ? null : CELL_LIMIT,
    numericColumns: result.numericColumns,
  });
  return {
    table: qualified,
    rows: shaped,
    ...(truncatedCells > 0
      ? { help: [`${truncatedCells} cell(s) truncated at ${CELL_LIMIT} chars; rerun with --full`] }
      : {}),
  };
}

/** Shapes a write result: the command tag, its affected count, any RETURNING rows. */
function presentPgWrite(result: PgWriteResult, full: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { command: result.command };
  if (result.rowCount !== null) out.affected = result.rowCount;
  if (result.rows.length > 0) {
    const { rows, truncatedCells } = shapeRows(result.rows, {
      maxCellChars: full ? null : CELL_LIMIT,
      numericColumns: result.numericColumns,
    });
    out.returned = rows;
    if (truncatedCells > 0) {
      out.help = [`${truncatedCells} cell(s) truncated at ${CELL_LIMIT} chars; rerun with --full`];
    }
  }
  return out;
}

async function runQueryVerb(args: CommandArgs): Promise<Record<string, unknown>> {
  const limit = args.int("--limit");
  const timeout = args.int("--timeout");
  const full = args.bool("--full");

  const rawSql = args.positionals.join(" ").trim();
  if (!rawSql) {
    throw new AxiError("No SQL provided", "VALIDATION_ERROR", ['Run `snowflake-axi pg query "SELECT ..."`']);
  }
  const { sql, kind } = classifyPgStatement(rawSql);

  const started = Date.now();
  if (kind === "read") {
    const result = await runPgQuery(sql, { maxRows: limit, timeoutSeconds: timeout });
    const elapsed = `${((Date.now() - started) / 1000).toFixed(1)}s`;
    return { ...presentPgRows(result, full, limit), elapsed };
  }
  requireGrant("pg.write");
  const result = await runPgWrite(sql, { timeoutSeconds: timeout });
  const elapsed = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  return { ...presentPgWrite(result, full), elapsed };
}

const WRITE_HINT = ['Run `snowflake-axi pg query "<sql>"`; a write runs once the user grants pg.write'];

export const pgCommand = defineCommand("pg", {
  summary: "Snowflake Postgres: tables, columns, samples, and SQL (reads free, writes via pg.write)",
  description:
    "Snowflake Postgres explorer over a direct wire connection: reads run for free, writes go through `pg query` behind the pg.write grant",
  defaultSubcommand: "tables",
  verbHints: {
    find: ["Run `snowflake-axi pg tables --like <name>` to search tables by name"],
    describe: ["Run `snowflake-axi pg schema <table>` for columns"],
    desc: ["Run `snowflake-axi pg schema <table>` for columns"],
    databases: [
      "The connection is pinned to one database (SNOWFLAKE_AXI_PG_DATABASE)",
      'Run `snowflake-axi pg query "SELECT datname FROM pg_database WHERE NOT datistemplate"` to list them',
    ],
    exec: WRITE_HINT,
    execute: WRITE_HINT,
    insert: WRITE_HINT,
    update: WRITE_HINT,
    delete: WRITE_HINT,
    merge: WRITE_HINT,
    create: WRITE_HINT,
    alter: WRITE_HINT,
    drop: WRITE_HINT,
    truncate: WRITE_HINT,
  },
  subcommands: {
    tables: {
      description: "List tables largest first with estimated rows and size; default scope is every user schema",
      positionals: { usage: "[schema]", min: 0, max: 1 },
      flags: {
        "--like": {
          type: "string",
          placeholder: "<pattern>",
          description: "filter tables by name, case-insensitive; bare words match as contains",
        },
        "--views": { type: "boolean", description: "include views and materialized views, adds a kind column" },
        "--limit": { type: "int", placeholder: "<n>", description: "max rows shown", default: 100, min: 1, max: 10000 },
      },
      notes: [
        "Row counts are planner estimates (reltuples); blank means the table was never analyzed.",
        "System schemas (pg_catalog, information_schema) are always excluded.",
      ],
      examples: ["snowflake-axi pg", "snowflake-axi pg tables public --like orders"],
      run: runTables,
    },
    schema: {
      description: "Columns with types, nullability, and defaults, plus primary key and size",
      positionals: { usage: "<table>", min: 1, max: 1 },
      notes: ["Names resolve as table or schema.table, case-insensitive; ambiguous names list the candidates."],
      examples: ["snowflake-axi pg schema orders", "snowflake-axi pg schema app.users"],
      run: runSchema,
    },
    sample: {
      description: "Preview rows from a table or view",
      positionals: { usage: "<table>", min: 1, max: 1 },
      flags: {
        "--limit": { type: "int", placeholder: "<n>", description: "rows to fetch", default: 5, min: 1, max: 100 },
        "--fields": { type: "string", placeholder: "<a,b,c>", description: "columns to select (default all)" },
        "--where": { type: "string", placeholder: '"<predicate>"', description: "SQL predicate to filter by" },
        "--full": { type: "boolean", description: `disable ${CELL_LIMIT}-char cell truncation` },
      },
      examples: [
        "snowflake-axi pg sample orders --limit 3 --fields id,status,created_at",
        "snowflake-axi pg sample app.users --where \"status = 'active'\"",
      ],
      run: runSample,
    },
    query: {
      description: "Run one SQL statement; reads run for free, a write needs the pg.write grant",
      positionals: { usage: '"<sql>"', min: 0, max: Number.POSITIVE_INFINITY },
      flags: {
        "--limit": {
          type: "int",
          placeholder: "<n>",
          description: "max rows fetched on a read; completeness is always reported",
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
      },
      notes: [
        "Reads (SELECT, WITH, TABLE, VALUES, SHOW, EXPLAIN) run on a server read-only session and need no grant.",
        "Any other statement is a write: refused with WRITE_NOT_ALLOWED until the user grants pg.write, then run on a read-write session that reports the command tag, `affected` count, and any RETURNING rows.",
        "Single statement only; the Postgres role's own privileges stay the hard boundary.",
      ],
      examples: [
        'snowflake-axi pg query "SELECT count(*) FROM orders"',
        "snowflake-axi pg query \"UPDATE orders SET status = 'shipped' WHERE id = 42\"",
        'snowflake-axi pg query "ANALYZE interco.interco_ar_ap_doc"',
      ],
      run: runQueryVerb,
    },
  },
});

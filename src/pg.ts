import { AxiError } from "axi-sdk-js";
import pg from "pg";
import Cursor from "pg-cursor";
import { loadPgConfig } from "./config.js";

export interface PgQueryResult {
  rows: Record<string, unknown>[];
  /** True when the result set ended within maxRows, making rows.length the exact total. */
  complete: boolean;
  numericColumns: Set<string>;
}

export interface PgQueryOptions {
  binds?: unknown[];
  maxRows?: number;
  timeoutSeconds?: number;
  /** One-off database override; defaults to SNOWFLAKE_AXI_PG_DATABASE. */
  database?: string;
}

export interface PgWriteResult {
  /** Server command tag word: INSERT, UPDATE, DELETE, MERGE, CREATE, DROP, ... */
  command: string;
  /** Rows the statement touched; null for DDL, which reports no count. */
  rowCount: number | null;
  /** RETURNING payload, empty unless the statement had a RETURNING clause. */
  rows: Record<string, unknown>[];
  numericColumns: Set<string>;
}

export interface PgWriteOptions {
  binds?: unknown[];
  timeoutSeconds?: number;
  /** One-off database override; defaults to SNOWFLAKE_AXI_PG_DATABASE. */
  database?: string;
}

const DEFAULT_TIMEOUT_S = 60;
const CONNECT_TIMEOUT_MS = 15_000;
const CHUNK = 500;
const NUMERIC_OIDS = new Set([20, 21, 23, 26, 700, 701, 1700]);

// Temporal values pass through as the server's text form; parsing them into
// JS Date objects would re-render them in the local timezone.
for (const oid of [1082, 1083, 1114, 1184, 1266, 1186]) {
  pg.types.setTypeParser(oid, (value) => value);
}

function clientConfig(timeoutSeconds: number, readOnly = true, database?: string): pg.ClientConfig {
  const config = loadPgConfig();
  return {
    host: config.host,
    port: config.port,
    database: database ?? config.database,
    user: config.user,
    password: config.password,
    ssl: config.sslmode === "disable" ? false : config.sslmode === "verify-full" ? true : { rejectUnauthorized: false },
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    application_name: "snowflake-axi",
    // The read/write mode is set in the startup packet, before any statement
    // runs; single-statement-per-call means nothing can flip it back in-session.
    // Reads pin default_transaction_read_only=on so DML cannot slip through even
    // if the head check is somehow evaded; writes (pg.write grant) pin it off.
    options: `-c default_transaction_read_only=${readOnly ? "on" : "off"} -c statement_timeout=${timeoutSeconds * 1000}`,
  };
}

/**
 * Executes one statement against Snowflake Postgres on a fresh connection.
 * The cursor (extended protocol) reads at most maxRows plus a one-row probe,
 * so results are never buffered wholesale and completeness is definitive;
 * the extended protocol also makes multi-statement SQL a server-side error.
 */
export async function runPgQuery(sql: string, options: PgQueryOptions = {}): Promise<PgQueryResult> {
  const client = new pg.Client(clientConfig(options.timeoutSeconds ?? DEFAULT_TIMEOUT_S, true, options.database));
  try {
    await client.connect();
  } catch (err) {
    await client.end().catch(() => {});
    throw translatePgError(err);
  }
  try {
    const cursor = client.query(new Cursor(sql, (options.binds ?? []) as (string | number | null)[]));
    return await readCursor(cursor, options.maxRows);
  } catch (err) {
    throw translatePgError(err);
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Executes one write statement on a fresh read-write connection (gated by the
 * pg.write grant upstream). Passing a values array - even empty - runs it over
 * the extended protocol, so multi-statement SQL is a server-side error here too.
 */
export async function runPgWrite(sql: string, options: PgWriteOptions = {}): Promise<PgWriteResult> {
  const client = new pg.Client(clientConfig(options.timeoutSeconds ?? DEFAULT_TIMEOUT_S, false, options.database));
  try {
    await client.connect();
  } catch (err) {
    await client.end().catch(() => {});
    throw translatePgError(err);
  }
  try {
    const result = await client.query({ text: sql, values: (options.binds ?? []) as unknown[] });
    return {
      command: result.command,
      rowCount: result.rowCount,
      rows: result.rows as Record<string, unknown>[],
      numericColumns: new Set(result.fields.filter((f) => NUMERIC_OIDS.has(f.dataTypeID)).map((f) => f.name)),
    };
  } catch (err) {
    throw translatePgError(err);
  } finally {
    await client.end().catch(() => {});
  }
}

async function readCursor(cursor: Cursor, maxRows: number | undefined): Promise<PgQueryResult> {
  const rows: Record<string, unknown>[] = [];
  let fields: pg.FieldDef[] = [];
  let complete = false;
  while (maxRows === undefined || rows.length < maxRows) {
    const wanted = maxRows === undefined ? CHUNK : Math.min(CHUNK, maxRows - rows.length);
    const chunk = await cursorRead(cursor, wanted);
    if (chunk.fields.length > 0) fields = chunk.fields;
    rows.push(...chunk.rows);
    if (chunk.rows.length < wanted) {
      complete = true;
      break;
    }
  }
  if (!complete) {
    const probe = await cursorRead(cursor, 1);
    if (probe.fields.length > 0 && fields.length === 0) fields = probe.fields;
    complete = probe.rows.length === 0;
  }
  return {
    rows,
    complete,
    numericColumns: new Set(fields.filter((f) => NUMERIC_OIDS.has(f.dataTypeID)).map((f) => f.name)),
  };
}

function cursorRead(
  cursor: Cursor,
  count: number,
): Promise<{ rows: Record<string, unknown>[]; fields: pg.FieldDef[] }> {
  return new Promise((resolve, reject) => {
    cursor.read(count, (err, rows, result) => {
      if (err) reject(err);
      else resolve({ rows: rows as Record<string, unknown>[], fields: result?.fields ?? [] });
    });
  });
}

const CONNECT_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH"]);

export function translatePgError(err: unknown): AxiError {
  if (err instanceof AxiError) return err;
  const e = err as { code?: string; message?: string; position?: string; hint?: string };
  const message = (e.message ?? String(err)).replace(/\s+/g, " ").trim();
  const code = e.code ?? "";

  if (code === "28P01" || code === "28000") {
    return new AxiError("Postgres authentication failed", "AUTH_ERROR", [
      "Check SNOWFLAKE_AXI_PG_USER and SNOWFLAKE_AXI_PG_PASSWORD in the env file",
    ]);
  }
  if (code === "3D000") {
    return new AxiError(message, "CONFIG_ERROR", ["Check SNOWFLAKE_AXI_PG_DATABASE in the env file"]);
  }
  if (code === "42P01") {
    return new AxiError(message, "PG_ERROR", ["Run `snowflake-axi pg tables --like <name>` to find the right table"]);
  }
  if (code === "42703") {
    return new AxiError(message, "PG_ERROR", ["Run `snowflake-axi pg schema <table>` to check the column names"]);
  }
  if (code === "25006" || /read-only.*transaction/i.test(message)) {
    return new AxiError("The Postgres session is read-only, so write statements are rejected", "READ_ONLY", [
      "If this SELECT/WITH invokes a writing function or a data-modifying CTE, rerun with --write (needs the pg.write grant)",
      "Otherwise hand write statements to the operator to run manually",
    ]);
  }
  if (code === "57014") {
    return new AxiError("Statement timed out", "TIMEOUT", [
      "Rerun with a higher --timeout <seconds> or narrow the query",
    ]);
  }
  if (/multiple commands into a prepared statement/i.test(message)) {
    return new AxiError("Multiple statements are not allowed", "VALIDATION_ERROR", [
      "Run one statement per `snowflake-axi pg query` invocation",
    ]);
  }
  if (code === "42601") {
    const position = e.position ? ` at position ${e.position}` : "";
    return new AxiError(`SQL syntax error${position}: ${message}`, "PG_ERROR", e.hint ? [e.hint] : []);
  }
  if (CONNECT_CODES.has(code) || /timeout expired|connection terminated/i.test(message)) {
    return new AxiError(`Could not reach Postgres: ${message}`, "CONNECTION_ERROR", [
      "Check SNOWFLAKE_AXI_PG_HOST and SNOWFLAKE_AXI_PG_PORT, and that this machine can reach the instance",
    ]);
  }
  if (code.startsWith("ERR_TLS") || /certificate|self[- ]signed/i.test(message)) {
    return new AxiError(`TLS verification failed: ${message}`, "CONNECTION_ERROR", [
      "Check SNOWFLAKE_AXI_PG_SSLMODE; `require` encrypts without certificate verification",
    ]);
  }
  return new AxiError(message, "PG_ERROR", e.hint ? [e.hint] : []);
}

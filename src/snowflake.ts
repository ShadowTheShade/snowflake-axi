import { randomUUID } from "node:crypto";
import { AxiError } from "axi-sdk-js";
import { loadConfig } from "./config.js";

export interface QueryResult {
  rows: Record<string, unknown>[];
  total: number;
  numericColumns: Set<string>;
}

export interface QueryOptions {
  binds?: (string | number)[];
  maxRows?: number;
  timeoutSeconds?: number;
  /** One-off warehouse switch; sessions otherwise run on the user's DEFAULT_WAREHOUSE. */
  warehouse?: string;
}

interface ColumnType {
  name: string;
  type: string;
}

interface StatementResponse {
  message?: string;
  statementHandle?: string;
  statementStatusUrl?: string;
  resultSetMetaData?: {
    numRows: number;
    partitionInfo: { rowCount: number }[];
    rowType: ColumnType[];
  };
  data?: (string | null)[][];
}

const NUMERIC_TYPES = new Set(["fixed", "real"]);
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const POLL_MS = 500;
const HANDLE_NOTE_MS = 10_000;

/** A statement that is still executing; its result stays collectable for ~24h. */
export interface RunningStatement {
  running: true;
  handle: string;
}

function requestContext(): { base: string; headers: Record<string, string> } {
  const config = loadConfig();
  return {
    base: `https://${config.account.replace(/_/g, "-")}.snowflakecomputing.com`,
    headers: {
      authorization: `Bearer ${config.token}`,
      "x-snowflake-authorization-token-type": "PROGRAMMATIC_ACCESS_TOKEN",
      "content-type": "application/json",
      "user-agent": "snowflake-axi",
    },
  };
}

/**
 * Executes one statement over the Snowflake SQL API: a stateless HTTPS POST
 * authenticated by the PAT as a bearer token, so there is no login handshake
 * or session to establish. With maxRows set, only the result partitions
 * needed to cover it are fetched while the total row count comes from the
 * result metadata, so callers can report definitive totals without fetching
 * everything.
 */
export async function runQuery(sqlText: string, options: QueryOptions = {}): Promise<QueryResult> {
  const config = loadConfig();
  const { base, headers } = requestContext();
  const body = JSON.stringify({
    statement: sqlText,
    role: config.role,
    warehouse: options.warehouse,
    database: config.database,
    schema: config.schema,
    timeout: options.timeoutSeconds,
    bindings: toBindings(options.binds),
  });

  const response = await awaitResult(base, headers, await submit(base, headers, body));
  const payload = await parsePayload(response);
  if (!response.ok) {
    throw translateError(response.status, payload.message ?? `Snowflake returned HTTP ${response.status}`);
  }
  return collectResult(base, headers, payload, options.maxRows);
}

/**
 * Fetches the result of a previously submitted statement by handle, without
 * re-running it. Returns a running marker while the statement is still
 * executing.
 */
export async function fetchStatementResult(
  handle: string,
  options: { maxRows?: number } = {},
): Promise<QueryResult | RunningStatement> {
  const { base, headers } = requestContext();
  let response: Response;
  try {
    response = await fetch(`${base}/api/v2/statements/${handle}`, { headers });
  } catch (err) {
    throw translateError(0, err instanceof Error ? err.message : String(err));
  }
  if (response.status === 202) return { running: true, handle };
  const payload = await parsePayload(response);
  if (!response.ok) {
    throw translateError(response.status, payload.message ?? `Snowflake returned HTTP ${response.status}`);
  }
  return collectResult(base, headers, payload, options.maxRows);
}

async function collectResult(
  base: string,
  headers: Record<string, string>,
  payload: StatementResponse,
  maxRows: number | undefined,
): Promise<QueryResult> {
  const meta = payload.resultSetMetaData;
  if (!meta) return { rows: [], total: 0, numericColumns: new Set() };
  const total = meta.numRows;
  const wanted = maxRows === undefined ? total : Math.min(maxRows, total);
  const cells = [...(payload.data ?? [])];
  for (let partition = 1; cells.length < wanted && partition < meta.partitionInfo.length; partition++) {
    cells.push(...(await fetchPartition(base, headers, payload.statementHandle ?? "", partition)));
  }
  return {
    rows: cells.slice(0, wanted).map((values) => decodeRow(values, meta.rowType)),
    total,
    numericColumns: new Set(meta.rowType.filter((c) => NUMERIC_TYPES.has(c.type)).map((c) => c.name)),
  };
}

// requestId makes the one retry after a transient failure idempotent.
async function submit(base: string, headers: Record<string, string>, body: string): Promise<Response> {
  const url = `${base}/api/v2/statements?requestId=${randomUUID()}`;
  try {
    const response = await fetch(url, { method: "POST", headers, body });
    if (!RETRYABLE_STATUS.has(response.status)) return response;
  } catch {
    // Network failure; fall through to the single retry.
  }
  try {
    return await fetch(`${url}&retry=true`, { method: "POST", headers, body });
  } catch (err) {
    throw translateError(0, err instanceof Error ? err.message : String(err));
  }
}

// 202 means the statement is still executing; poll until it settles. Once
// polling runs long, the handle goes to stderr so a killed invocation (an
// agent's shell timeout, Ctrl+C) does not orphan the warehouse work.
async function awaitResult(base: string, headers: Record<string, string>, first: Response): Promise<Response> {
  let response = first;
  const started = Date.now();
  let noted = false;
  while (response.status === 202) {
    const { statementStatusUrl, statementHandle } = await parsePayload(response);
    if (!statementStatusUrl) break;
    if (!noted && statementHandle && Date.now() - started > HANDLE_NOTE_MS) {
      noted = true;
      process.stderr.write(
        `still running; if this invocation dies, collect with: snowflake-axi result ${statementHandle}\n`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    response = await fetch(`${base}${statementStatusUrl}`, { headers });
  }
  return response;
}

async function fetchPartition(
  base: string,
  headers: Record<string, string>,
  handle: string,
  partition: number,
): Promise<(string | null)[][]> {
  const response = await fetch(`${base}/api/v2/statements/${handle}?partition=${partition}`, { headers });
  const payload = await parsePayload(response);
  if (!response.ok) {
    throw translateError(response.status, payload.message ?? `result partition fetch failed (HTTP ${response.status})`);
  }
  return payload.data ?? [];
}

async function parsePayload(response: Response): Promise<StatementResponse> {
  try {
    return (await response.json()) as StatementResponse;
  } catch {
    return {};
  }
}

function toBindings(binds?: (string | number)[]): Record<string, { type: string; value: string }> | undefined {
  if (!binds || binds.length === 0) return undefined;
  return Object.fromEntries(
    binds.map((value, i) => [
      String(i + 1),
      { type: typeof value === "number" ? "FIXED" : "TEXT", value: String(value) },
    ]),
  );
}

function translateError(status: number, message: string): AxiError {
  if (/network policy/i.test(message)) {
    return new AxiError("Snowflake rejected the token: user has no network policy for PAT auth", "AUTH_ERROR", [
      "Attach a network policy covering this machine's egress IP to the service user",
    ]);
  }
  const blockedIp = message.match(/IP\/Token (\d+(?:\.\d+){3}).* not allowed to access Snowflake/)?.[1];
  if (blockedIp) {
    return new AxiError(
      `Snowflake blocked this connection: egress IP ${blockedIp} is not in the user's network policy`,
      "AUTH_ERROR",
      [`Have an admin add ${blockedIp} to the network policy attached to the service user`],
    );
  }
  if (status === 401 || status === 403 || /incorrect username or password|authentication/i.test(message)) {
    return new AxiError("Snowflake authentication failed", "AUTH_ERROR", [
      "Check SNOWFLAKE_USER and SNOWFLAKE_TOKEN (PAT) in the env file, and that the PAT has not expired",
      "PAT auth also fails when this machine's egress IP is outside the user's network policy",
    ]);
  }
  const compact = message.replace(/\s+/g, " ").trim();
  if (status === 408 || /statement or warehouse timeout/i.test(compact)) {
    return new AxiError(compact, "TIMEOUT", ["Rerun with a higher --timeout <seconds> or narrow the query"]);
  }
  if (/does not have a current (database|schema)|DEFAULT_NAMESPACE property/i.test(compact)) {
    return new AxiError(
      "The session has no default database/schema, so unqualified names cannot resolve",
      "SNOWFLAKE_ERROR",
      [
        "Qualify the name as db.schema.table",
        "Or give the user a durable default: ALTER USER <user> SET DEFAULT_NAMESPACE = '<db>.<schema>'",
      ],
    );
  }
  if (/invalid identifier/i.test(compact)) {
    return new AxiError(compact, "SNOWFLAKE_ERROR", ["Run `snowflake-axi schema <table>` to check the column names"]);
  }
  if (/statement.*(not found|does not exist)/i.test(compact)) {
    return new AxiError(compact, "SNOWFLAKE_ERROR", [
      "Statement results are kept for about 24 hours and are only visible to the submitting user; rerun the original query if the handle expired",
    ]);
  }
  if (/does not exist or not authorized/i.test(compact)) {
    return new AxiError(compact, "SNOWFLAKE_ERROR", [
      "Run `snowflake-axi tables --like <name>` to find the right table",
    ]);
  }
  if (status === 0) {
    return new AxiError(`Could not reach Snowflake: ${compact}`, "CONNECTION_ERROR", [
      "Check the network connection and that SNOWFLAKE_ACCOUNT is the right account identifier",
    ]);
  }
  return new AxiError(compact, "SNOWFLAKE_ERROR");
}

// jsonv2 wire encodings: dates are epoch days, times are seconds since
// midnight, timestamps are epoch seconds with nanos, and timestamp_tz
// appends the offset in minutes biased by +1440.
function decodeRow(values: (string | null)[], columns: ColumnType[]): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  columns.forEach((column, i) => {
    row[column.name] = decodeValue(values[i], column.type);
  });
  return row;
}

function decodeValue(value: string | null | undefined, type: string): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case "date":
      return utcDate(Number(value) * 86_400_000);
    case "time": {
      const { ms, fraction } = splitEpoch(value);
      return clock(ms) + fraction;
    }
    case "timestamp_ntz": {
      const { ms, fraction } = splitEpoch(value);
      return stamp(ms) + fraction;
    }
    case "timestamp_ltz": {
      const { ms, fraction } = splitEpoch(value);
      return `${stamp(ms)}${fraction}Z`;
    }
    case "timestamp_tz": {
      const [epoch, biasedOffset] = value.split(" ");
      const offsetMinutes = Number(biasedOffset) - 1440;
      const { ms, fraction } = splitEpoch(epoch);
      const sign = offsetMinutes < 0 ? "-" : "+";
      const abs = Math.abs(offsetMinutes);
      return `${stamp(ms + offsetMinutes * 60_000)}${fraction}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
    }
    default:
      return value;
  }
}

function splitEpoch(value: string): { ms: number; fraction: string } {
  const [seconds, nanos = ""] = value.split(".");
  const trimmed = nanos.replace(/0+$/, "");
  return { ms: Number(seconds) * 1000, fraction: trimmed ? `.${trimmed}` : "" };
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function utcDate(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function stamp(ms: number): string {
  const d = new Date(ms);
  return `${utcDate(ms)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function clock(ms: number): string {
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}`;
}

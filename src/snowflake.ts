import { AxiError } from "axi-sdk-js";
import snowflake, { type Connection } from "snowflake-sdk";
import { loadConfig } from "./config.js";

export interface QueryResult {
  rows: Record<string, unknown>[];
  total: number;
  numericColumns: Set<string>;
}

export interface QueryOptions {
  binds?: (string | number)[];
  maxRows?: number;
}

let connecting: Promise<Connection> | undefined;

async function connect(): Promise<Connection> {
  const config = loadConfig();
  snowflake.configure({ logLevel: "OFF" });
  const connection = snowflake.createConnection({
    account: config.account,
    username: config.user,
    password: config.token,
    role: config.role,
    warehouse: config.warehouse,
    database: config.database,
    schema: config.schema,
    application: "snowflake_axi",
    fetchAsString: ["Number", "Date"],
  });
  await new Promise<void>((resolve, reject) => {
    connection.connect((err) => (err ? reject(translateError(err)) : resolve()));
  });
  return connection;
}

export function getConnection(): Promise<Connection> {
  connecting ??= connect();
  return connecting;
}

export async function closeConnection(): Promise<void> {
  if (!connecting) return;
  try {
    const connection = await connecting;
    await new Promise<void>((resolve) => connection.destroy(() => resolve()));
  } catch {
    // Connection never established; nothing to clean up.
  }
  connecting = undefined;
}

function translateError(err: { message?: string; code?: string | number }): AxiError {
  const message = err.message ?? String(err);
  if (message.includes("390432") || /network policy/i.test(message)) {
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
  if (/incorrect username or password|authentication/i.test(message)) {
    return new AxiError("Snowflake authentication failed", "AUTH_ERROR", [
      "Check SNOWFLAKE_USER and SNOWFLAKE_TOKEN (PAT) in the env file, and that the PAT has not expired",
    ]);
  }
  const compact = message.replace(/\s+/g, " ").trim();
  if (/statement or warehouse timeout/i.test(compact)) {
    return new AxiError(compact, "TIMEOUT", [
      "Rerun with a higher --timeout <seconds> or narrow the query",
    ]);
  }
  if (/invalid identifier/i.test(compact)) {
    return new AxiError(compact, "SNOWFLAKE_ERROR", [
      "Run `snowflake-axi schema <table>` to check the column names",
    ]);
  }
  if (/does not exist or not authorized/i.test(compact)) {
    return new AxiError(compact, "SNOWFLAKE_ERROR", [
      "Run `snowflake-axi tables --like <name>` to find the right table",
    ]);
  }
  return new AxiError(compact, "SNOWFLAKE_ERROR");
}

/**
 * Executes one statement. With maxRows set, streams only the first maxRows
 * rows off the result while total row count comes from the statement
 * metadata, so callers can report definitive totals without fetching
 * everything.
 */
export async function runQuery(sqlText: string, options: QueryOptions = {}): Promise<QueryResult> {
  const connection = await getConnection();
  return new Promise<QueryResult>((resolve, reject) => {
    connection.execute({
      sqlText,
      binds: options.binds,
      streamResult: true,
      complete: (err, statement) => {
        if (err) {
          reject(translateError(err));
          return;
        }
        const total = statement.getNumRows();
        const numericColumns = new Set(
          (statement.getColumns() ?? []).filter((column) => column.isNumber()).map((column) => column.getName()),
        );
        const wanted = options.maxRows === undefined ? total : Math.min(options.maxRows, total);
        const rows: Record<string, unknown>[] = [];
        if (wanted === 0) {
          resolve({ rows, total, numericColumns });
          return;
        }
        const stream = statement.streamRows({ start: 0, end: wanted - 1 });
        stream.on("data", (row: Record<string, unknown>) => rows.push(row));
        stream.on("error", (streamErr: Error) => reject(translateError(streamErr)));
        stream.on("end", () => resolve({ rows, total, numericColumns }));
      },
    });
  });
}

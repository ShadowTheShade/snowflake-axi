import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { parse as parseToml } from "smol-toml";

export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export interface Config {
  account: string;
  user: string;
  token: string;
  role?: string;
  database?: string;
  schema?: string;
  modelDirs: string[];
  defaultFileFormat?: string;
  dbtTarget?: string;
}

export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "snowflake-axi");
}

export function envFilePath(): string {
  return join(configDir(), "env");
}

function parseEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return values;
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

function snowflakeHome(): string {
  return process.env.SNOWFLAKE_HOME || join(homedir(), ".snowflake");
}

function readToml(path: string): Record<string, unknown> | undefined {
  try {
    return parseToml(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Credentials shared with the official snow CLI: connections from
 * ~/.snowflake/connections.toml (or the [connections] table of config.toml),
 * selected the way snow selects them. Only PAT connections (a token with
 * authenticator PROGRAMMATIC_ACCESS_TOKEN, or a password field holding a
 * PAT) are usable; browser/SSO/key-pair connections yield nothing here.
 */
function snowCliConnection(): Record<string, string> {
  const home = snowflakeHome();
  const config = readToml(join(home, "config.toml"));
  const standalone = readToml(join(home, "connections.toml"));
  const connections =
    standalone && Object.keys(standalone).length > 0
      ? standalone
      : ((config?.connections ?? {}) as Record<string, unknown>);

  const name =
    process.env.SNOWFLAKE_DEFAULT_CONNECTION_NAME ||
    (typeof config?.default_connection_name === "string" ? config.default_connection_name : "default");
  const section = connections[name];
  if (typeof section !== "object" || section === null) return {};

  const connection = section as Record<string, unknown>;
  const str = (key: string) => (typeof connection[key] === "string" ? (connection[key] as string) : undefined);
  const authenticator = str("authenticator")?.toUpperCase();
  const token = authenticator === "PROGRAMMATIC_ACCESS_TOKEN" ? str("token") : undefined;
  const values: Record<string, string | undefined> = {
    SNOWFLAKE_ACCOUNT: str("account"),
    SNOWFLAKE_USER: str("user"),
    SNOWFLAKE_TOKEN: token ?? str("password"),
    SNOWFLAKE_ROLE: str("role"),
    SNOWFLAKE_DATABASE: str("database"),
    SNOWFLAKE_SCHEMA: str("schema"),
  };
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export interface PgConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslmode: "disable" | "require" | "verify-full";
}

const PG_SSLMODES = new Set(["disable", "require", "verify-full"]);

let cachedPg: PgConfig | undefined;

/**
 * Snowflake Postgres connection settings, independent of the Snowflake
 * credentials: `pg` commands work even when the SQL API side is not set up.
 * Keys are prefixed rather than the ambient PGHOST family so that shell
 * variables from unrelated work can never silently retarget the tool.
 */
export function loadPgConfig(): PgConfig {
  if (cachedPg) return cachedPg;
  const file = parseEnvFile(envFilePath());
  const get = (key: string) => process.env[key] || file[key] || undefined;
  const host = get("SNOWFLAKE_AXI_PG_HOST");
  const user = get("SNOWFLAKE_AXI_PG_USER");
  const password = get("SNOWFLAKE_AXI_PG_PASSWORD");
  if (!host || !user || !password) {
    const missing = [
      ["SNOWFLAKE_AXI_PG_HOST", host],
      ["SNOWFLAKE_AXI_PG_USER", user],
      ["SNOWFLAKE_AXI_PG_PASSWORD", password],
    ]
      .filter(([, value]) => !value)
      .map(([key]) => key);
    throw new AxiError(`Missing Snowflake Postgres connection settings: ${missing.join(", ")}`, "CONFIG_ERROR", [
      `Add SNOWFLAKE_AXI_PG_HOST, SNOWFLAKE_AXI_PG_USER, SNOWFLAKE_AXI_PG_PASSWORD to ${envFilePath()}`,
      "Optional keys: SNOWFLAKE_AXI_PG_PORT (5432), SNOWFLAKE_AXI_PG_DATABASE (postgres), SNOWFLAKE_AXI_PG_SSLMODE (require)",
    ]);
  }
  const port = Number(get("SNOWFLAKE_AXI_PG_PORT") ?? "5432");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AxiError(`Invalid SNOWFLAKE_AXI_PG_PORT '${get("SNOWFLAKE_AXI_PG_PORT")}'`, "CONFIG_ERROR", [
      `Fix SNOWFLAKE_AXI_PG_PORT in ${envFilePath()} (1-65535)`,
    ]);
  }
  const sslmode = get("SNOWFLAKE_AXI_PG_SSLMODE") ?? "require";
  if (!PG_SSLMODES.has(sslmode)) {
    throw new AxiError(`Invalid SNOWFLAKE_AXI_PG_SSLMODE '${sslmode}'`, "CONFIG_ERROR", [
      `Fix SNOWFLAKE_AXI_PG_SSLMODE in ${envFilePath()}: disable, require, or verify-full`,
    ]);
  }
  cachedPg = {
    host,
    port,
    database: get("SNOWFLAKE_AXI_PG_DATABASE") ?? "postgres",
    user,
    password,
    sslmode: sslmode as PgConfig["sslmode"],
  };
  return cachedPg;
}

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;
  const file = parseEnvFile(envFilePath());
  const toml = snowCliConnection();
  const get = (key: string) => process.env[key] || file[key] || toml[key] || undefined;
  const account = get("SNOWFLAKE_ACCOUNT");
  const user = get("SNOWFLAKE_USER");
  const token = get("SNOWFLAKE_TOKEN");
  if (!account || !user || !token) {
    const missing = [
      ["SNOWFLAKE_ACCOUNT", account],
      ["SNOWFLAKE_USER", user],
      ["SNOWFLAKE_TOKEN", token],
    ]
      .filter(([, value]) => !value)
      .map(([key]) => key);
    throw new AxiError(`Missing Snowflake credentials: ${missing.join(", ")}`, "CONFIG_ERROR", [
      `Create ${envFilePath()} with SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_TOKEN (PAT)`,
      "Or add a PAT connection to ~/.snowflake/connections.toml (shared with the snow CLI)",
      "Optional keys: SNOWFLAKE_ROLE, SNOWFLAKE_DATABASE, SNOWFLAKE_SCHEMA",
    ]);
  }
  for (const key of ["SNOWFLAKE_DATABASE", "SNOWFLAKE_SCHEMA"]) {
    const value = get(key);
    if (value && !IDENTIFIER.test(value)) {
      throw new AxiError(`Invalid ${key} '${value}': not an unquoted identifier`, "CONFIG_ERROR", [
        `Fix ${key} in ${envFilePath()} (letters, digits, _ and $ only)`,
      ]);
    }
  }
  cached = {
    account,
    user,
    token,
    role: get("SNOWFLAKE_ROLE"),
    database: get("SNOWFLAKE_DATABASE"),
    schema: get("SNOWFLAKE_SCHEMA"),
    modelDirs: (get("SNOWFLAKE_AXI_MODEL_DIRS") ?? "").split(":").filter(Boolean).map(expandHome),
    defaultFileFormat: get("SNOWFLAKE_AXI_DEFAULT_FILE_FORMAT"),
    dbtTarget: get("SNOWFLAKE_AXI_DBT_TARGET"),
  };
  return cached;
}

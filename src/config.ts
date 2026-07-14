import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { parse as parseToml } from "smol-toml";

export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export type AuthMode = "pat" | "oauth";

export interface Config {
  account: string;
  user: string;
  auth: AuthMode;
  /** PAT bearer token; unset in OAuth mode, where oauth.ts supplies the access token. */
  token?: string;
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

export function accountUrl(account: string): string {
  return `https://${account.replace(/_/g, "-")}.snowflakecomputing.com`;
}

export function oauthTokenPath(): string {
  return join(configDir(), "oauth-tokens.json");
}

/** Tokens from one `snowflake-axi login`; timestamps are epoch milliseconds. */
export interface OAuthTokens {
  account: string;
  clientId: string;
  user: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  roleScope?: string;
}

/**
 * The token ring: one independent login per role, since Snowflake OAuth pins
 * every token to a single role. Entries are keyed by oauthRoleKey(roleScope);
 * per-query --role selects the matching login.
 */
export interface OAuthTokenRing {
  entries: Record<string, OAuthTokens>;
}

export const DEFAULT_ROLE_KEY = "default";

/** Role names are case-insensitive identifiers; the unscoped login is "default". */
export function oauthRoleKey(role?: string): string {
  return role === undefined ? DEFAULT_ROLE_KEY : role.toUpperCase();
}

export function readOAuthRing(): OAuthTokenRing | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(oauthTokenPath(), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  // Pre-ring files held a single login at the top level.
  if (typeof record.refreshToken === "string") {
    const tokens = parsed as unknown as OAuthTokens;
    return { entries: { [oauthRoleKey(tokens.roleScope)]: tokens } };
  }
  if (typeof record.entries !== "object" || record.entries === null) return undefined;
  return { entries: record.entries as Record<string, OAuthTokens> };
}

// The refresh tokens are long-lived credentials, so the file must stay 0600;
// chmod covers overwrites, where writeFileSync ignores the mode.
export function writeOAuthRing(ring: OAuthTokenRing): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(oauthTokenPath(), `${JSON.stringify({ version: 2, ...ring }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(oauthTokenPath(), 0o600);
}

/** Ring keys with the default login first, then roles alphabetically. */
export function oauthRingKeys(ring: OAuthTokenRing): string[] {
  return Object.keys(ring.entries).sort((a, b) =>
    a === DEFAULT_ROLE_KEY ? -1 : b === DEFAULT_ROLE_KEY ? 1 : a.localeCompare(b),
  );
}

export function activeRolePath(): string {
  return join(configDir(), "active-role");
}

/**
 * The role chosen by `snowflake-axi role <name>`: the default primary role for
 * every command, so a role need not be repeated per invocation. Undefined means
 * no active role is set, and commands fall back to the default login (OAuth) or
 * SNOWFLAKE_ROLE (PAT). Held in its own file, not the token ring, so a silent
 * token refresh never has to preserve it and PAT setups can use it too.
 */
export function readActiveRole(): string | undefined {
  let text: string;
  try {
    text = readFileSync(activeRolePath(), "utf8");
  } catch {
    return undefined;
  }
  const role = text.trim();
  return role.length > 0 ? role : undefined;
}

/** Persist the active role, or clear it when role is undefined. */
export function writeActiveRole(role: string | undefined): void {
  if (role === undefined) {
    rmSync(activeRolePath(), { force: true });
    return;
  }
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(activeRolePath(), `${role}\n`);
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

/**
 * OAuth is selected by an explicit SNOWFLAKE_AUTH, or by a token file left by
 * `snowflake-axi login`; PAT remains the default otherwise, so existing
 * setups are untouched.
 */
function resolveAuthMode(explicit: string | undefined, ring: OAuthTokenRing | undefined): AuthMode {
  const mode = explicit?.toLowerCase();
  if (mode !== undefined && mode !== "pat" && mode !== "oauth") {
    throw new AxiError(`Invalid SNOWFLAKE_AUTH '${explicit}'`, "CONFIG_ERROR", [
      `Fix SNOWFLAKE_AUTH in ${envFilePath()}: pat or oauth`,
    ]);
  }
  return mode ?? (ring && Object.keys(ring.entries).length > 0 ? "oauth" : "pat");
}

export function loadConfig(): Config {
  if (cached) return cached;
  const file = parseEnvFile(envFilePath());
  const toml = snowCliConnection();
  const get = (key: string) => process.env[key] || file[key] || toml[key] || undefined;

  const ring = readOAuthRing();
  const auth = resolveAuthMode(get("SNOWFLAKE_AUTH"), ring);
  let account: string;
  let user: string;
  let token: string | undefined;
  if (auth === "oauth") {
    const identity = ring ? ring.entries[oauthRingKeys(ring)[0]] : undefined;
    if (!identity) {
      throw new AxiError("SNOWFLAKE_AUTH=oauth but no OAuth login was found", "CONFIG_ERROR", [
        "Run `snowflake-axi login` to sign in with the browser",
      ]);
    }
    // The logins own identity in OAuth mode: every token in the ring was
    // minted for one account and user, so env values cannot retarget it.
    account = identity.account;
    user = identity.user;
  } else {
    const envAccount = get("SNOWFLAKE_ACCOUNT");
    const envUser = get("SNOWFLAKE_USER");
    token = get("SNOWFLAKE_TOKEN");
    if (!envAccount || !envUser || !token) {
      const missing = [
        ["SNOWFLAKE_ACCOUNT", envAccount],
        ["SNOWFLAKE_USER", envUser],
        ["SNOWFLAKE_TOKEN", token],
      ]
        .filter(([, value]) => !value)
        .map(([key]) => key);
      throw new AxiError(`Missing Snowflake credentials: ${missing.join(", ")}`, "CONFIG_ERROR", [
        `Create ${envFilePath()} with SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_TOKEN (PAT)`,
        "Or add a PAT connection to ~/.snowflake/connections.toml (shared with the snow CLI)",
        "Or run `snowflake-axi login` for browser SSO via Snowflake OAuth",
        "Optional keys: SNOWFLAKE_ROLE, SNOWFLAKE_DATABASE, SNOWFLAKE_SCHEMA",
      ]);
    }
    account = envAccount;
    user = envUser;
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
    auth,
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

export interface OAuthLoginSettings {
  account: string;
  clientId: string;
  roleScope?: string;
}

/**
 * Settings `snowflake-axi login` needs before any token exists, so this
 * cannot go through loadConfig (which requires working credentials).
 */
export function oauthLoginSettings(): OAuthLoginSettings {
  const file = parseEnvFile(envFilePath());
  const get = (key: string) => process.env[key] || file[key] || undefined;
  const account = get("SNOWFLAKE_ACCOUNT");
  const clientId = get("SNOWFLAKE_OAUTH_CLIENT_ID");
  if (!account || !clientId) {
    const missing = [
      ["SNOWFLAKE_ACCOUNT", account],
      ["SNOWFLAKE_OAUTH_CLIENT_ID", clientId],
    ]
      .filter(([, value]) => !value)
      .map(([key]) => key);
    throw new AxiError(`Missing OAuth login settings: ${missing.join(", ")}`, "CONFIG_ERROR", [
      `Add ${missing.join(" and ")} to ${envFilePath()}`,
      "The client id comes from SYSTEM$SHOW_OAUTH_CLIENT_SECRETS on the security integration; see the README's OAuth setup",
    ]);
  }
  return { account, clientId, roleScope: get("SNOWFLAKE_OAUTH_ROLE_SCOPE") };
}

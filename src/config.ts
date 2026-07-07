import { AxiError } from "axi-sdk-js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export interface Config {
  account: string;
  user: string;
  token: string;
  role?: string;
  warehouse?: string;
  database?: string;
  schema?: string;
  modelDirs: string[];
  defaultFileFormat?: string;
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

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;
  const file = parseEnvFile(envFilePath());
  const get = (key: string) => process.env[key] ?? file[key];
  const missing = ["SNOWFLAKE_ACCOUNT", "SNOWFLAKE_USER", "SNOWFLAKE_TOKEN"].filter((k) => !get(k));
  if (missing.length > 0) {
    throw new AxiError(`Missing Snowflake credentials: ${missing.join(", ")}`, "CONFIG_ERROR", [
      `Create ${envFilePath()} with SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_TOKEN (PAT)`,
      "Optional keys: SNOWFLAKE_ROLE, SNOWFLAKE_WAREHOUSE, SNOWFLAKE_DATABASE, SNOWFLAKE_SCHEMA",
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
    account: get("SNOWFLAKE_ACCOUNT")!,
    user: get("SNOWFLAKE_USER")!,
    token: get("SNOWFLAKE_TOKEN")!,
    role: get("SNOWFLAKE_ROLE"),
    warehouse: get("SNOWFLAKE_WAREHOUSE"),
    database: get("SNOWFLAKE_DATABASE"),
    schema: get("SNOWFLAKE_SCHEMA"),
    modelDirs: (get("SNOWFLAKE_AXI_MODEL_DIRS") ?? "")
      .split(":")
      .filter(Boolean)
      .map(expandHome),
    defaultFileFormat: get("SNOWFLAKE_AXI_DEFAULT_FILE_FORMAT"),
  };
  return cached;
}

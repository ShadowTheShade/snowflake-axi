import { AxiError } from "axi-sdk-js";
import { IDENTIFIER } from "./config.js";

export { IDENTIFIER };

export interface TableName {
  database?: string;
  schema?: string;
  table: string;
  /** The name as given (uppercased); unqualified parts resolve in the session via DEFAULT_NAMESPACE. */
  fqn: string;
}

/** Parses table, schema.table, or db.schema.table; unqualified parts are left to the session to resolve. */
export function resolveTableName(raw: string): TableName {
  const parts = raw.split(".");
  if (parts.length > 3 || !parts.every((p) => IDENTIFIER.test(p))) {
    throw new AxiError(`Invalid table name '${raw}'`, "VALIDATION_ERROR", [
      "Use `table`, `schema.table`, or `db.schema.table` with unquoted identifiers",
    ]);
  }
  const upper = parts.map((p) => p.toUpperCase());
  const table = upper[upper.length - 1];
  const [database, schema] =
    upper.length === 3 ? [upper[0], upper[1]] : upper.length === 2 ? [undefined, upper[0]] : [undefined, undefined];
  return { database, schema, table, fqn: upper.join(".") };
}

export interface Scope {
  database?: string;
  schema?: string;
}

/** Parses an optional `db` or `db.schema` scope argument into uppercase identifiers. */
export function parseScope(raw: string | undefined): Scope {
  if (raw === undefined) return {};
  const parts = raw.split(".");
  if (parts.length > 2 || !parts.every((p) => IDENTIFIER.test(p))) {
    throw new AxiError(`Invalid scope '${raw}'`, "VALIDATION_ERROR", [
      "Use `db` or `db.schema` with unquoted identifiers",
    ]);
  }
  const [database, schema] = parts.map((p) => p.toUpperCase());
  return { database, schema };
}

/** The `IN {ACCOUNT|DATABASE|SCHEMA}` suffix a scope maps to for SHOW commands. */
export function scopeClause(scope: Scope): string {
  if (scope.database && scope.schema) return ` IN SCHEMA ${scope.database}.${scope.schema}`;
  if (scope.database) return ` IN DATABASE ${scope.database}`;
  return " IN ACCOUNT";
}

/** Human label for a scope, e.g. "account", "MY_DB", or "MY_DB.MY_SCHEMA". */
export function scopeLabel(scope: Scope): string {
  if (scope.database) return [scope.database, scope.schema].filter(Boolean).join(".");
  return "account";
}

/** Bare words match as contains; patterns with wildcards pass through. */
export function likePattern(raw: string): string {
  return raw.includes("%") || raw.includes("_") ? raw : `%${raw}%`;
}

/** Case-insensitive regex equivalent of a LIKE pattern, for filtering SHOW output client-side. */
export function likeRegex(raw: string): RegExp {
  return new RegExp(likePattern(raw).replace(/%/g, ".*"), "i");
}

/** The ` matching '<pattern>'` label a filtered count carries; empty without a filter. */
export function matchingLabel(like: string | undefined): string {
  return like === undefined ? "" : ` matching '${likePattern(like)}'`;
}

// SHOW commands take no bind variables, so LIKE patterns are interpolated and
// must stay within identifier characters plus SQL wildcards.
const SAFE_LIKE = /^[A-Za-z0-9_$%]+$/;

/** Validates and normalizes a --like value for interpolation into a SHOW ... LIKE clause. */
export function safeLike(raw: string, flagName: string): string {
  if (!SAFE_LIKE.test(raw)) {
    throw new AxiError(`Invalid ${flagName} pattern '${raw}'`, "VALIDATION_ERROR", [
      "Use identifier characters and % wildcards, e.g. `usage` or `USAGE%`",
    ]);
  }
  return likePattern(raw);
}

/** Parses and validates a --fields column list into a SELECT projection. */
export function parseFields(raw: string, casing: "upper" | "lower"): string {
  const list = raw.split(",").map((f) => (casing === "upper" ? f.trim().toUpperCase() : f.trim().toLowerCase()));
  const bad = list.filter((f) => !IDENTIFIER.test(f));
  if (list.length === 0 || bad.length > 0) {
    throw new AxiError(`Invalid --fields value${bad.length ? ` '${bad[0]}'` : ""}`, "VALIDATION_ERROR", [
      `Use a comma-separated list of column names: --fields ${casing === "upper" ? "ORDER_DATE,ORDER_TOTAL" : "created_at,status"}`,
    ]);
  }
  return list.join(", ");
}

/** Fully qualified name of a SHOW row: db.schema.name. */
export function objectFqn(row: Record<string, unknown>): string {
  return `${row.database_name}.${row.schema_name}.${row.name}`;
}

/** Containing scope of a SHOW row: db.schema. */
export function objectScope(row: Record<string, unknown>): string {
  return `${row.database_name}.${row.schema_name}`;
}

/** Parses a `name` (searched account-wide) or `db.schema.name` argument into uppercase parts. */
export function parseQualifiedName(raw: string, label: string): string[] {
  const parts = raw.split(".");
  if (parts.length === 2 || parts.length > 3 || !parts.every((p) => IDENTIFIER.test(p))) {
    throw new AxiError(`Invalid ${label} '${raw}'`, "VALIDATION_ERROR", [
      "Use `name` (searched account-wide) or `db.schema.name`",
    ]);
  }
  return parts.map((p) => p.toUpperCase());
}

export interface RepoName {
  fqn: string;
  database: string;
  schema: string;
  name: string;
}

/** Parses a fully qualified git repository object `db.schema.repo` into uppercase parts. */
export function resolveRepoName(raw: string): RepoName {
  const parts = raw.split(".");
  if (parts.length !== 3 || !parts.every((p) => IDENTIFIER.test(p))) {
    throw new AxiError(`Invalid git repository '${raw}'`, "VALIDATION_ERROR", [
      "Use the fully qualified repository object: DB.SCHEMA.REPO",
    ]);
  }
  const [database, schema, name] = parts.map((p) => p.toUpperCase());
  return { fqn: `${database}.${schema}.${name}`, database, schema, name };
}

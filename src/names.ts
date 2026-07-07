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

// SHOW commands take no bind variables, so LIKE patterns are interpolated and
// must stay within identifier characters plus SQL wildcards.
const SAFE_LIKE = /^[A-Za-z0-9_$%]+$/;

/** Validates and normalizes a --like value for interpolation into a SHOW ... LIKE clause. */
export function safeLike(raw: string, flagName: string): string {
  if (!SAFE_LIKE.test(raw)) {
    throw new AxiError(`Invalid ${flagName} pattern '${raw}'`, "VALIDATION_ERROR", [
      "Use identifier characters and % wildcards, e.g. --like usage or --like USAGE%",
    ]);
  }
  return likePattern(raw);
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

import { AxiError } from "axi-sdk-js";

const SNOWFLAKE_READ_HEADS = new Set(["SELECT", "WITH", "SHOW", "DESC", "DESCRIBE", "EXPLAIN"]);
const PG_READ_HEADS = new Set(["SELECT", "WITH", "TABLE", "VALUES", "SHOW", "EXPLAIN"]);

// Postgres EXPLAIN ANALYZE executes the statement it plans, and the
// CREATE TABLE AS / CREATE MATERIALIZED VIEW AS forms slip past the server's
// read-only-transaction check (verified live: the table really gets created).
// So EXPLAIN may only wrap statements that are read-only themselves.
const PG_EXPLAIN_INNER_HEADS = new Set(["SELECT", "WITH", "TABLE", "VALUES"]);
const PG_EXPLAIN_OPTION_WORDS = new Set([
  "ANALYZE",
  "VERBOSE",
  "COSTS",
  "SETTINGS",
  "GENERIC_PLAN",
  "BUFFERS",
  "WAL",
  "TIMING",
  "SUMMARY",
  "MEMORY",
  "SERIALIZE",
  "FORMAT",
  "TEXT",
  "XML",
  "JSON",
  "YAML",
  "BINARY",
  "NONE",
  "ON",
  "OFF",
  "TRUE",
  "FALSE",
]);

interface Dialect {
  /** Line comment openers; Snowflake adds // to the standard --. */
  lineComments: string[];
  /** Postgres dollar quotes may carry a tag ($tag$...$tag$); Snowflake only has bare $$. */
  taggedDollarQuotes: boolean;
}

const SNOWFLAKE: Dialect = { lineComments: ["--", "//"], taggedDollarQuotes: false };
const POSTGRES: Dialect = { lineComments: ["--"], taggedDollarQuotes: true };

const MAX_TOKENS = 48;

interface ScanResult {
  /** Leading bare-word tokens (uppercased), enough to see past EXPLAIN options. */
  tokens: string[];
  multiStatement: boolean;
  stripped: string;
}

/**
 * Minimal SQL scanner: tracks strings ('', "", $$), line and block comments
 * per dialect, so token and semicolon detection cannot be fooled by literals
 * or comments.
 */
function scan(sql: string, dialect: Dialect): ScanResult {
  const tokens: string[] = [];
  let multiStatement = false;
  let statementEnd = -1;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);

    if (dialect.lineComments.includes(two)) {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === "\\" && ch === "'") {
          i += 2;
        } else if (sql[i] === ch) {
          if (sql[i + 1] === ch) i += 2;
          else break;
        } else {
          i++;
        }
      }
      i++;
      continue;
    }
    if (ch === "$") {
      const tag = dialect.taggedDollarQuotes
        ? sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0]
        : two === "$$"
          ? "$$"
          : undefined;
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? sql.length : end + tag.length;
        continue;
      }
    }
    if (ch === ";") {
      if (statementEnd === -1) statementEnd = i;
      i++;
      continue;
    }
    if (/\S/.test(ch)) {
      if (statementEnd !== -1) {
        multiStatement = true;
        break;
      }
      if (tokens.length < MAX_TOKENS) {
        const match = sql.slice(i).match(/^[A-Za-z_][A-Za-z0-9_$]*/);
        if (match) {
          tokens.push(match[0].toUpperCase());
          i += match[0].length;
          continue;
        }
      }
    }
    i++;
  }

  const stripped = statementEnd === -1 ? sql.trim() : sql.slice(0, statementEnd).trim();
  return { tokens, multiStatement, stripped };
}

function assertReadHead(
  sql: string,
  dialect: Dialect,
  heads: Set<string>,
  example: string,
): { head: string; sql: string; tokens: string[] } {
  const { tokens, multiStatement, stripped } = scan(sql, dialect);
  const head = tokens[0];
  if (!head || stripped.length === 0) {
    throw new AxiError("No SQL statement provided", "VALIDATION_ERROR", [`Run \`${example}\``]);
  }
  if (multiStatement) {
    throw new AxiError("Multiple statements are not allowed", "VALIDATION_ERROR", [
      `Run one statement per invocation: ${example}`,
    ]);
  }
  if (!heads.has(head)) {
    throw new AxiError(`${head} statements are not allowed (read-only tool)`, "READ_ONLY", [
      `Allowed statements: ${[...heads].join(", ")}`,
      "Hand write statements to the operator to run manually",
    ]);
  }
  return { head, sql: stripped, tokens };
}

export function assertReadOnly(sql: string): { head: string; sql: string } {
  return assertReadHead(sql, SNOWFLAKE, SNOWFLAKE_READ_HEADS, 'snowflake-axi query "SELECT ..."');
}

export function assertPgReadOnly(sql: string): { head: string; sql: string } {
  const result = assertReadHead(sql, POSTGRES, PG_READ_HEADS, 'snowflake-axi pg query "SELECT ..."');
  if (result.head === "EXPLAIN") {
    const inner = result.tokens.slice(1).find((token) => !PG_EXPLAIN_OPTION_WORDS.has(token));
    if (inner === undefined || !PG_EXPLAIN_INNER_HEADS.has(inner)) {
      throw new AxiError(
        `EXPLAIN may only wrap a read-only statement here${inner ? ` (got ${inner})` : ""}`,
        "READ_ONLY",
        [
          `Allowed inside EXPLAIN: ${[...PG_EXPLAIN_INNER_HEADS].join(", ")}`,
          "EXPLAIN ANALYZE executes the statement it plans, so writes inside it are writes",
          "Hand write statements to the operator to run manually",
        ],
      );
    }
  }
  return { head: result.head, sql: result.sql };
}

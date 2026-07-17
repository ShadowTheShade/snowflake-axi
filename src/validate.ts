import { AxiError } from "axi-sdk-js";

// A statement is a read iff its head is one of these; everything else is a
// write. There is no write-head enumeration: `query`/`pg query` read for free
// and gate any non-read behind the write grant, so the set of runnable writes
// is "whatever the granted role allows", not a curated list.
// These head sets are restated in prose by the query/pg-query notes, the
// grant descriptions in grants.ts, and skill/SKILL.md; update those together.
const SNOWFLAKE_READ_HEADS = new Set(["SELECT", "WITH", "SHOW", "DESC", "DESCRIBE", "EXPLAIN"]);
const PG_READ_HEADS = new Set(["SELECT", "WITH", "TABLE", "VALUES", "SHOW", "EXPLAIN"]);

// Postgres EXPLAIN ANALYZE executes the statement it plans, and the
// CREATE TABLE AS / CREATE MATERIALIZED VIEW AS forms slip past the server's
// read-only-transaction check (verified live: the table really gets created).
// So an EXPLAIN wrapping anything but these read heads is classified as a write.
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

/** Scans one statement, failing loud on empty input or a second statement. */
function scanStatement(
  sql: string,
  dialect: Dialect,
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
  return { head, sql: stripped, tokens };
}

type StatementKind = "read" | "write";

export interface ClassifiedStatement {
  head: string;
  sql: string;
  kind: StatementKind;
}

/** Classifies one Snowflake statement as a read or a write; `query` gates writes behind the grant. */
export function classifyStatement(sql: string): ClassifiedStatement {
  const { head, sql: stripped } = scanStatement(sql, SNOWFLAKE, 'snowflake-axi query "SELECT ..."');
  return { head, sql: stripped, kind: SNOWFLAKE_READ_HEADS.has(head) ? "read" : "write" };
}

/** Classifies one Postgres statement; an EXPLAIN ANALYZE that would execute a write counts as a write. */
export function classifyPgStatement(sql: string): ClassifiedStatement {
  const { head, sql: stripped, tokens } = scanStatement(sql, POSTGRES, 'snowflake-axi pg query "SELECT ..."');
  if (!PG_READ_HEADS.has(head)) return { head, sql: stripped, kind: "write" };
  if (head === "EXPLAIN") {
    const inner = tokens.slice(1).find((token) => !PG_EXPLAIN_OPTION_WORDS.has(token));
    if (inner !== undefined && !PG_EXPLAIN_INNER_HEADS.has(inner)) {
      return { head, sql: stripped, kind: "write" };
    }
  }
  return { head, sql: stripped, kind: "read" };
}

function assertRead(classified: ClassifiedStatement, allowed: Set<string>): { head: string; sql: string } {
  if (classified.kind === "write") {
    throw new AxiError(`${classified.head} statements are not allowed here (read-only)`, "READ_ONLY", [
      `Allowed statements: ${[...allowed].join(", ")}`,
    ]);
  }
  return { head: classified.head, sql: classified.sql };
}

/** Asserts an internally built statement is a read; used where the caller only ever emits SELECTs. */
export function assertReadOnly(sql: string): { head: string; sql: string } {
  return assertRead(classifyStatement(sql), SNOWFLAKE_READ_HEADS);
}

export function assertPgReadOnly(sql: string): { head: string; sql: string } {
  return assertRead(classifyPgStatement(sql), PG_READ_HEADS);
}

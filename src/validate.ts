import { AxiError } from "axi-sdk-js";

const READ_HEADS = new Set(["SELECT", "WITH", "SHOW", "DESC", "DESCRIBE", "EXPLAIN"]);

interface ScanResult {
  head: string | undefined;
  multiStatement: boolean;
  stripped: string;
}

/**
 * Minimal SQL scanner: tracks strings ('', "", $$), both Snowflake comment
 * styles (-- and //, plus block comments) so head-keyword and semicolon
 * detection cannot be fooled by literals or comments.
 */
function scan(sql: string): ScanResult {
  let head: string | undefined;
  let multiStatement = false;
  let statementEnd = -1;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);

    if (two === "--" || two === "//") {
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
    if (two === "$$") {
      const end = sql.indexOf("$$", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
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
      if (!head) {
        const match = sql.slice(i).match(/^[A-Za-z_]+/);
        if (match) {
          head = match[0].toUpperCase();
          i += match[0].length;
          continue;
        }
      }
    }
    i++;
  }

  const stripped = statementEnd === -1 ? sql.trim() : sql.slice(0, statementEnd).trim();
  return { head, multiStatement, stripped };
}

export function assertReadOnly(sql: string): { head: string; sql: string } {
  const { head, multiStatement, stripped } = scan(sql);
  if (!head || stripped.length === 0) {
    throw new AxiError("No SQL statement provided", "VALIDATION_ERROR", ['Run `snowflake-axi query "SELECT ..."`']);
  }
  if (multiStatement) {
    throw new AxiError("Multiple statements are not allowed", "VALIDATION_ERROR", [
      "Run one statement per `snowflake-axi query` invocation",
    ]);
  }
  if (!READ_HEADS.has(head)) {
    throw new AxiError(`${head} statements are not allowed (read-only tool)`, "READ_ONLY", [
      "Allowed statements: SELECT, WITH, SHOW, DESC, DESCRIBE, EXPLAIN",
      "Hand write statements to the operator to run manually",
    ]);
  }
  return { head, sql: stripped };
}

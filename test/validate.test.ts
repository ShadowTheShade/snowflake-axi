import { AxiError } from "axi-sdk-js";
import { describe, expect, it } from "vitest";
import { assertReadOnly } from "../src/validate.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AxiError) return error.code;
    throw error;
  }
  throw new Error("expected an AxiError");
}

describe("assertReadOnly", () => {
  it.each([
    ["SELECT 1", "SELECT"],
    ["select * from t", "SELECT"],
    ["WITH x AS (SELECT 1) SELECT * FROM x", "WITH"],
    ["SHOW DATABASES", "SHOW"],
    ["DESC TABLE FCT_ORDERS", "DESC"],
    ["DESCRIBE TABLE FCT_ORDERS", "DESCRIBE"],
    ["EXPLAIN SELECT 1", "EXPLAIN"],
  ])("accepts %s", (sql, head) => {
    expect(assertReadOnly(sql).head).toBe(head);
  });

  it.each([
    "UPDATE t SET a = 1",
    "DELETE FROM t",
    "INSERT INTO t VALUES (1)",
    "CREATE TABLE t (a INT)",
    "DROP TABLE t",
    "TRUNCATE TABLE t",
    "MERGE INTO t USING s ON 1=1 WHEN MATCHED THEN DELETE",
    "CALL my_proc()",
    "COPY INTO t FROM @stage",
    "GRANT SELECT ON t TO ROLE r",
    "ALTER SESSION SET X = 1",
  ])("rejects %s with READ_ONLY", (sql) => {
    expect(codeOf(() => assertReadOnly(sql))).toBe("READ_ONLY");
  });

  it("skips leading comments in all three styles", () => {
    expect(assertReadOnly("-- comment\nSELECT 1").head).toBe("SELECT");
    expect(assertReadOnly("// comment\nSELECT 1").head).toBe("SELECT");
    expect(assertReadOnly("/* block\ncomment */ SELECT 1").head).toBe("SELECT");
  });

  it("strips a trailing semicolon", () => {
    expect(assertReadOnly("SELECT 1;").sql).toBe("SELECT 1");
    expect(assertReadOnly("SELECT 1; \n").sql).toBe("SELECT 1");
  });

  it("rejects multiple statements", () => {
    expect(codeOf(() => assertReadOnly("SELECT 1; SELECT 2"))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => assertReadOnly("SELECT 1; DROP TABLE t"))).toBe("VALIDATION_ERROR");
  });

  it("is not fooled by literals and comments", () => {
    expect(assertReadOnly("SELECT '; DROP TABLE t' FROM x").sql).toContain("DROP");
    expect(assertReadOnly("SELECT 'it''s; fine'").head).toBe("SELECT");
    expect(assertReadOnly("SELECT 'a\\'; b', col FROM t").head).toBe("SELECT");
    expect(assertReadOnly('SELECT "weird;name" FROM t').head).toBe("SELECT");
    expect(assertReadOnly("SELECT $$a; b$$").head).toBe("SELECT");
    expect(assertReadOnly("SELECT 1 -- ; DROP TABLE t").sql).toBe("SELECT 1 -- ; DROP TABLE t");
  });

  it("rejects empty input", () => {
    expect(codeOf(() => assertReadOnly(""))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => assertReadOnly("  -- just a comment"))).toBe("VALIDATION_ERROR");
  });
});

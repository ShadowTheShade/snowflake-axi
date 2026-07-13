import { AxiError } from "axi-sdk-js";
import { describe, expect, it } from "vitest";
import { assertPgReadOnly, assertReadOnly, classifyPgStatement, classifyStatement } from "../src/validate.js";

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

describe("assertPgReadOnly", () => {
  it.each([
    ["SELECT 1", "SELECT"],
    ["WITH x AS (SELECT 1) SELECT * FROM x", "WITH"],
    ["TABLE orders", "TABLE"],
    ["VALUES (1), (2)", "VALUES"],
    ["SHOW server_version", "SHOW"],
    ["EXPLAIN SELECT 1", "EXPLAIN"],
  ])("accepts %s", (sql, head) => {
    expect(assertPgReadOnly(sql).head).toBe(head);
  });

  it.each([
    "UPDATE t SET a = 1",
    "DELETE FROM t",
    "INSERT INTO t VALUES (1)",
    "CREATE TABLE t (a INT)",
    "DROP TABLE t",
    "TRUNCATE t",
    "COPY t FROM stdin",
    "SET default_transaction_read_only = off",
    "VACUUM t",
    "CALL my_proc()",
    "DESC t",
  ])("rejects %s with READ_ONLY", (sql) => {
    expect(codeOf(() => assertPgReadOnly(sql))).toBe("READ_ONLY");
  });

  it("does not treat // as a comment (Postgres has none)", () => {
    // In the Snowflake dialect the // comment would swallow the semicolon.
    expect(assertReadOnly("SELECT a // hide; DROP TABLE t").head).toBe("SELECT");
    expect(codeOf(() => assertPgReadOnly("SELECT a // hide; DROP TABLE t"))).toBe("VALIDATION_ERROR");
  });

  it("tracks tagged dollar quotes", () => {
    expect(assertPgReadOnly("SELECT $tag$ ; DROP TABLE t $tag$").head).toBe("SELECT");
    expect(assertPgReadOnly("SELECT $$ ; still one statement $$").head).toBe("SELECT");
  });

  it("accepts EXPLAIN around read statements in every option spelling", () => {
    expect(assertPgReadOnly("EXPLAIN SELECT 1").head).toBe("EXPLAIN");
    expect(assertPgReadOnly("EXPLAIN ANALYZE VERBOSE SELECT 1").head).toBe("EXPLAIN");
    expect(assertPgReadOnly("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) WITH x AS (SELECT 1) SELECT * FROM x").head).toBe(
      "EXPLAIN",
    );
    expect(assertPgReadOnly("EXPLAIN (FORMAT TEXT) TABLE users").head).toBe("EXPLAIN");
  });

  it.each([
    "EXPLAIN ANALYZE CREATE TABLE t AS SELECT 1",
    "EXPLAIN (ANALYZE) CREATE MATERIALIZED VIEW mv AS SELECT 1",
    "EXPLAIN (ANALYZE, BUFFERS) DELETE FROM t",
    "EXPLAIN VERBOSE INSERT INTO t VALUES (1)",
    "EXPLAIN ANALYZE EXECUTE plan(1)",
  ])("rejects %s: EXPLAIN may only wrap a read statement", (sql) => {
    expect(codeOf(() => assertPgReadOnly(sql))).toBe("READ_ONLY");
  });

  it("rejects multiple statements", () => {
    expect(codeOf(() => assertPgReadOnly("SELECT 1; SELECT 2"))).toBe("VALIDATION_ERROR");
  });
});

describe("classifyStatement", () => {
  it.each([
    ["SELECT 1", "SELECT", "read"],
    ["WITH x AS (SELECT 1) SELECT * FROM x", "WITH", "read"],
    ["SHOW DATABASES", "SHOW", "read"],
    ["DESC TABLE t", "DESC", "read"],
    ["DESCRIBE TABLE t", "DESCRIBE", "read"],
    ["EXPLAIN SELECT 1", "EXPLAIN", "read"],
    ["INSERT INTO t VALUES (1)", "INSERT", "write"],
    ["update t set a = 1", "UPDATE", "write"],
    ["DELETE FROM t", "DELETE", "write"],
    ["MERGE INTO t USING s ON 1=1 WHEN MATCHED THEN DELETE", "MERGE", "write"],
    ["TRUNCATE TABLE t", "TRUNCATE", "write"],
    ["CREATE TABLE t (a INT)", "CREATE", "write"],
    ["DROP TABLE t", "DROP", "write"],
    ["COPY INTO t FROM @stage", "COPY", "write"],
    ["CALL my_proc()", "CALL", "write"],
    ["GRANT SELECT ON t TO ROLE r", "GRANT", "write"],
    ["EXECUTE IMMEDIATE 'DROP TABLE t'", "EXECUTE", "write"],
  ])("classifies %s as %s/%s", (sql, head, kind) => {
    const c = classifyStatement(sql);
    expect(c.head).toBe(head);
    expect(c.kind).toBe(kind);
  });

  it("strips a trailing semicolon", () => {
    expect(classifyStatement("DELETE FROM t;").sql).toBe("DELETE FROM t");
  });

  it("skips a leading // comment when detecting the head", () => {
    expect(classifyStatement("// comment\nDELETE FROM t").kind).toBe("write");
  });

  it("rejects multiple statements", () => {
    expect(codeOf(() => classifyStatement("SELECT 1; SELECT 2"))).toBe("VALIDATION_ERROR");
  });

  it("rejects empty input", () => {
    expect(codeOf(() => classifyStatement("  -- just a comment"))).toBe("VALIDATION_ERROR");
  });

  it("is not fooled by a semicolon inside a literal", () => {
    expect(classifyStatement("UPDATE t SET note = 'a; b' WHERE id = 1").kind).toBe("write");
  });
});

describe("classifyPgStatement", () => {
  it.each([
    ["SELECT 1", "SELECT", "read"],
    ["WITH x AS (SELECT 1) SELECT * FROM x", "WITH", "read"],
    ["TABLE orders", "TABLE", "read"],
    ["VALUES (1)", "VALUES", "read"],
    ["SHOW server_version", "SHOW", "read"],
    ["EXPLAIN SELECT 1", "EXPLAIN", "read"],
    ["EXPLAIN (FORMAT JSON) TABLE users", "EXPLAIN", "read"],
    ["INSERT INTO t VALUES (1)", "INSERT", "write"],
    ["UPDATE t SET a = 1", "UPDATE", "write"],
    ["DELETE FROM t", "DELETE", "write"],
    ["MERGE INTO t USING s ON 1=1 WHEN MATCHED THEN DELETE", "MERGE", "write"],
    ["TRUNCATE t", "TRUNCATE", "write"],
    ["CREATE TABLE t (a int)", "CREATE", "write"],
    ["DROP TABLE t", "DROP", "write"],
    ["ANALYZE t", "ANALYZE", "write"],
    ["VACUUM t", "VACUUM", "write"],
    ["GRANT SELECT ON t TO r", "GRANT", "write"],
    ["COPY t FROM stdin", "COPY", "write"],
  ])("classifies %s as %s/%s", (sql, head, kind) => {
    const c = classifyPgStatement(sql);
    expect(c.head).toBe(head);
    expect(c.kind).toBe(kind);
  });

  it("classifies an EXPLAIN ANALYZE that would execute a write as a write", () => {
    expect(classifyPgStatement("EXPLAIN ANALYZE INSERT INTO t VALUES (1)").kind).toBe("write");
    expect(classifyPgStatement("EXPLAIN (ANALYZE) DELETE FROM t").kind).toBe("write");
    expect(classifyPgStatement("EXPLAIN ANALYZE CREATE TABLE t AS SELECT 1").kind).toBe("write");
  });

  it("keeps EXPLAIN around a read a read", () => {
    expect(classifyPgStatement("EXPLAIN ANALYZE SELECT 1").kind).toBe("read");
  });

  it("rejects multiple statements", () => {
    expect(codeOf(() => classifyPgStatement("SELECT 1; SELECT 2"))).toBe("VALIDATION_ERROR");
  });

  it("tracks tagged dollar quotes so a ; inside is not a second statement", () => {
    expect(classifyPgStatement("UPDATE t SET x = $tag$ a ; b $tag$").kind).toBe("write");
  });
});

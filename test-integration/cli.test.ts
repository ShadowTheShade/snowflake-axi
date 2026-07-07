import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { cli } from "./harness.js";

/**
 * End-to-end tests running the built CLI as a subprocess, the way an agent does.
 * Live tests use only objects every Snowflake account has: GENERATOR table
 * functions, the shared SNOWFLAKE database, INFORMATION_SCHEMA, and SHOW.
 * They are skipped when no credentials are configured, so `npm run
 * test:integration` is safe to run anywhere.
 */

let hasCreds = false;
try {
  loadConfig();
  hasCreds = true;
} catch {
  // No credentials configured; live tests are skipped.
}

describe("offline behaviors (no credentials required)", () => {
  it("bare --help lists commands and exits 0", async () => {
    const { stdout, code } = await cli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("tables");
    expect(stdout).toContain("query");
  });

  it("unknown command exits 2 with a structured error", async () => {
    const { stdout, code } = await cli(["navigate"]);
    expect(code).toBe(2);
    expect(stdout).toContain("Unknown command");
  });

  it("unknown flag exits 2 listing valid flags, before any connection", async () => {
    const { stdout, code } = await cli(["tables", "--stat"]);
    expect(code).toBe(2);
    expect(stdout).toContain("--like");
  });

  it("write SQL is rejected with READ_ONLY before any connection", async () => {
    const { stdout, code } = await cli(["query", "DELETE FROM ANYTHING"]);
    expect(code).toBe(1);
    expect(stdout).toContain("READ_ONLY");
  });

  it("multi-statement SQL is rejected with exit 2", async () => {
    const { stdout, code } = await cli(["query", "SELECT 1; SELECT 2"]);
    expect(code).toBe(2);
    expect(stdout).toContain("Multiple statements");
  });

  it("stray positional arguments are rejected with exit 2, before any connection", async () => {
    const { stdout, code } = await cli(["warehouses", "BOGUS"]);
    expect(code).toBe(2);
    expect(stdout).toContain("VALIDATION_ERROR");
  });
});

describe.skipIf(!hasCreds)("live account (any Snowflake account)", () => {
  it("home view shows connection context and databases", async () => {
    const { stdout, code } = await cli([]);
    expect(code).toBe(0);
    expect(stdout).toContain("connection:");
    expect(stdout).toContain("databases");
  });

  it("query reports definitive partial counts from streamed results", async () => {
    const { stdout, code } = await cli([
      "query",
      "SELECT SEQ4() AS N FROM TABLE(GENERATOR(ROWCOUNT => 120))",
      "--limit",
      "20",
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("count: 20 of 120 total");
    expect(stdout).toContain("--limit");
  });

  it("query reports complete counts when everything fit", async () => {
    const { stdout, code } = await cli(["query", "SELECT SEQ4() AS N FROM TABLE(GENERATOR(ROWCOUNT => 5))"]);
    expect(code).toBe(0);
    expect(stdout).toContain("count: 5 (complete)");
  });

  it("statement timeouts translate to a TIMEOUT error with a --timeout hint", async () => {
    const { stdout, code } = await cli([
      "query",
      "SELECT MAX(RANDOM()) FROM TABLE(GENERATOR(ROWCOUNT => 10000000000))",
      "--timeout",
      "1",
    ]);
    expect(code).toBe(1);
    expect(stdout).toContain("TIMEOUT");
    expect(stdout).toContain("--timeout");
  });

  it("query reports empty results definitively", async () => {
    const { stdout, code } = await cli(["query", "SELECT 1 AS X WHERE 1 = 0"]);
    expect(code).toBe(0);
    expect(stdout).toContain("count: 0 rows");
  });

  it("string cells keep their exact digits while numeric cells render bare", async () => {
    const { stdout, code } = await cli(["query", "SELECT '007' AS CODE, 7.10 AS NUM"]);
    expect(code).toBe(0);
    expect(stdout).toContain("007");
    expect(stdout).toMatch(/7\.1(?!\d)/);
  });

  it("query truncates long cells at 200 chars unless --full", async () => {
    const sql = "SELECT REPEAT('x', 500) AS LONG_CELL";
    const truncated = await cli(["query", sql]);
    expect(truncated.code).toBe(0);
    expect(truncated.stdout).toContain(`${"x".repeat(200)}...`);
    expect(truncated.stdout).toContain("--full");
    const full = await cli(["query", sql, "--full"]);
    expect(full.stdout).toContain("x".repeat(500));
  });

  it("tables at database scope summarizes the shared SNOWFLAKE database", async () => {
    const { stdout, code } = await cli(["tables", "SNOWFLAKE"]);
    expect(code).toBe(0);
    expect(stdout).toContain("database: SNOWFLAKE");
  });

  it("schema describes a universal INFORMATION_SCHEMA view", async () => {
    const { stdout, code } = await cli(["schema", "SNOWFLAKE.INFORMATION_SCHEMA.DATABASES"]);
    expect(code).toBe(0);
    expect(stdout).toContain("columns[");
    expect(stdout).toContain("DATABASE_NAME");
  });

  it("sample projects fields from a universal view", async () => {
    const { stdout, code } = await cli([
      "sample",
      "SNOWFLAKE.INFORMATION_SCHEMA.DATABASES",
      "--limit",
      "2",
      "--fields",
      "DATABASE_NAME",
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("rows[");
    expect(stdout).toContain("DATABASE_NAME");
  });

  it("warehouses lists or reports zero definitively", async () => {
    const { stdout, code } = await cli(["warehouses"]);
    expect(code).toBe(0);
    expect(stdout).toContain("warehouses");
  });

  it("invalid identifier errors carry a schema-lookup suggestion", async () => {
    const { stdout, code } = await cli(["query", "SELECT NO_SUCH_COLUMN FROM SNOWFLAKE.INFORMATION_SCHEMA.DATABASES"]);
    expect(code).toBe(1);
    expect(stdout).toContain("SNOWFLAKE_ERROR");
    expect(stdout).toContain("schema");
  });

  it("missing table errors carry a tables-lookup suggestion", async () => {
    const { stdout, code } = await cli(["query", "SELECT 1 FROM SNOWFLAKE.NO_SCHEMA.NO_TABLE_XYZ"]);
    expect(code).toBe(1);
    expect(stdout).toContain("SNOWFLAKE_ERROR");
    expect(stdout).toContain("tables --like");
  });

  it("listing a nonexistent stage fails with a structured error", async () => {
    const { stdout, code } = await cli(["stage", "@SNOWFLAKE.NO_SCHEMA.NO_STAGE_XYZ"]);
    expect(code).toBe(1);
    expect(stdout).toContain("error:");
  });

  it("a bad token fails with a translated AUTH_ERROR", async () => {
    const { stdout, code } = await cli(["query", "SELECT 1"], { SNOWFLAKE_TOKEN: "not-a-real-token" });
    expect(code).toBe(1);
    expect(stdout).toContain("AUTH_ERROR");
  });
});

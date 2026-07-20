import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const runPgQuery = vi.hoisted(() => vi.fn());
const runPgWrite = vi.hoisted(() => vi.fn());
vi.mock("../src/pg.js", () => ({ runPgQuery, runPgWrite }));

const requireGrant = vi.hoisted(() => vi.fn());
vi.mock("../src/grants.js", () => ({ requireGrant }));

import { AxiError } from "axi-sdk-js";
import { pgCommand } from "../src/commands/pg.js";

beforeAll(() => {
  vi.stubEnv("SNOWFLAKE_AXI_PG_HOST", "pg.example.com");
  vi.stubEnv("SNOWFLAKE_AXI_PG_USER", "svc");
  vi.stubEnv("SNOWFLAKE_AXI_PG_PASSWORD", "pw");
  vi.stubEnv("SNOWFLAKE_AXI_PG_DATABASE", "controlplane");
});

beforeEach(() => {
  runPgQuery.mockReset();
  runPgWrite.mockReset();
  requireGrant.mockReset();
});

function catalogRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: "public", name: "orders", kind: "r", est_rows: "985", bytes: "16384", ...overrides };
}

describe("pg tables", () => {
  it("lists every user schema by default with a connection header", async () => {
    runPgQuery.mockResolvedValueOnce({
      rows: [catalogRow(), catalogRow({ schema: "app", name: "users", est_rows: "-1", bytes: "8192" })],
      complete: true,
      numericColumns: new Set(),
    });
    const output = (await pgCommand.run([])) as Record<string, unknown>;
    expect(runPgQuery.mock.calls[0][0]).toContain("pg_class");
    expect(runPgQuery.mock.calls[0][1]).toEqual({ binds: [] });
    expect(output.connection).toBe("svc@pg.example.com:5432/controlplane (read-only)");
    expect(output.count).toContain("2 tables in controlplane");
    expect(output.tables).toEqual([
      { schema: "public", name: "orders", rows: 985, size: "16KB" },
      { schema: "app", name: "users", rows: "?", size: "8KB" },
    ]);
  });

  it("scopes to a schema and drops the schema column", async () => {
    runPgQuery.mockResolvedValueOnce({ rows: [catalogRow()], complete: true, numericColumns: new Set() });
    const output = (await pgCommand.run(["tables", "public"])) as Record<string, unknown>;
    expect(runPgQuery.mock.calls[0][0]).toContain("lower(n.nspname) = lower($1)");
    expect(runPgQuery.mock.calls[0][1]).toEqual({ binds: ["public"] });
    expect(output.count).toContain("in controlplane.public");
    expect(output.tables).toEqual([{ name: "orders", rows: 985, size: "16KB" }]);
  });

  it("passes --like as a contains pattern bind", async () => {
    runPgQuery.mockResolvedValueOnce({ rows: [], complete: true, numericColumns: new Set() });
    await pgCommand.run(["tables", "--like", "ord"]);
    expect(runPgQuery.mock.calls[0][0]).toContain("c.relname ILIKE $1");
    expect(runPgQuery.mock.calls[0][1]).toEqual({ binds: ["%ord%"] });
  });

  it("hides views by default but counts them in the note", async () => {
    runPgQuery.mockResolvedValueOnce({
      rows: [catalogRow(), catalogRow({ name: "v_orders", kind: "v" })],
      complete: true,
      numericColumns: new Set(),
    });
    const output = (await pgCommand.run([])) as Record<string, unknown>;
    expect(output.count).toContain("(1 views excluded; use --views)");
    expect((output.tables as unknown[]).length).toBe(1);
  });

  it("includes views and matviews with a kind column under --views", async () => {
    runPgQuery.mockResolvedValueOnce({
      rows: [catalogRow(), catalogRow({ name: "mv_daily", kind: "m" })],
      complete: true,
      numericColumns: new Set(),
    });
    const output = (await pgCommand.run(["tables", "--views"])) as Record<string, unknown>;
    expect(output.tables).toEqual([
      { schema: "public", name: "orders", kind: "TABLE", rows: 985, size: "16KB" },
      { schema: "public", name: "mv_daily", kind: "MATVIEW", rows: 985, size: "16KB" },
    ]);
  });

  it("reports empty schemas definitively", async () => {
    runPgQuery.mockResolvedValueOnce({ rows: [], complete: true, numericColumns: new Set() });
    const output = (await pgCommand.run(["tables", "empty_schema"])) as Record<string, unknown>;
    expect(output.count).toBe("0 tables in controlplane.empty_schema");
  });

  it("rejects an invalid schema argument", async () => {
    await expect(pgCommand.run(["tables", "bad name"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runPgQuery).not.toHaveBeenCalled();
  });
});

describe("pg schema", () => {
  const detailsRow = catalogRow({
    columns: [
      { name: "id", type: "bigint", null: "N", default: "nextval('orders_id_seq')" },
      { name: "status", type: "text", null: "Y", default: null },
    ],
    pk: ["id"],
  });

  it("returns columns, pk, and size for a resolved table", async () => {
    runPgQuery.mockResolvedValueOnce({ rows: [detailsRow], complete: true, numericColumns: new Set() });
    const output = (await pgCommand.run(["schema", "ORDERS"])) as Record<string, unknown>;
    expect(runPgQuery.mock.calls[0][0]).toContain("lower(c.relname) = lower($1)");
    expect(runPgQuery.mock.calls[0][1]).toEqual({ binds: ["ORDERS"] });
    expect(output.table).toBe("public.orders");
    expect(output.kind).toBe("TABLE");
    expect(output.pk).toBe("id");
    expect(output.columns).toEqual([
      { name: "id", type: "bigint", null: "N", default: "nextval('orders_id_seq')" },
      { name: "status", type: "text", null: "Y", default: "" },
    ]);
  });

  it("fails loud with candidates when the name is ambiguous", async () => {
    runPgQuery.mockResolvedValueOnce({
      rows: [detailsRow, catalogRow({ schema: "app", columns: [], pk: null })],
      complete: true,
      numericColumns: new Set(),
    });
    await expect(pgCommand.run(["schema", "orders"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("public.orders, app.orders"),
    });
  });

  it("suggests a name search when the table is missing", async () => {
    runPgQuery.mockResolvedValueOnce({ rows: [], complete: true, numericColumns: new Set() });
    await expect(pgCommand.run(["schema", "nope"])).rejects.toMatchObject({
      code: "PG_ERROR",
      suggestions: [expect.stringContaining("pg tables --like nope")],
    });
  });

  it("qualifies the lookup when given schema.table", async () => {
    runPgQuery.mockResolvedValueOnce({ rows: [detailsRow], complete: true, numericColumns: new Set() });
    await pgCommand.run(["schema", "public.orders"]);
    expect(runPgQuery.mock.calls[0][0]).toContain("lower(n.nspname) = lower($2)");
    expect(runPgQuery.mock.calls[0][1]).toEqual({ binds: ["orders", "public"] });
  });
});

describe("pg sample", () => {
  it("resolves the table then selects with quoted identifiers", async () => {
    runPgQuery.mockResolvedValueOnce({ rows: [catalogRow()], complete: true, numericColumns: new Set() });
    runPgQuery.mockResolvedValueOnce({
      rows: [{ id: "1", status: "open" }],
      complete: true,
      numericColumns: new Set(["id"]),
    });
    const output = (await pgCommand.run(["sample", "orders", "--where", "status = 'open'"])) as Record<string, unknown>;
    expect(runPgQuery.mock.calls[1][0]).toBe('SELECT * FROM "public"."orders" WHERE status = \'open\' LIMIT 5');
    expect(output.table).toBe("public.orders");
    expect(output.rows).toEqual([{ id: 1, status: "open" }]);
  });

  it("lowercases and validates --fields", async () => {
    runPgQuery.mockResolvedValueOnce({ rows: [catalogRow()], complete: true, numericColumns: new Set() });
    runPgQuery.mockResolvedValueOnce({ rows: [{ id: "1" }], complete: true, numericColumns: new Set() });
    await pgCommand.run(["sample", "orders", "--fields", "ID, Status"]);
    expect(runPgQuery.mock.calls[1][0]).toContain("SELECT id, status FROM");
  });

  it("rejects invalid --fields before any query", async () => {
    await expect(pgCommand.run(["sample", "orders", "--fields", "a;b"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(runPgQuery).not.toHaveBeenCalled();
  });

  it("reports empty samples definitively", async () => {
    runPgQuery.mockResolvedValueOnce({ rows: [catalogRow()], complete: true, numericColumns: new Set() });
    runPgQuery.mockResolvedValueOnce({ rows: [], complete: true, numericColumns: new Set() });
    const output = (await pgCommand.run(["sample", "orders"])) as Record<string, unknown>;
    expect(output.count).toBe("0 rows in public.orders");
  });
});

describe("pg query", () => {
  it("reads without requiring a grant", async () => {
    runPgQuery.mockResolvedValueOnce({ rows: [{ n: "1" }], complete: true, numericColumns: new Set(["n"]) });
    await pgCommand.run(["query", "SELECT 1 AS n"]);
    expect(requireGrant).not.toHaveBeenCalled();
    expect(runPgWrite).not.toHaveBeenCalled();
  });

  it("passes limit and timeout and reports a definitive complete count", async () => {
    runPgQuery.mockResolvedValueOnce({
      rows: [{ n: "1" }],
      complete: true,
      numericColumns: new Set(["n"]),
    });
    const output = (await pgCommand.run(["query", "SELECT 1 AS n"])) as Record<string, unknown>;
    expect(runPgQuery.mock.calls[0][1]).toEqual({ maxRows: 50, timeoutSeconds: 60 });
    expect(output.count).toBe("1 (complete)");
    expect(output.rows).toEqual([{ n: 1 }]);
    expect(output.help).toBeUndefined();
  });

  it("reports incomplete results honestly with a follow-up hint", async () => {
    runPgQuery.mockResolvedValueOnce({
      rows: [{ n: "1" }, { n: "2" }],
      complete: false,
      numericColumns: new Set(),
    });
    const output = (await pgCommand.run(["query", "SELECT n FROM t", "--limit", "2"])) as Record<string, unknown>;
    expect(output.count).toBe("first 2 rows (more exist)");
    expect((output.help as string[])[0]).toContain("COUNT(*)");
  });

  it("reports empty results definitively", async () => {
    runPgQuery.mockResolvedValueOnce({ rows: [], complete: true, numericColumns: new Set() });
    const output = (await pgCommand.run(["query", "SELECT 1 WHERE false"])) as Record<string, unknown>;
    expect(output.count).toBe("0 rows");
  });

  it("rejects unknown flags before touching the connection", async () => {
    await expect(pgCommand.run(["query", "SELECT 1", "--stat"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(runPgQuery).not.toHaveBeenCalled();
  });

  it("requires the pg.write grant for a write, before touching the connection", async () => {
    requireGrant.mockImplementation(() => {
      throw new AxiError("Write capability 'pg.write' is not granted", "WRITE_NOT_ALLOWED", []);
    });
    await expect(pgCommand.run(["query", "DELETE FROM orders WHERE id = 1"])).rejects.toMatchObject({
      code: "WRITE_NOT_ALLOWED",
    });
    expect(requireGrant).toHaveBeenCalledWith("pg.write");
    expect(runPgWrite).not.toHaveBeenCalled();
    expect(runPgQuery).not.toHaveBeenCalled();
  });

  it("runs a granted DML write and reports the affected count", async () => {
    runPgWrite.mockResolvedValueOnce({ command: "UPDATE", rowCount: 3, rows: [], numericColumns: new Set() });
    const output = (await pgCommand.run(["query", "UPDATE orders SET status = 'shipped' WHERE id < 4"])) as Record<
      string,
      unknown
    >;
    expect(requireGrant).toHaveBeenCalledWith("pg.write");
    expect(runPgWrite.mock.calls[0][0]).toBe("UPDATE orders SET status = 'shipped' WHERE id < 4");
    expect(runPgWrite.mock.calls[0][1]).toEqual({ timeoutSeconds: 60 });
    expect(output.command).toBe("UPDATE");
    expect(output.affected).toBe(3);
    expect(output.returned).toBeUndefined();
    expect(output.elapsed).toMatch(/s$/);
  });

  it("runs a non-DML write like ANALYZE once granted", async () => {
    runPgWrite.mockResolvedValueOnce({ command: "ANALYZE", rowCount: null, rows: [], numericColumns: new Set() });
    const output = (await pgCommand.run(["query", "ANALYZE interco.interco_ar_ap_doc"])) as Record<string, unknown>;
    expect(requireGrant).toHaveBeenCalledWith("pg.write");
    expect(output.command).toBe("ANALYZE");
    expect(output.affected).toBeUndefined();
  });

  it("shows RETURNING rows and coerces numeric columns", async () => {
    runPgWrite.mockResolvedValueOnce({
      command: "INSERT",
      rowCount: 1,
      rows: [{ id: "7", name: "urgent" }],
      numericColumns: new Set(["id"]),
    });
    const output = (await pgCommand.run([
      "query",
      "INSERT INTO tags (name) VALUES ('urgent') RETURNING id, name",
    ])) as Record<string, unknown>;
    expect(output.affected).toBe(1);
    expect(output.returned).toEqual([{ id: 7, name: "urgent" }]);
  });

  it("routes a writing SELECT through the read-write session under --write", async () => {
    runPgWrite.mockResolvedValueOnce({
      command: "SELECT",
      rowCount: 1,
      rows: [{ _refresh_one: "42" }],
      numericColumns: new Set(["_refresh_one"]),
    });
    const output = (await pgCommand.run([
      "query",
      "--write",
      "SELECT dim_ingest._refresh_one('entities', true)",
    ])) as Record<string, unknown>;
    expect(requireGrant).toHaveBeenCalledWith("pg.write");
    expect(runPgQuery).not.toHaveBeenCalled();
    expect(runPgWrite.mock.calls[0][0]).toBe("SELECT dim_ingest._refresh_one('entities', true)");
    expect(output.command).toBe("SELECT");
    expect(output.affected).toBe(1);
    expect(output.returned).toEqual([{ _refresh_one: 42 }]);
  });

  it("routes a data-modifying CTE (WITH) through the read-write session under --write", async () => {
    runPgWrite.mockResolvedValueOnce({
      command: "INSERT",
      rowCount: 2,
      rows: [{ id: "1" }, { id: "2" }],
      numericColumns: new Set(["id"]),
    });
    await pgCommand.run(["query", "--write", "WITH x AS (INSERT INTO t VALUES (1),(2) RETURNING id) SELECT * FROM x"]);
    expect(runPgQuery).not.toHaveBeenCalled();
    expect(runPgWrite).toHaveBeenCalledTimes(1);
  });

  it("gates --write behind pg.write before touching the connection", async () => {
    requireGrant.mockImplementation(() => {
      throw new AxiError("Write capability 'pg.write' is not granted", "WRITE_NOT_ALLOWED", []);
    });
    await expect(pgCommand.run(["query", "--write", "SELECT do_write()"])).rejects.toMatchObject({
      code: "WRITE_NOT_ALLOWED",
    });
    expect(runPgWrite).not.toHaveBeenCalled();
    expect(runPgQuery).not.toHaveBeenCalled();
  });

  it("still reads a plain SELECT without --write, needing no grant", async () => {
    runPgQuery.mockResolvedValueOnce({ rows: [{ n: "1" }], complete: true, numericColumns: new Set(["n"]) });
    await pgCommand.run(["query", "SELECT 1 AS n"]);
    expect(requireGrant).not.toHaveBeenCalled();
    expect(runPgWrite).not.toHaveBeenCalled();
  });
});

describe("pg --database", () => {
  it("overrides the connection database for tables, in the query and the labels", async () => {
    runPgQuery.mockResolvedValueOnce({ rows: [catalogRow()], complete: true, numericColumns: new Set() });
    const output = (await pgCommand.run(["tables", "--database", "dev"])) as Record<string, unknown>;
    expect(runPgQuery.mock.calls[0][1]).toEqual({ binds: [], database: "dev" });
    expect(output.connection).toBe("svc@pg.example.com:5432/dev (read-only)");
    expect(output.count).toContain("in dev");
  });

  it("threads --database through a read query", async () => {
    runPgQuery.mockResolvedValueOnce({ rows: [{ n: "1" }], complete: true, numericColumns: new Set(["n"]) });
    await pgCommand.run(["query", "--database", "prod", "SELECT 1 AS n"]);
    expect(runPgQuery.mock.calls[0][1]).toEqual({ maxRows: 50, timeoutSeconds: 60, database: "prod" });
  });

  it("rejects a non-identifier database before touching the connection", async () => {
    await expect(pgCommand.run(["tables", "--database", "bad name"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(runPgQuery).not.toHaveBeenCalled();
  });
});

describe("pg verb hints", () => {
  it("redirects write verbs to pg query instead of misparsing them", async () => {
    await expect(pgCommand.run(["insert", "into", "t"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "'insert' is not a pg subcommand",
      suggestions: expect.arrayContaining([expect.stringContaining("pg query")]),
    });
    expect(runPgQuery).not.toHaveBeenCalled();
  });

  it("redirects find to tables --like", async () => {
    await expect(pgCommand.run(["find", "orders"])).rejects.toMatchObject({
      suggestions: expect.arrayContaining([expect.stringContaining("pg tables --like")]),
    });
  });
});

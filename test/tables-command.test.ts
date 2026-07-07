import { beforeEach, describe, expect, it, vi } from "vitest";

const runQuery = vi.hoisted(() => vi.fn());
vi.mock("../src/snowflake.js", () => ({ runQuery }));

import { tablesCommand } from "../src/commands/tables.js";

const BASE_ROWS = [
  { NAME: "EVENTS", KIND: "BASE TABLE", ROW_COUNT: "48210332", BYTES: "19549651968" },
  { NAME: "FCT_ORDERS", KIND: "BASE TABLE", ROW_COUNT: "4812093", BYTES: "2040109466" },
  { NAME: "V_SOMETHING", KIND: "VIEW", ROW_COUNT: null, BYTES: null },
];

// No-scope invocations probe the session namespace and optimistically list in
// parallel; this routes the mock by statement instead of call order.
function stubSession(namespace: { DB: string | null; SC: string | null }, tables: Record<string, unknown>[] | null) {
  runQuery.mockImplementation((sql: string) => {
    if (sql.includes("CURRENT_DATABASE() AS DB")) return Promise.resolve({ rows: [namespace], total: 1 });
    if (sql.includes("FROM INFORMATION_SCHEMA.TABLES")) {
      return tables === null
        ? Promise.reject(new Error("This session does not have a current database"))
        : Promise.resolve({ rows: tables, total: tables.length });
    }
    if (sql === "SHOW DATABASES") {
      return Promise.resolve({
        rows: [
          { name: "ANALYTICS_DB", comment: "warehouse models" },
          { name: "RAW_DB", comment: "" },
        ],
        total: 2,
      });
    }
    if (sql.includes("GROUP BY 1")) {
      return Promise.resolve({ rows: [{ NAME: "PUBLIC", TABLES: "47", BYTES: "34482929664" }], total: 1 });
    }
    return Promise.reject(new Error(`unexpected statement: ${sql}`));
  });
}

beforeEach(() => {
  runQuery.mockReset();
});

describe("tables command", () => {
  it("lists default-namespace tables largest first, excluding views with a note", async () => {
    stubSession({ DB: "ANALYTICS_DB", SC: "PUBLIC" }, BASE_ROWS);
    const output = (await tablesCommand.run([])) as Record<string, unknown>;
    expect(output.scope).toBe("ANALYTICS_DB.PUBLIC");
    expect(output.count).toBe("2 tables, largest first (1 views excluded; use --views)");
    expect(output.tables).toEqual([
      { name: "EVENTS", rows: 48210332, size: "18.2GB" },
      { name: "FCT_ORDERS", rows: 4812093, size: "1.9GB" },
    ]);
    const listing = runQuery.mock.calls.find(([sql]) => sql.includes("FROM INFORMATION_SCHEMA.TABLES"));
    expect(listing?.[0]).toContain("TABLE_SCHEMA = CURRENT_SCHEMA()");
    expect(listing?.[1].binds).toEqual([]);
  });

  it("falls back to readable databases when the session has no namespace", async () => {
    stubSession({ DB: null, SC: null }, null);
    const output = (await tablesCommand.run([])) as Record<string, unknown>;
    expect(output.count).toBe("2 databases");
    expect(output.databases).toEqual([{ name: "ANALYTICS_DB", comment: "warehouse models" }, { name: "RAW_DB" }]);
    expect((output.help as string[])[0]).toContain("tables <db>");
  });

  it("falls back to the schema summary when the session has a database but no schema", async () => {
    stubSession({ DB: "ANALYTICS_DB", SC: null }, []);
    const output = (await tablesCommand.run([])) as Record<string, unknown>;
    expect(output.database).toBe("ANALYTICS_DB");
    expect(output.schemas).toEqual([{ name: "PUBLIC", tables: 47, size: "32.1GB" }]);
  });

  it("filters the database fallback with --like and reports empty definitively", async () => {
    stubSession({ DB: null, SC: null }, null);
    const filtered = (await tablesCommand.run(["--like", "raw"])) as Record<string, unknown>;
    expect(filtered.databases).toEqual([{ name: "RAW_DB" }]);
    const none = (await tablesCommand.run(["--like", "nope"])) as Record<string, unknown>;
    expect(none.count).toBe("0 databases matching 'nope' readable with this role");
  });

  it("includes views with a kind column under --views", async () => {
    stubSession({ DB: "ANALYTICS_DB", SC: "PUBLIC" }, BASE_ROWS);
    const output = (await tablesCommand.run(["--views"])) as Record<string, unknown>;
    const tables = output.tables as Record<string, unknown>[];
    expect(tables).toHaveLength(3);
    expect(tables[2]).toEqual({ name: "V_SOMETHING", kind: "VIEW", rows: "", size: "" });
  });

  it("wraps bare --like words as contains patterns", async () => {
    stubSession({ DB: "ANALYTICS_DB", SC: "PUBLIC" }, [BASE_ROWS[1]]);
    await tablesCommand.run(["--like", "fact"]);
    const listing = runQuery.mock.calls.find(([sql]) => sql.includes("FROM INFORMATION_SCHEMA.TABLES"));
    expect(listing?.[1].binds).toEqual(["%fact%"]);
  });

  it("queries an explicit db.schema scope with binds and no probe", async () => {
    runQuery.mockResolvedValueOnce({ rows: BASE_ROWS, total: 3 });
    const output = (await tablesCommand.run(["analytics_db.public"])) as Record<string, unknown>;
    expect(output.scope).toBe("ANALYTICS_DB.PUBLIC");
    expect(runQuery).toHaveBeenCalledTimes(1);
    const [sql, options] = runQuery.mock.calls[0];
    expect(sql).toContain("ANALYTICS_DB.INFORMATION_SCHEMA.TABLES");
    expect(sql).toContain("TABLE_SCHEMA = ?");
    expect(options.binds).toEqual(["PUBLIC"]);
  });

  it("summarizes schemas at database scope", async () => {
    runQuery.mockResolvedValueOnce({
      rows: [{ NAME: "PUBLIC", TABLES: "47", BYTES: "34482929664" }],
      total: 1,
    });
    const output = (await tablesCommand.run(["analytics_db"])) as Record<string, unknown>;
    expect(output.database).toBe("ANALYTICS_DB");
    expect(output.schemas).toEqual([{ name: "PUBLIC", tables: 47, size: "32.1GB" }]);
  });

  it("applies --like to schema names at database scope", async () => {
    runQuery.mockResolvedValueOnce({ rows: [{ NAME: "RAW", TABLES: "3", BYTES: "1024" }], total: 1 });
    const output = (await tablesCommand.run(["analytics_db", "--like", "raw"])) as Record<string, unknown>;
    expect(runQuery.mock.calls[0][0]).toContain("TABLE_SCHEMA ILIKE ?");
    expect(runQuery.mock.calls[0][1].binds).toEqual(["%raw%"]);
    expect(output.schemas).toEqual([{ name: "RAW", tables: 3, size: "1KB" }]);
  });

  it("reports empty schema matches definitively at database scope", async () => {
    runQuery.mockResolvedValueOnce({ rows: [], total: 0 });
    const output = (await tablesCommand.run(["analytics_db", "--like", "nope"])) as Record<string, unknown>;
    expect(output.count).toBe("0 schemas with tables matching '%nope%'");
  });

  it("truncates the schema summary at --limit with a see-all hint", async () => {
    runQuery.mockResolvedValueOnce({
      rows: [
        { NAME: "A", TABLES: "1", BYTES: "2048" },
        { NAME: "B", TABLES: "1", BYTES: "1024" },
      ],
      total: 2,
    });
    const output = (await tablesCommand.run(["analytics_db", "--limit", "1"])) as Record<string, unknown>;
    expect(output.schemas).toHaveLength(1);
    expect((output.help as string[])[0]).toContain("--limit 2");
  });

  it("rejects --views at database scope before querying", async () => {
    await expect(tablesCommand.run(["analytics_db", "--views"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("rejects --views when the session resolves above schema level", async () => {
    stubSession({ DB: null, SC: null }, null);
    await expect(tablesCommand.run(["--views"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("reports empty scopes definitively", async () => {
    stubSession({ DB: "ANALYTICS_DB", SC: "PUBLIC" }, []);
    const output = (await tablesCommand.run(["--like", "nope"])) as Record<string, unknown>;
    expect(output.count).toBe("0 tables matching '%nope%' in ANALYTICS_DB.PUBLIC");
  });

  it("rejects malformed scopes", async () => {
    await expect(tablesCommand.run(["a.b.c"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(tablesCommand.run(["bad-name"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runQuery).not.toHaveBeenCalled();
  });
});

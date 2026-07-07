import { beforeEach, describe, expect, it, vi } from "vitest";

const runQuery = vi.hoisted(() => vi.fn());
const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("../src/snowflake.js", () => ({ runQuery }));
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadConfig,
  envFilePath: () => "/tmp/env",
}));

import { tablesCommand } from "../src/commands/tables.js";

const BASE_ROWS = [
  { NAME: "EVENTS", KIND: "BASE TABLE", ROW_COUNT: "48210332", BYTES: "19549651968" },
  { NAME: "FCT_ORDERS", KIND: "BASE TABLE", ROW_COUNT: "4812093", BYTES: "2040109466" },
  { NAME: "V_SOMETHING", KIND: "VIEW", ROW_COUNT: null, BYTES: null },
];

beforeEach(() => {
  runQuery.mockReset();
  loadConfig.mockReset();
  loadConfig.mockReturnValue({ database: "ANALYTICS_DB", schema: "PUBLIC", modelDirs: [] });
});

describe("tables command", () => {
  it("falls back to readable databases when no scope and no default exist", async () => {
    loadConfig.mockReturnValue({ modelDirs: [] });
    runQuery.mockResolvedValueOnce({
      rows: [
        { name: "ANALYTICS_DB", comment: "warehouse models" },
        { name: "RAW_DB", comment: "" },
      ],
      total: 2,
    });
    const output = (await tablesCommand.run([])) as Record<string, unknown>;
    expect(runQuery.mock.calls[0][0]).toBe("SHOW DATABASES");
    expect(output.count).toBe("2 databases");
    expect(output.databases).toEqual([{ name: "ANALYTICS_DB", comment: "warehouse models" }, { name: "RAW_DB" }]);
    expect((output.help as string[])[0]).toContain("tables <db>");
  });

  it("filters the database fallback with --like and reports empty definitively", async () => {
    loadConfig.mockReturnValue({ modelDirs: [] });
    runQuery.mockResolvedValue({ rows: [{ name: "ANALYTICS_DB" }, { name: "RAW_DB" }], total: 2 });
    const filtered = (await tablesCommand.run(["--like", "raw"])) as Record<string, unknown>;
    expect(filtered.databases).toEqual([{ name: "RAW_DB" }]);
    const none = (await tablesCommand.run(["--like", "nope"])) as Record<string, unknown>;
    expect(none.count).toBe("0 databases matching 'nope' readable with this role");
  });

  it("lists default-scope tables largest first, excluding views with a note", async () => {
    runQuery.mockResolvedValueOnce({ rows: BASE_ROWS, total: 3 });
    const output = (await tablesCommand.run([])) as Record<string, unknown>;
    expect(output.scope).toBe("ANALYTICS_DB.PUBLIC");
    expect(output.count).toBe("2 tables, largest first (1 views excluded; use --views)");
    expect(output.tables).toEqual([
      { name: "EVENTS", rows: 48210332, size: "18.2GB" },
      { name: "FCT_ORDERS", rows: 4812093, size: "1.9GB" },
    ]);
    const [sql, options] = runQuery.mock.calls[0];
    expect(sql).toContain("ANALYTICS_DB.INFORMATION_SCHEMA.TABLES");
    expect(options.binds).toEqual(["PUBLIC"]);
  });

  it("includes views with a kind column under --views", async () => {
    runQuery.mockResolvedValueOnce({ rows: BASE_ROWS, total: 3 });
    const output = (await tablesCommand.run(["--views"])) as Record<string, unknown>;
    const tables = output.tables as Record<string, unknown>[];
    expect(tables).toHaveLength(3);
    expect(tables[2]).toEqual({ name: "V_SOMETHING", kind: "VIEW", rows: "", size: "" });
  });

  it("wraps bare --like words as contains patterns", async () => {
    runQuery.mockResolvedValueOnce({ rows: [BASE_ROWS[1]], total: 1 });
    await tablesCommand.run(["--like", "fact"]);
    expect(runQuery.mock.calls[0][1].binds).toEqual(["PUBLIC", "%fact%"]);
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

  it("reports empty scopes definitively", async () => {
    runQuery.mockResolvedValueOnce({ rows: [], total: 0 });
    const output = (await tablesCommand.run(["--like", "nope"])) as Record<string, unknown>;
    expect(output.count).toBe("0 tables matching '%nope%' in ANALYTICS_DB.PUBLIC");
  });

  it("rejects malformed scopes", async () => {
    await expect(tablesCommand.run(["a.b.c"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(tablesCommand.run(["bad-name"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runQuery).not.toHaveBeenCalled();
  });
});

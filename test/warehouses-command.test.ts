import { beforeEach, describe, expect, it, vi } from "vitest";

const runQuery = vi.hoisted(() => vi.fn());
const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("../src/snowflake.js", () => ({ runQuery }));
vi.mock("../src/config.js", () => ({ loadConfig, envFilePath: () => "/tmp/env" }));

import { warehousesCommand } from "../src/commands/warehouses.js";

beforeEach(() => {
  runQuery.mockReset();
  loadConfig.mockReset();
  loadConfig.mockReturnValue({ modelDirs: [] });
});

describe("warehouses command", () => {
  it("rejects stray arguments before touching the connection", async () => {
    await expect(warehousesCommand.run(["BOGUS"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("reads metering from the shared SNOWFLAKE database, no config needed", async () => {
    runQuery.mockImplementation(async (sql: string) =>
      sql.includes("SHOW WAREHOUSES")
        ? { rows: [{ name: "DEV_WH", size: "X-Small", state: "SUSPENDED", comment: "Dev warehouse" }], total: 1 }
        : { rows: [{ WAREHOUSE_NAME: "DEV_WH", CREDITS: "1.25" }], total: 1 },
    );
    const output = (await warehousesCommand.run([])) as Record<string, unknown>;
    expect(output.count).toBe("1 warehouses");
    const metering = runQuery.mock.calls.find(([sql]) => sql.includes("WAREHOUSE_METERING_HISTORY"));
    expect(metering?.[0]).toContain("SNOWFLAKE.INFORMATION_SCHEMA.WAREHOUSE_METERING_HISTORY");
    expect(output.warehouses).toEqual([
      { name: "DEV_WH", size: "X-Small", state: "SUSPENDED", comment: "Dev warehouse", credits_7d: 1.3 },
    ]);
  });

  it("blames the role only when the metering query actually fails", async () => {
    loadConfig.mockReturnValue({ database: "SCOOPS_DB", modelDirs: [] });
    runQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SHOW WAREHOUSES")) {
        return { rows: [{ name: "DEV_WH", size: "X-Small", state: "SUSPENDED", comment: "" }], total: 1 };
      }
      throw new Error("not authorized");
    });
    const output = (await warehousesCommand.run([])) as Record<string, unknown>;
    expect(output.note).toContain("failed for this role");
  });

  it("never fabricates zeros when metering comes back empty (ambiguous with missing MONITOR)", async () => {
    loadConfig.mockReturnValue({ database: "SCOOPS_DB", modelDirs: [] });
    runQuery.mockImplementation(async (sql: string) =>
      sql.includes("SHOW WAREHOUSES")
        ? { rows: [{ name: "DEV_WH", size: "X-Small", state: "SUSPENDED", comment: "" }], total: 1 }
        : { rows: [], total: 0 },
    );
    const output = (await warehousesCommand.run([])) as Record<string, unknown>;
    expect(output.note).toContain("credits_7d omitted");
    expect((output.warehouses as Record<string, unknown>[])[0].credits_7d).toBeUndefined();
  });

  it("shows trustworthy zeros for idle warehouses once metering rows are visible", async () => {
    loadConfig.mockReturnValue({ database: "SCOOPS_DB", modelDirs: [] });
    runQuery.mockImplementation(async (sql: string) =>
      sql.includes("SHOW WAREHOUSES")
        ? {
            rows: [
              { name: "BUSY_WH", size: "Medium", state: "STARTED", comment: "" },
              { name: "IDLE_WH", size: "X-Small", state: "SUSPENDED", comment: "" },
            ],
            total: 2,
          }
        : { rows: [{ WAREHOUSE_NAME: "BUSY_WH", CREDITS: "12.34" }], total: 1 },
    );
    const output = (await warehousesCommand.run([])) as Record<string, unknown>;
    const warehouses = output.warehouses as Record<string, unknown>[];
    expect(output.note).toBeUndefined();
    expect(warehouses[0].credits_7d).toBe(12.3);
    expect(warehouses[1].credits_7d).toBe(0);
  });

  it("truncates long comments with a --full hint, lifted by --full", async () => {
    const long = "x".repeat(150);
    runQuery.mockResolvedValue({
      rows: [{ name: "DEV_WH", size: "X-Small", state: "SUSPENDED", comment: long }],
      total: 1,
    });
    const truncated = (await warehousesCommand.run([])) as Record<string, unknown>;
    expect((truncated.warehouses as Record<string, unknown>[])[0].comment).toBe(`${"x".repeat(100)}...`);
    expect((truncated.help as string[])[0]).toContain("--full");
    const full = (await warehousesCommand.run(["--full"])) as Record<string, unknown>;
    expect((full.warehouses as Record<string, unknown>[])[0].comment).toBe(long);
    expect(full.help).toBeUndefined();
  });
});

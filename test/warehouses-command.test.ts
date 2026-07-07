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

  it("lists warehouses with a note when metering history is unavailable", async () => {
    runQuery.mockResolvedValueOnce({
      rows: [{ name: "DEV_WH", size: "X-Small", state: "SUSPENDED", comment: "Dev warehouse" }],
      total: 1,
    });
    const output = (await warehousesCommand.run([])) as Record<string, unknown>;
    expect(output.count).toBe("1 warehouses");
    expect(output.note).toContain("credits_7d omitted");
    expect(output.warehouses).toEqual([
      { name: "DEV_WH", size: "X-Small", state: "SUSPENDED", comment: "Dev warehouse" },
    ]);
  });
});

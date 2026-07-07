import { beforeEach, describe, expect, it, vi } from "vitest";

const runQuery = vi.hoisted(() => vi.fn());
const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("../src/snowflake.js", () => ({ runQuery }));
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadConfig,
  envFilePath: () => "/tmp/env",
}));

import { schemaCommand } from "../src/commands/schema.js";

beforeEach(() => {
  runQuery.mockReset();
  loadConfig.mockReset();
  loadConfig.mockReturnValue({ database: "ANALYTICS_DB", schema: "PUBLIC", modelDirs: [] });
});

describe("schema command", () => {
  it("passes column types through verbatim, commas included", async () => {
    runQuery.mockImplementation(async (sql: string) =>
      sql.startsWith("DESC")
        ? { rows: [{ name: "AMT", type: "NUMBER(38,2)", "null?": "Y" }], total: 1 }
        : { rows: [{ TABLE_TYPE: "BASE TABLE", ROW_COUNT: "12", BYTES: "1024" }], total: 1 },
    );
    const output = (await schemaCommand.run(["fct_orders"])) as Record<string, unknown>;
    expect(output.columns).toEqual([{ name: "AMT", type: "NUMBER(38,2)", null: "Y" }]);
    expect(output.rows).toBe(12);
    expect(output.size).toBe("1KB");
  });

  it("takes exactly one table name", async () => {
    await expect(schemaCommand.run([])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runQuery).not.toHaveBeenCalled();
  });
});

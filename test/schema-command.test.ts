import { beforeEach, describe, expect, it, vi } from "vitest";

const runQuery = vi.hoisted(() => vi.fn());
vi.mock("../src/snowflake.js", () => ({ runQuery }));

import { schemaCommand } from "../src/commands/schema.js";

beforeEach(() => {
  runQuery.mockReset();
  runQuery.mockImplementation(async (sql: string) =>
    sql.startsWith("DESC")
      ? { rows: [{ name: "AMT", type: "NUMBER(38,2)", "null?": "Y" }], total: 1 }
      : { rows: [{ TABLE_TYPE: "BASE TABLE", ROW_COUNT: "12", BYTES: "1024" }], total: 1 },
  );
});

describe("schema command", () => {
  it("passes column types through verbatim, commas included", async () => {
    const output = (await schemaCommand.run(["fct_orders"])) as Record<string, unknown>;
    expect(output.columns).toEqual([{ name: "AMT", type: "NUMBER(38,2)", null: "Y" }]);
    expect(output.rows).toBe(12);
    expect(output.size).toBe("1KB");
  });

  it("lets the session resolve unqualified names", async () => {
    await schemaCommand.run(["fct_orders"]);
    const [desc] = runQuery.mock.calls[0];
    const [meta, options] = runQuery.mock.calls[1];
    expect(desc).toBe("DESC TABLE FCT_ORDERS");
    expect(meta).toContain("FROM INFORMATION_SCHEMA.TABLES");
    expect(meta).toContain("TABLE_SCHEMA = CURRENT_SCHEMA()");
    expect(options.binds).toEqual(["FCT_ORDERS"]);
  });

  it("scopes the metadata lookup for qualified names", async () => {
    await schemaCommand.run(["other_db.sales.fct_daily"]);
    const [meta, options] = runQuery.mock.calls[1];
    expect(meta).toContain("FROM OTHER_DB.INFORMATION_SCHEMA.TABLES");
    expect(meta).toContain("TABLE_SCHEMA = ?");
    expect(options.binds).toEqual(["SALES", "FCT_DAILY"]);
  });

  it("takes exactly one table name", async () => {
    await expect(schemaCommand.run([])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runQuery).not.toHaveBeenCalled();
  });
});

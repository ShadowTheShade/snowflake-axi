import { beforeEach, describe, expect, it, vi } from "vitest";

const runQuery = vi.hoisted(() => vi.fn());
vi.mock("../src/snowflake.js", () => ({ runQuery }));

import { sampleCommand } from "../src/commands/sample.js";

beforeEach(() => {
  runQuery.mockReset();
});

describe("sample command", () => {
  it("builds a projected, filtered, limited SELECT resolved by the session", async () => {
    runQuery.mockResolvedValueOnce({ rows: [{ PERIOD: "2026-05-31" }], total: 1 });
    await sampleCommand.run(["fct_orders", "--fields", "period", "--where", "STATUS = 'Active'", "--limit", "3"]);
    expect(runQuery.mock.calls[0][0]).toBe("SELECT PERIOD FROM FCT_ORDERS WHERE STATUS = 'Active' LIMIT 3");
  });

  it("keeps explicit qualification intact", async () => {
    runQuery.mockResolvedValueOnce({ rows: [{ A: "1" }], total: 1 });
    await sampleCommand.run(["analytics_db.public.fct_orders", "--limit", "1"]);
    expect(runQuery.mock.calls[0][0]).toBe("SELECT * FROM ANALYTICS_DB.PUBLIC.FCT_ORDERS LIMIT 1");
  });

  it("rejects invalid field names before querying", async () => {
    await expect(sampleCommand.run(["t", "--fields", "a,b c"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("rejects a --where that breaks out of the statement", async () => {
    await expect(sampleCommand.run(["t", "--where", "1=1; DROP TABLE t"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("reports empty results definitively", async () => {
    runQuery.mockResolvedValueOnce({ rows: [], total: 0 });
    const output = (await sampleCommand.run(["fct_orders"])) as Record<string, unknown>;
    expect(output.count).toBe("0 rows in FCT_ORDERS");
  });
});

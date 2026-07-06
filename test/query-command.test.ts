import { beforeEach, describe, expect, it, vi } from "vitest";
import { AxiError } from "axi-sdk-js";

const runQuery = vi.hoisted(() => vi.fn());
vi.mock("../src/snowflake.js", () => ({ runQuery }));

import { queryCommand } from "../src/commands/query.js";

beforeEach(() => {
  runQuery.mockReset();
});

describe("query command", () => {
  it("rejects write SQL before touching the connection", async () => {
    await expect(queryCommand.run(["DELETE FROM FCT_ORDERS"])).rejects.toMatchObject({ code: "READ_ONLY" });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("rejects unknown flags before touching the connection", async () => {
    await expect(queryCommand.run(["SELECT 1", "--stat"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("sets the statement timeout and reports a definitive complete count", async () => {
    runQuery
      .mockResolvedValueOnce({ rows: [], total: 1 })
      .mockResolvedValueOnce({ rows: [{ A: "1", B: "x" }], total: 1 });
    const output = (await queryCommand.run(["SELECT 1"])) as Record<string, unknown>;
    expect(runQuery.mock.calls[0][0]).toBe("ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = 60");
    expect(runQuery.mock.calls[1][1]).toEqual({ maxRows: 50 });
    expect(output.count).toBe("1 (complete)");
    expect(output.rows).toEqual([{ A: 1, B: "x" }]);
    expect(output.help).toBeUndefined();
  });

  it("reports partial counts with a raise-limit hint", async () => {
    runQuery
      .mockResolvedValueOnce({ rows: [], total: 1 })
      .mockResolvedValueOnce({ rows: [{ A: "1" }, { A: "2" }], total: 84 });
    const output = (await queryCommand.run(["SELECT 1", "--limit", "2"])) as Record<string, unknown>;
    expect(output.count).toBe("2 of 84 total");
    expect((output.help as string[])[0]).toContain("--limit 84");
  });

  it("reports empty results definitively", async () => {
    runQuery.mockResolvedValueOnce({ rows: [], total: 1 }).mockResolvedValueOnce({ rows: [], total: 0 });
    const output = (await queryCommand.run(["SELECT 1 WHERE 1=0"])) as Record<string, unknown>;
    expect(output.count).toBe("0 rows");
    expect(output.rows).toBeUndefined();
  });

  it("joins multiple positionals into one SQL string", async () => {
    runQuery.mockResolvedValueOnce({ rows: [], total: 1 }).mockResolvedValueOnce({ rows: [], total: 0 });
    await queryCommand.run(["SELECT", "1"]);
    expect(runQuery.mock.calls[1][0]).toBe("SELECT 1");
  });

  it("requires SQL", async () => {
    await expect(queryCommand.run([])).rejects.toBeInstanceOf(AxiError);
  });
});

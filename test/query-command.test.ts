import { AxiError } from "axi-sdk-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runQuery = vi.hoisted(() => vi.fn());
const submitAsync = vi.hoisted(() => vi.fn());
vi.mock("../src/snowflake.js", () => ({ runQuery, submitAsync }));

const requireGrant = vi.hoisted(() => vi.fn());
vi.mock("../src/grants.js", () => ({ requireGrant }));

import { queryCommand } from "../src/commands/query.js";

beforeEach(() => {
  runQuery.mockReset();
  submitAsync.mockReset();
  requireGrant.mockReset();
});

describe("query command", () => {
  it("reads without requiring a grant", async () => {
    runQuery.mockResolvedValueOnce({ rows: [{ A: "1" }], total: 1, numericColumns: new Set(["A"]) });
    await queryCommand.run(["SELECT 1 AS A"]);
    expect(requireGrant).not.toHaveBeenCalled();
  });

  it("requires the sql.write grant for a write, before touching the connection", async () => {
    requireGrant.mockImplementation(() => {
      throw new AxiError("Write capability 'sql.write' is not granted", "WRITE_NOT_ALLOWED", []);
    });
    await expect(queryCommand.run(["DELETE FROM FCT_ORDERS"])).rejects.toMatchObject({ code: "WRITE_NOT_ALLOWED" });
    expect(requireGrant).toHaveBeenCalledWith("sql.write");
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("runs a granted write and surfaces the count row inline as result", async () => {
    runQuery.mockResolvedValueOnce({
      rows: [{ "number of rows deleted": "3" }],
      total: 1,
      numericColumns: new Set(["number of rows deleted"]),
    });
    const output = (await queryCommand.run(["DELETE FROM FCT_ORDERS WHERE ID < 4"])) as Record<string, unknown>;
    expect(requireGrant).toHaveBeenCalledWith("sql.write");
    expect(output.result).toEqual({ "number of rows deleted": 3 });
    expect(output.count).toBeUndefined();
  });

  it("rejects unknown flags before touching the connection", async () => {
    await expect(queryCommand.run(["SELECT 1", "--stat"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("passes the statement timeout and reports a definitive complete count", async () => {
    runQuery.mockResolvedValueOnce({ rows: [{ A: "1", B: "x" }], total: 1, numericColumns: new Set(["A"]) });
    const output = (await queryCommand.run(["SELECT 1"])) as Record<string, unknown>;
    expect(runQuery.mock.calls[0][1]).toEqual({
      maxRows: 50,
      timeoutSeconds: 60,
      warehouse: undefined,
      role: undefined,
    });
    expect(output.count).toBe("1 (complete)");
    expect(output.rows).toEqual([{ A: 1, B: "x" }]);
    expect(output.help).toBeUndefined();
  });

  it("defaults a write to a 300s timeout and a COPY to 900s", async () => {
    runQuery.mockResolvedValue({ rows: [], total: 0 });
    await queryCommand.run(["DELETE FROM FCT_ORDERS WHERE ID = 1"]);
    expect(runQuery.mock.calls[0][1]).toMatchObject({ timeoutSeconds: 300 });

    runQuery.mockClear();
    await queryCommand.run(["COPY INTO @STG FROM (SELECT * FROM T)"]);
    expect(runQuery.mock.calls[0][1]).toMatchObject({ timeoutSeconds: 900 });
  });

  it("honors an explicit --timeout over the per-kind default", async () => {
    runQuery.mockResolvedValue({ rows: [], total: 0 });
    await queryCommand.run(["COPY INTO @STG FROM (SELECT * FROM T)", "--timeout", "120"]);
    expect(runQuery.mock.calls[0][1]).toMatchObject({ timeoutSeconds: 120 });
  });

  it("passes a one-off role switch through to the query", async () => {
    runQuery.mockResolvedValueOnce({ rows: [], total: 0 });
    await queryCommand.run(["SELECT 1", "--role", "OTHER_ROLE"]);
    expect(runQuery.mock.calls[0][1]).toMatchObject({ role: "OTHER_ROLE" });
  });

  it("keeps leading-zero strings intact for non-numeric columns", async () => {
    runQuery.mockResolvedValueOnce({ rows: [{ CODE: "007" }], total: 1, numericColumns: new Set() });
    const output = (await queryCommand.run(["SELECT '007' AS CODE"])) as Record<string, unknown>;
    expect(output.rows).toEqual([{ CODE: "007" }]);
  });

  it("reports partial counts with a raise-limit hint", async () => {
    runQuery.mockResolvedValueOnce({ rows: [{ A: "1" }, { A: "2" }], total: 84 });
    const output = (await queryCommand.run(["SELECT 1", "--limit", "2"])) as Record<string, unknown>;
    expect(output.count).toBe("2 of 84 total");
    expect((output.help as string[])[0]).toContain("--limit 84");
  });

  it("reports empty results definitively", async () => {
    runQuery.mockResolvedValueOnce({ rows: [], total: 0 });
    const output = (await queryCommand.run(["SELECT 1 WHERE 1=0"])) as Record<string, unknown>;
    expect(output.count).toBe("0 rows");
    expect(output.rows).toBeUndefined();
  });

  it("joins multiple positionals into one SQL string", async () => {
    runQuery.mockResolvedValueOnce({ rows: [], total: 0 });
    await queryCommand.run(["SELECT", "1"]);
    expect(runQuery.mock.calls[0][0]).toBe("SELECT 1");
  });

  it("requires SQL", async () => {
    await expect(queryCommand.run([])).rejects.toBeInstanceOf(AxiError);
  });

  it("--async returns a running handle without blocking", async () => {
    submitAsync.mockResolvedValueOnce({ running: true, handle: "01b6-abc" });
    const output = (await queryCommand.run(["SELECT COUNT(*) FROM BIG", "--async"])) as Record<string, unknown>;
    expect(runQuery).not.toHaveBeenCalled();
    expect(output.status).toBe("running");
    expect(output.handle).toBe("01b6-abc");
    expect((output.help as string[])[0]).toContain("result 01b6-abc");
  });

  it("--async returns rows directly when the statement finishes in the window", async () => {
    submitAsync.mockResolvedValueOnce({ rows: [{ N: "5" }], total: 1, numericColumns: new Set(["N"]) });
    const output = (await queryCommand.run(["SELECT COUNT(*) AS N FROM T", "--async"])) as Record<string, unknown>;
    expect(output.count).toBe("1 (complete)");
    expect(output.rows).toEqual([{ N: 5 }]);
    expect(output.handle).toBeUndefined();
  });

  it("--async still gates a write behind sql.write before submitting", async () => {
    requireGrant.mockImplementation(() => {
      throw new AxiError("Write capability 'sql.write' is not granted", "WRITE_NOT_ALLOWED", []);
    });
    await expect(queryCommand.run(["COPY INTO @STG FROM BIG", "--async"])).rejects.toMatchObject({
      code: "WRITE_NOT_ALLOWED",
    });
    expect(submitAsync).not.toHaveBeenCalled();
  });
});

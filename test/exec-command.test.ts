import { AxiError } from "axi-sdk-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runQuery = vi.hoisted(() => vi.fn());
vi.mock("../src/snowflake.js", () => ({ runQuery }));

const requireGrant = vi.hoisted(() => vi.fn());
vi.mock("../src/grants.js", () => ({ requireGrant }));

import { execCommand } from "../src/commands/exec.js";

beforeEach(() => {
  runQuery.mockReset();
  requireGrant.mockReset();
});

describe("exec command", () => {
  it("requires the sql.write grant before touching the connection", async () => {
    requireGrant.mockImplementation(() => {
      throw new AxiError("Write capability 'sql.write' is not granted", "WRITE_NOT_ALLOWED", []);
    });
    await expect(execCommand.run(["DELETE FROM FCT_ORDERS WHERE ID = 1"])).rejects.toMatchObject({
      code: "WRITE_NOT_ALLOWED",
    });
    expect(requireGrant).toHaveBeenCalledWith("sql.write");
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("rejects a read statement, pointing at query", async () => {
    await expect(execCommand.run(["SELECT 1"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("read statement"),
    });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("rejects EXECUTE IMMEDIATE and other unsupported heads", async () => {
    await expect(execCommand.run(["EXECUTE IMMEDIATE 'DROP TABLE t'"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("surfaces a single DML count row inline as result", async () => {
    runQuery.mockResolvedValueOnce({
      rows: [{ "number of rows deleted": "5" }],
      total: 1,
      numericColumns: new Set(["number of rows deleted"]),
    });
    const output = (await execCommand.run(["DELETE FROM FCT_ORDERS WHERE ID < 6"])) as Record<string, unknown>;
    expect(runQuery.mock.calls[0][0]).toBe("DELETE FROM FCT_ORDERS WHERE ID < 6");
    expect(runQuery.mock.calls[0][1]).toEqual({
      maxRows: 50,
      timeoutSeconds: 60,
      warehouse: undefined,
      role: undefined,
    });
    expect(output.result).toEqual({ "number of rows deleted": 5 });
    expect(output.count).toBeUndefined();
    expect(output.elapsed).toMatch(/s$/);
  });

  it("surfaces a DDL status row inline as result", async () => {
    runQuery.mockResolvedValueOnce({
      rows: [{ status: "Table T successfully created." }],
      total: 1,
      numericColumns: new Set(),
    });
    const output = (await execCommand.run(["CREATE TABLE T (A INT)"])) as Record<string, unknown>;
    expect(output.result).toEqual({ status: "Table T successfully created." });
  });

  it("reports many rows (COPY/CALL) with a definitive count", async () => {
    runQuery.mockResolvedValueOnce({
      rows: [
        { file: "a.csv", status: "LOADED" },
        { file: "b.csv", status: "LOADED" },
      ],
      total: 2,
      numericColumns: new Set(),
    });
    const output = (await execCommand.run(["COPY INTO T FROM @MY_STAGE"])) as Record<string, unknown>;
    expect(output.result).toBeUndefined();
    expect(output.count).toBe("2 (complete)");
    expect(output.rows).toEqual([
      { file: "a.csv", status: "LOADED" },
      { file: "b.csv", status: "LOADED" },
    ]);
  });

  it("reports a no-row write as ok", async () => {
    runQuery.mockResolvedValueOnce({ rows: [], total: 0, numericColumns: new Set() });
    const output = (await execCommand.run(["ALTER TABLE T ADD COLUMN B INT"])) as Record<string, unknown>;
    expect(output.status).toBe("ok");
  });

  it("passes a one-off warehouse and role through", async () => {
    runQuery.mockResolvedValueOnce({ rows: [], total: 0, numericColumns: new Set() });
    await execCommand.run(["TRUNCATE TABLE T", "--warehouse", "WH_X", "--role", "LOADER"]);
    expect(runQuery.mock.calls[0][1]).toMatchObject({ warehouse: "WH_X", role: "LOADER" });
  });

  it("rejects unknown flags before touching the connection", async () => {
    await expect(execCommand.run(["DELETE FROM T", "--stat"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("fails loud when no SQL is provided", async () => {
    await expect(execCommand.run([])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runQuery).not.toHaveBeenCalled();
  });
});

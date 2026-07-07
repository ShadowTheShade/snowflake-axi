import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchStatementResult = vi.hoisted(() => vi.fn());
vi.mock("../src/snowflake.js", () => ({ fetchStatementResult }));

import { resultCommand } from "../src/commands/result.js";

const HANDLE = "01b66701-0000-23c5-0000-45a100012345";

beforeEach(() => {
  fetchStatementResult.mockReset();
});

describe("result command", () => {
  it("rejects malformed handles before touching the connection", async () => {
    await expect(resultCommand.run(["not a handle"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(resultCommand.run([])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetchStatementResult).not.toHaveBeenCalled();
  });

  it("collects a completed statement's rows like query does", async () => {
    fetchStatementResult.mockResolvedValueOnce({
      rows: [{ A: "1" }],
      total: 1,
      numericColumns: new Set(["A"]),
    });
    const output = (await resultCommand.run([HANDLE, "--limit", "10"])) as Record<string, unknown>;
    expect(fetchStatementResult).toHaveBeenCalledWith(HANDLE, { maxRows: 10 });
    expect(output.handle).toBe(HANDLE);
    expect(output.count).toBe("1 (complete)");
    expect(output.rows).toEqual([{ A: 1 }]);
  });

  it("reports a still-running statement definitively with a retry hint", async () => {
    fetchStatementResult.mockResolvedValueOnce({ running: true, handle: HANDLE });
    const output = (await resultCommand.run([HANDLE])) as Record<string, unknown>;
    expect(output.status).toBe("still running");
    expect((output.help as string[])[0]).toContain(`result ${HANDLE}`);
  });
});

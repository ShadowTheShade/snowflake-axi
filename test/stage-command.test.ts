import { beforeEach, describe, expect, it, vi } from "vitest";

const runQuery = vi.hoisted(() => vi.fn());
const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("../src/snowflake.js", () => ({ runQuery }));
vi.mock("../src/config.js", () => ({ loadConfig, envFilePath: () => "/tmp/env" }));

import { stageCommand } from "../src/commands/stage.js";

beforeEach(() => {
  runQuery.mockReset();
  loadConfig.mockReset();
  loadConfig.mockReturnValue({ modelDirs: [], defaultFileFormat: "DB.S.PARQUET_FORMAT" });
});

describe("stage command", () => {
  it("rejects extra positionals on list before touching the connection", async () => {
    await expect(stageCommand.run(["@DB.S.STG", "@DB.S.OTHER"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("rejects extra positionals on read before touching the connection", async () => {
    await expect(stageCommand.run(["read", "@DB.S.STG/f.parquet", "extra"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("rejects invalid stage paths with usage guidance", async () => {
    await expect(stageCommand.run(["not-a-stage"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runQuery).not.toHaveBeenCalled();
  });

  const files = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ name: `stg/f${i}.parquet`, size: 1024, last_modified: "2026-01-01" }));

  it("leads the count with shown-of-total when the listing is truncated", async () => {
    runQuery.mockResolvedValueOnce({ rows: files(3) });
    const output = (await stageCommand.run(["@DB.S.STG", "--limit", "2"])) as Record<string, unknown>;
    expect(output.count).toBe("2 of 3 files shown, 3KB total");
    expect((output.files as unknown[]).length).toBe(2);
    expect((output.help as string[])[0]).toContain("--limit 3");
  });

  it("reports a plain total when nothing is truncated", async () => {
    runQuery.mockResolvedValueOnce({ rows: files(3) });
    const output = (await stageCommand.run(["@DB.S.STG"])) as Record<string, unknown>;
    expect(output.count).toBe("3 files, 3KB total");
  });
});

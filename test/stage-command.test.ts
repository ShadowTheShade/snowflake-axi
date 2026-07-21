import { beforeEach, describe, expect, it, vi } from "vitest";

const runQuery = vi.hoisted(() => vi.fn());
const loadConfig = vi.hoisted(() => vi.fn());
const requireGrant = vi.hoisted(() => vi.fn());
vi.mock("../src/snowflake.js", () => ({ runQuery }));
vi.mock("../src/config.js", () => ({
  loadConfig,
  envFilePath: () => "/tmp/env",
  IDENTIFIER: /^[A-Za-z_][A-Za-z0-9_$]*$/,
}));
vi.mock("../src/grants.js", () => ({ requireGrant }));

import { AxiError } from "axi-sdk-js";
import { stageCommand } from "../src/commands/stage.js";

beforeEach(() => {
  runQuery.mockReset();
  loadConfig.mockReset();
  loadConfig.mockReturnValue({ modelDirs: [], defaultFileFormat: "DB.S.PARQUET_FORMAT" });
  requireGrant.mockReset();
  // A single written file: presentWrite surfaces it inline as `result`.
  runQuery.mockResolvedValue({
    rows: [{ rows_unloaded: "100" }],
    total: 1,
    numericColumns: new Set(["rows_unloaded"]),
  });
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

describe("stage copy", () => {
  it("gates on stage.write before touching the connection", async () => {
    requireGrant.mockImplementation(() => {
      throw new AxiError("Write capability 'stage.write' is not granted", "WRITE_NOT_ALLOWED", []);
    });
    await expect(stageCommand.run(["copy", "@DB.S.SRC/", "@DB.S.DST/"])).rejects.toMatchObject({
      code: "WRITE_NOT_ALLOWED",
    });
    expect(requireGrant).toHaveBeenCalledWith("stage.write");
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("builds a COPY FILES statement and defaults the timeout to 900s", async () => {
    await stageCommand.run(["copy", "@DB.S.SRC/x/", "@DB.S.DST/dev/x/"]);
    expect(runQuery.mock.calls[0][0]).toBe("COPY FILES INTO @DB.S.DST/dev/x/ FROM @DB.S.SRC/x/");
    expect(runQuery.mock.calls[0][1]).toMatchObject({ timeoutSeconds: 900 });
  });

  it("adds a PATTERN clause, escaping single quotes", async () => {
    await stageCommand.run(["copy", "@DB.S.SRC/", "@DB.S.DST/", "--pattern", ".*[.]parquet"]);
    expect(runQuery.mock.calls[0][0]).toBe("COPY FILES INTO @DB.S.DST/ FROM @DB.S.SRC/ PATTERN='.*[.]parquet'");
  });

  it("rejects a bad stage path before the connection", async () => {
    await expect(stageCommand.run(["copy", "not-a-stage", "@DB.S.DST/"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});

describe("stage unload", () => {
  it("builds a parquet COPY INTO by default", async () => {
    await stageCommand.run(["unload", "FCT_ORDERS", "@DB.S.EXP/o/"]);
    expect(runQuery.mock.calls[0][0]).toBe("COPY INTO @DB.S.EXP/o/ FROM FCT_ORDERS FILE_FORMAT = (TYPE = PARQUET)");
  });

  it("assembles single, overwrite, and max-file-size copy options", async () => {
    await stageCommand.run([
      "unload",
      "DB.S.FCT_ORDERS",
      "@DB.S.EXP/o/",
      "--single",
      "--overwrite",
      "--max-file-size",
      "16000000",
    ]);
    expect(runQuery.mock.calls[0][0]).toBe(
      "COPY INTO @DB.S.EXP/o/ FROM DB.S.FCT_ORDERS FILE_FORMAT = (TYPE = PARQUET) SINGLE = TRUE OVERWRITE = TRUE MAX_FILE_SIZE = 16000000",
    );
  });

  it("emits HEADER only for csv", async () => {
    await stageCommand.run(["unload", "T", "@DB.S.EXP/o/", "--format", "csv", "--header"]);
    expect(runQuery.mock.calls[0][0]).toBe("COPY INTO @DB.S.EXP/o/ FROM T FILE_FORMAT = (TYPE = CSV HEADER = TRUE)");
  });

  it("rejects --header without csv, and an unknown format", async () => {
    await expect(stageCommand.run(["unload", "T", "@DB.S.EXP/o/", "--header"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(stageCommand.run(["unload", "T", "@DB.S.EXP/o/", "--format", "avro"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("rejects an invalid table reference", async () => {
    await expect(stageCommand.run(["unload", "bad-table", "@DB.S.EXP/o/"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});

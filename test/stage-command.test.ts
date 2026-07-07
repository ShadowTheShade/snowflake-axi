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
});

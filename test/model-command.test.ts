import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("../src/config.js", () => ({ loadConfig, envFilePath: () => "/tmp/env" }));

import { modelCommand } from "../src/commands/model.js";

const dir = mkdtempSync(join(tmpdir(), "axi-models-"));
mkdirSync(join(dir, "intermediate"));
writeFileSync(join(dir, "intermediate", "stg_orders.sql"), "SELECT 1 AS o");
writeFileSync(join(dir, "intermediate", "stg_orders_items.sql"), "SELECT 2");
writeFileSync(join(dir, "fct_revenue.sql"), "x".repeat(2000));

beforeEach(() => {
  loadConfig.mockReset();
  loadConfig.mockReturnValue({ modelDirs: [dir] });
});

describe("model command", () => {
  it("prefers exact filename matches over contains matches", async () => {
    const output = (await modelCommand.run(["stg_orders"])) as Record<string, unknown>;
    expect(output.model).toBe("stg_orders");
    expect(output.sql).toBe("SELECT 1 AS o");
  });

  it("resolves a single contains match to the detail view", async () => {
    const output = (await modelCommand.run(["orders_i"])) as Record<string, unknown>;
    expect(output.model).toBe("stg_orders_items");
  });

  it("lists multiple contains matches", async () => {
    const output = (await modelCommand.run(["stg_o"])) as Record<string, unknown>;
    expect(output.count).toBe("2 models match 'stg_o'");
    expect(output.matches).toHaveLength(2);
  });

  it("truncates long SQL with a --full hint", async () => {
    const output = (await modelCommand.run(["fct_revenue"])) as Record<string, unknown>;
    expect(output.sql).toContain("(truncated, 2000 chars total)");
    expect((output.help as string[])[0]).toContain("--full");
    const full = (await modelCommand.run(["fct_revenue", "--full"])) as Record<string, unknown>;
    expect((full.sql as string).length).toBe(2000);
  });

  it("suggests nearest names on zero matches", async () => {
    const output = (await modelCommand.run(["stg_ordes"])) as Record<string, unknown>;
    expect(output.count).toContain("0 models match");
    expect((output.help as string[])[0]).toContain("stg_orders");
  });

  it("fails with CONFIG_ERROR when no dirs configured", async () => {
    loadConfig.mockReturnValue({ modelDirs: [] });
    await expect(modelCommand.run(["stg_orders"])).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });
});

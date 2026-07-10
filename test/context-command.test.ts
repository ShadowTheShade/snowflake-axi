import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("../src/config.js", () => ({ loadConfig }));

import { contextCommand } from "../src/commands/context.js";

beforeEach(() => {
  loadConfig.mockReset();
});

describe("context command", () => {
  it("prints a compact config-derived line without connecting", async () => {
    loadConfig.mockReturnValue({ account: "MYACCT", user: "SVC_USER" });
    const output = (await contextCommand.run([])) as Record<string, unknown>;
    expect(output.account).toBe("MYACCT");
    expect(output.user).toBe("SVC_USER");
    expect((output.help as string[])[0]).toContain("snowflake-axi");
  });

  it("stays silent when unconfigured so the hook never nags", async () => {
    loadConfig.mockImplementation(() => {
      throw new Error("Missing Snowflake credentials");
    });
    expect(await contextCommand.run([])).toBe("");
  });
});

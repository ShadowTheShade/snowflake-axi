import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfig = vi.hoisted(() => vi.fn());
const readOAuthTokens = vi.hoisted(() => vi.fn());
vi.mock("../src/config.js", () => ({ loadConfig, readOAuthTokens }));

import { contextCommand } from "../src/commands/context.js";

beforeEach(() => {
  loadConfig.mockReset();
  readOAuthTokens.mockReset();
});

describe("context command", () => {
  it("prints a compact config-derived line without connecting", async () => {
    loadConfig.mockReturnValue({ account: "MYACCT", user: "SVC_USER" });
    const output = (await contextCommand.run([])) as Record<string, unknown>;
    expect(output.account).toBe("MYACCT");
    expect(output.user).toBe("SVC_USER");
    expect((output.help as string[])[0]).toContain("snowflake-axi");
  });

  it("reports the OAuth identity and refresh-token expiry", async () => {
    loadConfig.mockReturnValue({ account: "MYACCT", user: "ALICE", auth: "oauth" });
    readOAuthTokens.mockReturnValue({ refreshTokenExpiresAt: Date.UTC(2026, 9, 11) });
    const output = (await contextCommand.run([])) as Record<string, unknown>;
    expect(output.auth).toBe("OAuth, logged in as ALICE, expires 2026-10-11");
  });

  it("reports PAT auth without token details", async () => {
    loadConfig.mockReturnValue({ account: "MYACCT", user: "SVC_USER", auth: "pat" });
    const output = (await contextCommand.run([])) as Record<string, unknown>;
    expect(output.auth).toBe("PAT");
  });

  it("stays silent when unconfigured so the hook never nags", async () => {
    loadConfig.mockImplementation(() => {
      throw new Error("Missing Snowflake credentials");
    });
    expect(await contextCommand.run([])).toBe("");
  });
});

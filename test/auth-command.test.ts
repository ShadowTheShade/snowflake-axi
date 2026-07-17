import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfig = vi.hoisted(() => vi.fn());
const patConfigured = vi.hoisted(() => vi.fn());
const readAuthMode = vi.hoisted(() => vi.fn());
const writeAuthMode = vi.hoisted(() => vi.fn());
const readOAuthRing = vi.hoisted(() => vi.fn());

vi.mock("../src/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/config.js")>();
  return {
    ...original,
    loadConfig,
    patConfigured,
    readAuthMode,
    writeAuthMode,
    readOAuthRing,
    // Mirrors the real implementation over the mocked ring reader.
    ringLogins: () => {
      const ring = readOAuthRing();
      return ring ? original.oauthRingKeys(ring) : [];
    },
  };
});

import { authCommand } from "../src/commands/auth.js";

beforeEach(() => {
  vi.stubEnv("SNOWFLAKE_AUTH", "");
  loadConfig.mockReset().mockReturnValue({ auth: "pat" });
  patConfigured.mockReset().mockReturnValue(true);
  readAuthMode.mockReset().mockReturnValue(undefined);
  writeAuthMode.mockReset();
  readOAuthRing.mockReset().mockReturnValue({ entries: { default: {}, REPORTER: {} } });
});

describe("auth command", () => {
  it("shows the resolved mode and both credential states", async () => {
    const output = (await authCommand.run([])) as Record<string, unknown>;
    expect(output.active).toBe("pat");
    expect(output.persisted).toContain("none");
    expect(output.pat).toBe("configured");
    expect(output.oauth).toBe("logins: default, REPORTER");
    expect(output.override).toBeUndefined();
  });

  it("surfaces a SNOWFLAKE_AUTH override in the process env", async () => {
    vi.stubEnv("SNOWFLAKE_AUTH", "oauth");
    const output = (await authCommand.run([])) as Record<string, unknown>;
    expect(output.override).toContain("SNOWFLAKE_AUTH=oauth");
    vi.unstubAllEnvs();
  });

  it("shows unconfigured when loadConfig cannot resolve credentials", async () => {
    loadConfig.mockImplementation(() => {
      throw new Error("missing");
    });
    const output = (await authCommand.run([])) as Record<string, unknown>;
    expect(output.active).toBe("(unconfigured)");
  });

  it("switches to oauth when logins exist", async () => {
    const output = (await authCommand.run(["oauth"])) as Record<string, unknown>;
    expect(writeAuthMode).toHaveBeenCalledWith("oauth");
    expect(output.status).toBe("auth mode -> oauth");
  });

  it("refuses oauth with no logins", async () => {
    readOAuthRing.mockReturnValue(undefined);
    await expect(authCommand.run(["oauth"])).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    expect(writeAuthMode).not.toHaveBeenCalled();
  });

  it("refuses pat when none is configured", async () => {
    patConfigured.mockReturnValue(false);
    await expect(authCommand.run(["pat"])).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    expect(writeAuthMode).not.toHaveBeenCalled();
  });

  it("clears the persisted mode with `auth default` and reports the fallback", async () => {
    const output = (await authCommand.run(["default"])) as Record<string, unknown>;
    expect(writeAuthMode).toHaveBeenCalledWith(undefined);
    expect(output.active).toBe("pat");
  });

  it("falls back to oauth on `auth default` when no PAT exists but logins do", async () => {
    patConfigured.mockReturnValue(false);
    const output = (await authCommand.run(["default"])) as Record<string, unknown>;
    expect(output.active).toBe("oauth");
  });

  it("rejects an unknown mode", async () => {
    await expect(authCommand.run(["keypair"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(writeAuthMode).not.toHaveBeenCalled();
  });

  it("rejects more than one positional", async () => {
    await expect(authCommand.run(["pat", "oauth"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

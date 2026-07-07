import { afterEach, describe, expect, it, vi } from "vitest";

async function freshLoadConfig() {
  vi.resetModules();
  const { loadConfig } = await import("../src/config.js");
  return loadConfig;
}

function stubCreds() {
  vi.stubEnv("XDG_CONFIG_HOME", "/nonexistent");
  vi.stubEnv("SNOWFLAKE_ACCOUNT", "ACC");
  vi.stubEnv("SNOWFLAKE_USER", "USER");
  vi.stubEnv("SNOWFLAKE_TOKEN", "TOKEN");
}

function loadError(loadConfig: () => unknown): unknown {
  try {
    loadConfig();
    return undefined;
  } catch (error) {
    return error;
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadConfig", () => {
  it("reports missing credentials with CONFIG_ERROR", async () => {
    vi.stubEnv("XDG_CONFIG_HOME", "/nonexistent");
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "");
    vi.stubEnv("SNOWFLAKE_USER", "");
    vi.stubEnv("SNOWFLAKE_TOKEN", "");
    const loadConfig = await freshLoadConfig();
    expect(loadError(loadConfig)).toMatchObject({
      code: "CONFIG_ERROR",
      message: expect.stringContaining("Missing Snowflake credentials"),
    });
  });

  it("rejects a default database that is not an unquoted identifier", async () => {
    stubCreds();
    vi.stubEnv("SNOWFLAKE_DATABASE", "BAD NAME");
    const loadConfig = await freshLoadConfig();
    expect(loadError(loadConfig)).toMatchObject({
      code: "CONFIG_ERROR",
      message: expect.stringContaining("SNOWFLAKE_DATABASE"),
    });
  });

  it("rejects a default schema that is not an unquoted identifier", async () => {
    stubCreds();
    vi.stubEnv("SNOWFLAKE_DATABASE", "GOOD_DB");
    vi.stubEnv("SNOWFLAKE_SCHEMA", 'quoted"schema');
    const loadConfig = await freshLoadConfig();
    expect(loadError(loadConfig)).toMatchObject({
      code: "CONFIG_ERROR",
      message: expect.stringContaining("SNOWFLAKE_SCHEMA"),
    });
  });

  it("accepts valid identifiers", async () => {
    stubCreds();
    vi.stubEnv("SNOWFLAKE_DATABASE", "GOOD_DB");
    vi.stubEnv("SNOWFLAKE_SCHEMA", "PUBLIC");
    const loadConfig = await freshLoadConfig();
    expect(loadConfig()).toMatchObject({ account: "ACC", database: "GOOD_DB", schema: "PUBLIC" });
  });
});

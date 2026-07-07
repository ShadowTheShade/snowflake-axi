import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

async function freshLoadConfig() {
  vi.resetModules();
  const { loadConfig } = await import("../src/config.js");
  return loadConfig;
}

function stubIsolation() {
  vi.stubEnv("XDG_CONFIG_HOME", "/nonexistent");
  vi.stubEnv("SNOWFLAKE_HOME", "/nonexistent");
}

function stubCreds() {
  stubIsolation();
  vi.stubEnv("SNOWFLAKE_ACCOUNT", "ACC");
  vi.stubEnv("SNOWFLAKE_USER", "USER");
  vi.stubEnv("SNOWFLAKE_TOKEN", "TOKEN");
}

function stubSnowflakeHome(files: Record<string, string>): void {
  const dir = mkdtempSync(join(tmpdir(), "axi-snowflake-home-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  vi.stubEnv("XDG_CONFIG_HOME", "/nonexistent");
  vi.stubEnv("SNOWFLAKE_HOME", dir);
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
    stubIsolation();
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

describe("snow CLI connections.toml fallback", () => {
  it("uses a PAT connection from connections.toml when nothing else is configured", async () => {
    stubSnowflakeHome({
      "connections.toml": `[default]
account = "TOML_ACC"
user = "TOML_USER"
authenticator = "PROGRAMMATIC_ACCESS_TOKEN"
token = "TOML_PAT"
database = "TOML_DB"
`,
    });
    const loadConfig = await freshLoadConfig();
    expect(loadConfig()).toMatchObject({
      account: "TOML_ACC",
      user: "TOML_USER",
      token: "TOML_PAT",
      database: "TOML_DB",
    });
  });

  it("lets env values win over connections.toml", async () => {
    stubSnowflakeHome({
      "connections.toml": `[default]
account = "TOML_ACC"
user = "TOML_USER"
password = "TOML_PW"
`,
    });
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "ENV_ACC");
    const loadConfig = await freshLoadConfig();
    expect(loadConfig()).toMatchObject({ account: "ENV_ACC", user: "TOML_USER", token: "TOML_PW" });
  });

  it("honors default_connection_name from config.toml", async () => {
    stubSnowflakeHome({
      "config.toml": `default_connection_name = "work"`,
      "connections.toml": `[default]
account = "WRONG"
user = "WRONG"
password = "WRONG"

[work]
account = "WORK_ACC"
user = "WORK_USER"
password = "WORK_PW"
`,
    });
    const loadConfig = await freshLoadConfig();
    expect(loadConfig()).toMatchObject({ account: "WORK_ACC", user: "WORK_USER", token: "WORK_PW" });
  });

  it("reads the [connections] table of config.toml when connections.toml is absent", async () => {
    stubSnowflakeHome({
      "config.toml": `[connections.default]
account = "CFG_ACC"
user = "CFG_USER"
password = "CFG_PW"
`,
    });
    const loadConfig = await freshLoadConfig();
    expect(loadConfig()).toMatchObject({ account: "CFG_ACC", token: "CFG_PW" });
  });

  it("ignores tokens of non-PAT authenticators instead of misusing them as passwords", async () => {
    stubSnowflakeHome({
      "connections.toml": `[default]
account = "TOML_ACC"
user = "TOML_USER"
authenticator = "oauth"
token = "OAUTH_TOKEN"
`,
    });
    const loadConfig = await freshLoadConfig();
    expect(loadError(loadConfig)).toMatchObject({
      code: "CONFIG_ERROR",
      message: expect.stringContaining("SNOWFLAKE_TOKEN"),
    });
  });
});

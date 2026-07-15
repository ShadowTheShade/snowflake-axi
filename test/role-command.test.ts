import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfig = vi.hoisted(() => vi.fn());
const readOAuthRing = vi.hoisted(() => vi.fn());
const readActiveRole = vi.hoisted(() => vi.fn());
const writeActiveRole = vi.hoisted(() => vi.fn());
const runQuery = vi.hoisted(() => vi.fn());

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadConfig,
  readOAuthRing,
  readActiveRole,
  writeActiveRole,
}));
vi.mock("../src/snowflake.js", () => ({ runQuery }));

import { roleCommand } from "../src/commands/role.js";

const oauthRing = { entries: { default: {}, REPORTER: {}, ANALYST: {} } };

beforeEach(() => {
  vi.stubEnv("SNOWFLAKE_ROLE", "");
  loadConfig.mockReset().mockReturnValue({ auth: "oauth", user: "ALICE" });
  readOAuthRing.mockReset().mockReturnValue(oauthRing);
  readActiveRole.mockReset().mockReturnValue(undefined);
  writeActiveRole.mockReset();
  runQuery.mockReset();
});

describe("role command", () => {
  it("shows the active role and switchable ring logins without connecting", async () => {
    readActiveRole.mockReturnValue("REPORTER");
    const output = (await roleCommand.run([])) as Record<string, unknown>;
    expect(output.active).toBe("REPORTER");
    expect(output.logins).toEqual(["default", "ANALYST", "REPORTER"]);
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("defaults the active label to 'default' when none is set", async () => {
    const output = (await roleCommand.run([])) as Record<string, unknown>;
    expect(output.active).toBe("default");
    expect(output.override).toBeUndefined();
  });

  it("surfaces a process-env SNOWFLAKE_ROLE as a session override", async () => {
    vi.stubEnv("SNOWFLAKE_ROLE", "ENV_ROLE");
    const output = (await roleCommand.run([])) as Record<string, unknown>;
    expect(output.override).toContain("SNOWFLAKE_ROLE=ENV_ROLE");
    vi.unstubAllEnvs();
  });

  it("switches to a role that has a login, uppercasing and persisting it", async () => {
    const output = (await roleCommand.run(["analyst"])) as Record<string, unknown>;
    expect(writeActiveRole).toHaveBeenCalledWith("ANALYST");
    expect(output.status).toBe("active role -> ANALYST");
  });

  it("refuses a role with no login in the ring and never persists it", async () => {
    await expect(roleCommand.run(["FINANCE"])).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(writeActiveRole).not.toHaveBeenCalled();
  });

  it("reverts to the default login with `role default`, clearing the active role", async () => {
    const output = (await roleCommand.run(["default"])) as Record<string, unknown>;
    expect(writeActiveRole).toHaveBeenCalledWith(undefined);
    expect(output.active).toBe("default");
  });

  it("rejects a role name that is not an identifier", async () => {
    await expect(roleCommand.run(["not a role"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(writeActiveRole).not.toHaveBeenCalled();
  });

  it("lists granted roles with --grants, marking which have a login", async () => {
    runQuery.mockResolvedValue({
      rows: [{ role: "REPORTER" }, { role: "FINANCE" }, { role: "REPORTER" }],
      total: 3,
    });
    const output = (await roleCommand.run(["--grants"])) as Record<string, unknown>;
    expect(runQuery).toHaveBeenCalledWith("SHOW GRANTS TO USER ALICE");
    expect(output.granted).toEqual([
      { role: "FINANCE", login: "no (`login --role FINANCE`)" },
      { role: "REPORTER", login: "yes" },
    ]);
  });

  it("refuses a role argument alongside --grants", async () => {
    await expect(roleCommand.run(["REPORTER", "--grants"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("in PAT mode switches to any role without a ring check", async () => {
    loadConfig.mockReturnValue({ auth: "pat", user: "SVC" });
    readOAuthRing.mockReturnValue(undefined);
    const output = (await roleCommand.run(["FINANCE"])) as Record<string, unknown>;
    expect(writeActiveRole).toHaveBeenCalledWith("FINANCE");
    expect(output.active).toBe("FINANCE");
    expect(output.logins).toBeUndefined();
  });

  it("rejects more than one positional before touching config", async () => {
    await expect(roleCommand.run(["A", "B"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

import { AxiError } from "axi-sdk-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runQuery = vi.hoisted(() => vi.fn());
vi.mock("../src/snowflake.js", () => ({ runQuery }));
const runPgQuery = vi.hoisted(() => vi.fn());
vi.mock("../src/pg.js", () => ({ runPgQuery }));
const loadConfig = vi.hoisted(() => vi.fn());
const loadPgConfig = vi.hoisted(() => vi.fn());
const readActiveRole = vi.hoisted(() => vi.fn());
const processEnvRole = vi.hoisted(() => vi.fn());
const ringLogins = vi.hoisted(() => vi.fn());
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadConfig,
  loadPgConfig,
  readActiveRole,
  processEnvRole,
  ringLogins,
}));

import { runDoctor } from "../src/commands/doctor.js";

interface Check {
  check: string;
  status: string;
  detail: string;
}

function checkFor(output: Record<string, unknown>, name: string): Check {
  const found = (output.checks as Check[]).find((c) => c.check === name);
  if (!found) throw new Error(`no check named ${name}`);
  return found;
}

const SESSION_ROW = {
  ROLE: "ANALYST",
  WAREHOUSE: "DEV_WH",
  DATABASE: "SCOOPS_DB",
  SCHEMA: "PUBLIC",
  ROLES: '["ANALYST","REPORTER"]',
};

beforeEach(() => {
  runQuery.mockReset().mockResolvedValue({ rows: [SESSION_ROW], total: 1 });
  runPgQuery.mockReset().mockResolvedValue({ rows: [{ "1": 1 }], complete: true });
  loadConfig.mockReset().mockReturnValue({ account: "MYACCT", user: "SVC_USER", auth: "pat" });
  loadPgConfig
    .mockReset()
    .mockReturnValue({ host: "h", port: 5432, database: "postgres", user: "u", password: "p", sslmode: "require" });
  readActiveRole.mockReset().mockReturnValue(undefined);
  processEnvRole.mockReset().mockReturnValue(undefined);
  ringLogins.mockReset().mockReturnValue([]);
});

describe("doctor", () => {
  it("reports every part green when the whole setup is healthy", async () => {
    const output = await runDoctor();
    expect(output.doctor).toBe("connection diagnostics: all checks passed");
    for (const name of ["config", "connection", "warehouse", "namespace", "roles", "postgres"]) {
      expect(checkFor(output, name).status).toBe("ok");
    }
    expect(checkFor(output, "namespace").detail).toBe("SCOOPS_DB.PUBLIC");
  });

  it("warns on a missing warehouse and namespace with actionable hints", async () => {
    runQuery.mockResolvedValue({ rows: [{ ...SESSION_ROW, WAREHOUSE: null, DATABASE: null, SCHEMA: null }], total: 1 });
    const output = await runDoctor();
    expect(output.doctor).toContain("warning(s)");
    expect(checkFor(output, "warehouse").status).toBe("warn");
    expect(checkFor(output, "namespace").status).toBe("warn");
    const help = output.help as string[];
    expect(help.some((line) => line.includes("DEFAULT_WAREHOUSE"))).toBe(true);
    expect(help.some((line) => line.includes("DEFAULT_NAMESPACE"))).toBe(true);
  });

  it("flags a single reachable role as a possible role-restricted PAT", async () => {
    runQuery.mockResolvedValue({ rows: [{ ...SESSION_ROW, ROLES: '["ANALYST"]' }], total: 1 });
    const output = await runDoctor();
    expect(checkFor(output, "roles").status).toBe("warn");
    expect((output.help as string[]).some((line) => line.includes("ROLE_RESTRICTION"))).toBe(true);
  });

  it("surfaces a failed connection with the error's own fix hints", async () => {
    runQuery.mockRejectedValue(
      new AxiError("user has no network policy for PAT auth", "AUTH_ERROR", [
        "Attach a network policy covering this machine's egress IP to the service user",
      ]),
    );
    const output = await runDoctor();
    expect(output.doctor).toContain("failed");
    expect(checkFor(output, "connection").status).toBe("fail");
    expect((output.help as string[]).some((line) => line.includes("network policy"))).toBe(true);
  });

  it("skips Postgres when it is not configured, without failing", async () => {
    loadPgConfig.mockImplementation(() => {
      throw new AxiError("Missing Snowflake Postgres connection settings", "CONFIG_ERROR", []);
    });
    const output = await runDoctor();
    expect(checkFor(output, "postgres").status).toBe("skip");
    expect(output.doctor).toBe("connection diagnostics: all checks passed");
  });

  it("still checks Postgres when credentials fail to load", async () => {
    loadConfig.mockImplementation(() => {
      throw new AxiError("Missing Snowflake credentials: SNOWFLAKE_TOKEN", "CONFIG_ERROR", [
        "Create the env file with SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_TOKEN (PAT)",
      ]);
    });
    const output = await runDoctor();
    expect(checkFor(output, "config").status).toBe("fail");
    expect(runQuery).not.toHaveBeenCalled();
    expect(checkFor(output, "postgres").status).toBe("ok");
  });

  it("lists OAuth logins for the roles check in OAuth mode", async () => {
    loadConfig.mockReturnValue({ account: "MYACCT", user: "ALICE", auth: "oauth" });
    ringLogins.mockReturnValue(["default", "REPORTER"]);
    const output = await runDoctor();
    expect(checkFor(output, "roles").detail).toContain("default, REPORTER");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const runQuery = vi.hoisted(() => vi.fn());
vi.mock("../src/snowflake.js", () => ({ runQuery }));
const requireGrant = vi.hoisted(() => vi.fn());
vi.mock("../src/grants.js", () => ({ requireGrant }));

import { dbtCommand } from "../src/commands/dbt.js";

const PROJECT_ROW = {
  name: "MY_PROJECT",
  database_name: "STITCH_DB",
  schema_name: "METRICS",
  created_on: "2025-12-31 12:56:59.867 -0500",
  updated_on: "2026-01-19 10:51:32.204 -0500",
  owner: "DBT_ROLE",
  comment: "daily usage refresh",
  dbt_version: "1.9.4",
  default_version: "LAST",
  default_version_name: "VERSION$5",
  default_version_location_uri: "snow://dbt/STITCH_DB.METRICS.MY_PROJECT/versions/version$5/",
  default_version_source_location_uri: "snow://workspace/USER$X.PUBLIC.MY_PROJECT/versions/live/",
  dbt_snowflake_version: "1.9.2",
  default_target: "dev",
  external_access_integrations: '["DBT_HUB"]',
};

const OTHER_ROW = { ...PROJECT_ROW, name: "MY_PROJECT_DEV", schema_name: "DEV" };

beforeEach(() => {
  runQuery.mockReset();
  requireGrant.mockReset();
});

describe("dbt list", () => {
  it("lists account-wide by default with a minimal schema", async () => {
    runQuery.mockResolvedValueOnce({ rows: [PROJECT_ROW], total: 1 });
    const output = (await dbtCommand.run([])) as Record<string, unknown>;
    expect(runQuery.mock.calls[0][0]).toBe("SHOW DBT PROJECTS IN ACCOUNT");
    expect(output.count).toBe("1 dbt projects");
    expect(output.projects).toEqual([
      { name: "MY_PROJECT", scope: "STITCH_DB.METRICS", dbt_version: "1.9.4", target: "dev", updated: "2026-01-19" },
    ]);
    expect((output.help as string[])[0]).toContain("dbt describe");
  });

  it("scopes to a database or schema from the positional", async () => {
    runQuery.mockResolvedValue({ rows: [], total: 0 });
    await dbtCommand.run(["my_db"]);
    expect(runQuery.mock.calls[0][0]).toBe("SHOW DBT PROJECTS IN DATABASE MY_DB");
    await dbtCommand.run(["my_db.raw"]);
    expect(runQuery.mock.calls[1][0]).toBe("SHOW DBT PROJECTS IN SCHEMA MY_DB.RAW");
  });

  it("wraps bare --like words as contains patterns", async () => {
    runQuery.mockResolvedValueOnce({ rows: [PROJECT_ROW], total: 1 });
    await dbtCommand.run(["--like", "usage"]);
    expect(runQuery.mock.calls[0][0]).toBe("SHOW DBT PROJECTS LIKE '%usage%' IN ACCOUNT");
  });

  it("rejects unsafe --like patterns before querying", async () => {
    await expect(dbtCommand.run(["--like", "x' OR '1"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("reports empty scopes definitively", async () => {
    runQuery.mockResolvedValueOnce({ rows: [], total: 0 });
    const output = (await dbtCommand.run(["--like", "nope"])) as Record<string, unknown>;
    expect(output.count).toBe("0 dbt projects matching '%nope%' in account");
  });
});

describe("dbt describe", () => {
  it("resolves a bare name account-wide and returns full detail", async () => {
    runQuery.mockResolvedValueOnce({ rows: [PROJECT_ROW], total: 1 });
    const output = (await dbtCommand.run(["describe", "my_project"])) as Record<string, unknown>;
    expect(runQuery.mock.calls[0][0]).toBe("SHOW DBT PROJECTS LIKE '%MY_PROJECT%' IN ACCOUNT");
    expect(output).toMatchObject({
      project: "STITCH_DB.METRICS.MY_PROJECT",
      owner: "DBT_ROLE",
      comment: "daily usage refresh",
      dbt_version: "1.9.4",
      adapter_version: "1.9.2",
      target: "dev",
      version: "VERSION$5",
      integrations: ["DBT_HUB"],
      created: "2025-12-31",
      updated: "2026-01-19",
    });
  });

  it("prefers the exact match when contains finds several", async () => {
    runQuery.mockResolvedValueOnce({ rows: [PROJECT_ROW, OTHER_ROW], total: 2 });
    const output = (await dbtCommand.run(["describe", "MY_PROJECT"])) as Record<string, unknown>;
    expect(output.project).toBe("STITCH_DB.METRICS.MY_PROJECT");
  });

  it("lists ambiguous matches instead of guessing", async () => {
    runQuery.mockResolvedValueOnce({ rows: [PROJECT_ROW, OTHER_ROW], total: 2 });
    const output = (await dbtCommand.run(["describe", "usage"])) as Record<string, unknown>;
    expect(output.count).toBe("2 dbt projects match 'USAGE'");
    expect(output.matches).toEqual([
      { project: "STITCH_DB.METRICS.MY_PROJECT" },
      { project: "STITCH_DB.DEV.MY_PROJECT_DEV" },
    ]);
  });

  it("describes a fully qualified name within its schema scope", async () => {
    runQuery.mockResolvedValueOnce({ rows: [PROJECT_ROW], total: 1 });
    const output = (await dbtCommand.run(["describe", "stitch_db.metrics.my_project"])) as Record<string, unknown>;
    expect(runQuery.mock.calls[0][0]).toBe("SHOW DBT PROJECTS LIKE 'MY_PROJECT' IN SCHEMA STITCH_DB.METRICS");
    expect(output.project).toBe("STITCH_DB.METRICS.MY_PROJECT");
  });

  it("reports missing projects definitively with a list suggestion", async () => {
    runQuery.mockResolvedValueOnce({ rows: [], total: 0 });
    const output = (await dbtCommand.run(["describe", "ghost"])) as Record<string, unknown>;
    expect(output.count).toBe("0 dbt projects match 'GHOST' in account");
    expect((output.help as string[])[0]).toContain("snowflake-axi dbt");
  });

  it("rejects two-part and malformed names before querying", async () => {
    await expect(dbtCommand.run(["describe", "schema.name"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(dbtCommand.run(["describe", "bad-name"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("omits empty comment, target, and integrations from the detail", async () => {
    runQuery.mockResolvedValueOnce({
      rows: [{ ...PROJECT_ROW, comment: "", default_target: "", external_access_integrations: "" }],
      total: 1,
    });
    const output = (await dbtCommand.run(["describe", "MY_PROJECT"])) as Record<string, unknown>;
    expect(output.comment).toBeUndefined();
    expect(output.target).toBeUndefined();
    expect(output.integrations).toBeUndefined();
  });
});

describe("dbt execute", () => {
  it("checks the write grant before anything else", async () => {
    requireGrant.mockImplementation(() => {
      throw Object.assign(new Error("Write capability 'dbt.execute' is not granted"), { code: "WRITE_NOT_ALLOWED" });
    });
    await expect(dbtCommand.run(["execute", "my_project", "--args", "build"])).rejects.toMatchObject({
      code: "WRITE_NOT_ALLOWED",
    });
    expect(requireGrant).toHaveBeenCalledWith("dbt.execute");
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("requires --args before querying", async () => {
    await expect(dbtCommand.run(["execute", "my_project"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("resolves the project and runs EXECUTE DBT PROJECT with escaped args", async () => {
    runQuery
      .mockResolvedValueOnce({ rows: [PROJECT_ROW], total: 1 })
      .mockResolvedValueOnce({ rows: [{ dbt_output: "ok" }], total: 1 });
    const output = (await dbtCommand.run(["execute", "my_project", "--args", "run --vars 'k: v'"])) as Record<
      string,
      unknown
    >;
    expect(runQuery.mock.calls[1][0]).toBe(
      "EXECUTE DBT PROJECT STITCH_DB.METRICS.MY_PROJECT args='run --vars ''k: v'''",
    );
    expect(runQuery.mock.calls[1][1]).toEqual({ timeoutSeconds: 3600, role: undefined });
    expect(output.project).toBe("STITCH_DB.METRICS.MY_PROJECT");
    expect(output.rows).toEqual([{ dbt_output: "ok" }]);
  });

  it("runs both the lookup and the execution under --role", async () => {
    runQuery
      .mockResolvedValueOnce({ rows: [PROJECT_ROW], total: 1 })
      .mockResolvedValueOnce({ rows: [{ dbt_output: "ok" }], total: 1 });
    await dbtCommand.run(["execute", "my_project", "--args", "build", "--role", "ANALYTICS_ROLE"]);
    expect(runQuery.mock.calls[0][1]).toEqual({ role: "ANALYTICS_ROLE" });
    expect(runQuery.mock.calls[1][1]).toEqual({ timeoutSeconds: 3600, role: "ANALYTICS_ROLE" });
  });

  it("errors on ambiguous names with full-name suggestions", async () => {
    runQuery.mockResolvedValueOnce({ rows: [PROJECT_ROW, OTHER_ROW], total: 2 });
    await expect(dbtCommand.run(["execute", "usage", "--args", "build"])).rejects.toMatchObject({
      code: "AMBIGUOUS",
      suggestions: [
        'snowflake-axi dbt execute STITCH_DB.METRICS.MY_PROJECT --args "build"',
        'snowflake-axi dbt execute STITCH_DB.DEV.MY_PROJECT_DEV --args "build"',
      ],
    });
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  it("errors when no project matches", async () => {
    runQuery.mockResolvedValueOnce({ rows: [], total: 0 });
    await expect(dbtCommand.run(["execute", "ghost", "--args", "build"])).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

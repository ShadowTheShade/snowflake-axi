import { beforeEach, describe, expect, it, vi } from "vitest";

const runQuery = vi.hoisted(() => vi.fn());
vi.mock("../src/snowflake.js", () => ({ runQuery }));
const requireGrant = vi.hoisted(() => vi.fn());
vi.mock("../src/grants.js", () => ({ requireGrant }));
const runLocalDbt = vi.hoisted(() => vi.fn());
const runLocalList = vi.hoisted(() => vi.fn());
const readCompiledSql = vi.hoisted(() => vi.fn());
vi.mock("../src/dbt-local.js", () => ({ runLocalDbt, runLocalList, readCompiledSql }));

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

// A project whose current version was deployed from a git repository stage.
const GIT_ROW = { ...PROJECT_ROW, default_version_source_location_uri: "@STITCH_DB.PUBLIC.MY_REPO/branches/main" };

beforeEach(() => {
  runQuery.mockReset();
  requireGrant.mockReset();
  runLocalDbt.mockReset();
  runLocalList.mockReset();
  readCompiledSql.mockReset();
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
    const output = (await dbtCommand.run(["describe", "my_pro"])) as Record<string, unknown>;
    expect(output.count).toBe("2 dbt projects match 'MY_PRO'");
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
    await expect(dbtCommand.run(["execute", "my_pro", "--args", "build"])).rejects.toMatchObject({
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

describe("dbt deploy", () => {
  function mockDeploySequence(versions: Record<string, unknown>[], project = GIT_ROW) {
    runQuery
      .mockResolvedValueOnce({ rows: [project], total: 1 }) // findProject
      .mockResolvedValueOnce({ rows: [], total: 0 }) // FETCH
      .mockResolvedValueOnce({ rows: [{ name: "dbt_project.yml" }], total: 1 }) // LIST
      .mockResolvedValueOnce({ rows: [], total: 0 }) // ADD VERSION
      .mockResolvedValueOnce({ rows: versions, total: versions.length }); // SHOW VERSIONS
  }

  it("checks the write grant before anything else", async () => {
    requireGrant.mockImplementation(() => {
      throw Object.assign(new Error("Write capability 'dbt.deploy' is not granted"), { code: "WRITE_NOT_ALLOWED" });
    });
    await expect(dbtCommand.run(["deploy", "my_project"])).rejects.toMatchObject({ code: "WRITE_NOT_ALLOWED" });
    expect(requireGrant).toHaveBeenCalledWith("dbt.deploy");
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("fetches, verifies dbt_project.yml, adds a version, and reports it", async () => {
    mockDeploySequence([
      { name: "VERSION$1", is_last: "false", is_default: "false" },
      { name: "VERSION$2", is_last: "true", is_default: "true", git_commit_hash: "abcdef1234567890" },
    ]);
    const output = (await dbtCommand.run(["deploy", "my_project"])) as Record<string, unknown>;
    expect(runQuery.mock.calls[1][0]).toBe("ALTER GIT REPOSITORY STITCH_DB.PUBLIC.MY_REPO FETCH");
    expect(runQuery.mock.calls[2][0]).toBe("LIST @STITCH_DB.PUBLIC.MY_REPO/branches/main/dbt_project.yml");
    expect(runQuery.mock.calls[3][0]).toBe(
      "ALTER DBT PROJECT STITCH_DB.METRICS.MY_PROJECT ADD VERSION FROM '@STITCH_DB.PUBLIC.MY_REPO/branches/main'",
    );
    expect(runQuery.mock.calls[4][0]).toBe("SHOW VERSIONS IN DBT PROJECT STITCH_DB.METRICS.MY_PROJECT");
    expect(output).toMatchObject({
      project: "STITCH_DB.METRICS.MY_PROJECT",
      deployed_from: "@STITCH_DB.PUBLIC.MY_REPO/branches/main",
      version: "VERSION$2",
      commit: "abcdef123456",
      is_default: true,
    });
  });

  it("overrides the inferred source with --repo, --branch, and --path", async () => {
    mockDeploySequence([{ name: "VERSION$3", is_last: "true", is_default: "true" }]);
    await dbtCommand.run([
      "deploy",
      "my_project",
      "--repo",
      "other_db.public.repo",
      "--branch",
      "dev",
      "--path",
      "analytics",
    ]);
    expect(runQuery.mock.calls[1][0]).toBe("ALTER GIT REPOSITORY OTHER_DB.PUBLIC.REPO FETCH");
    expect(runQuery.mock.calls[2][0]).toBe("LIST @OTHER_DB.PUBLIC.REPO/branches/dev/analytics/dbt_project.yml");
    expect(runQuery.mock.calls[3][0]).toBe(
      "ALTER DBT PROJECT STITCH_DB.METRICS.MY_PROJECT ADD VERSION FROM '@OTHER_DB.PUBLIC.REPO/branches/dev/analytics'",
    );
  });

  it("skips the fetch with --no-fetch", async () => {
    runQuery
      .mockResolvedValueOnce({ rows: [GIT_ROW], total: 1 })
      .mockResolvedValueOnce({ rows: [{ name: "dbt_project.yml" }], total: 1 })
      .mockResolvedValueOnce({ rows: [], total: 0 })
      .mockResolvedValueOnce({ rows: [{ name: "VERSION$2", is_last: "true" }], total: 1 });
    await dbtCommand.run(["deploy", "my_project", "--no-fetch"]);
    expect(runQuery).toHaveBeenCalledTimes(4);
    expect(runQuery.mock.calls.some((call) => String(call[0]).includes("ALTER GIT REPOSITORY"))).toBe(false);
    expect(runQuery.mock.calls[1][0]).toBe("LIST @STITCH_DB.PUBLIC.MY_REPO/branches/main/dbt_project.yml");
  });

  it("threads --role through the lookup and every write", async () => {
    mockDeploySequence([{ name: "VERSION$2", is_last: "true" }]);
    await dbtCommand.run(["deploy", "my_project", "--role", "ANALYTICS_ROLE"]);
    expect(runQuery.mock.calls[0][1]).toEqual({ role: "ANALYTICS_ROLE" });
    expect(runQuery.mock.calls[1][1]).toEqual({ role: "ANALYTICS_ROLE", timeoutSeconds: 600 });
    expect(runQuery.mock.calls[2][1]).toEqual({ role: "ANALYTICS_ROLE" });
    expect(runQuery.mock.calls[3][1]).toEqual({ role: "ANALYTICS_ROLE", timeoutSeconds: 600 });
    expect(runQuery.mock.calls[4][1]).toEqual({ role: "ANALYTICS_ROLE" });
  });

  it("fails loud when the git path has no dbt_project.yml", async () => {
    runQuery
      .mockResolvedValueOnce({ rows: [GIT_ROW], total: 1 })
      .mockResolvedValueOnce({ rows: [], total: 0 })
      .mockResolvedValueOnce({ rows: [], total: 0 });
    await expect(dbtCommand.run(["deploy", "my_project"])).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(runQuery).toHaveBeenCalledTimes(3);
  });

  it("refuses a project whose source is not git without flags", async () => {
    runQuery.mockResolvedValueOnce({ rows: [PROJECT_ROW], total: 1 });
    await expect(dbtCommand.run(["deploy", "my_project"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  it("errors on ambiguous names before writing", async () => {
    runQuery.mockResolvedValueOnce({ rows: [GIT_ROW, OTHER_ROW], total: 2 });
    await expect(dbtCommand.run(["deploy", "my_pro"])).rejects.toMatchObject({ code: "AMBIGUOUS" });
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  it("errors when no project matches", async () => {
    runQuery.mockResolvedValueOnce({ rows: [], total: 0 });
    await expect(dbtCommand.run(["deploy", "ghost"])).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("creates a new project when the fully qualified name does not exist", async () => {
    runQuery
      .mockResolvedValueOnce({ rows: [], total: 0 }) // findProject: not found
      .mockResolvedValueOnce({ rows: [], total: 0 }) // FETCH
      .mockResolvedValueOnce({ rows: [{ name: "dbt_project.yml" }], total: 1 }) // LIST
      .mockResolvedValueOnce({ rows: [], total: 0 }) // CREATE
      .mockResolvedValueOnce({
        rows: [{ name: "VERSION$1", is_last: "true", is_default: "true", git_commit_hash: "abc123def4567" }],
        total: 1,
      }); // SHOW VERSIONS
    const output = (await dbtCommand.run([
      "deploy",
      "stitch_db.metrics.newproj",
      "--repo",
      "d.s.r",
      "--branch",
      "main",
    ])) as Record<string, unknown>;
    expect(runQuery.mock.calls[3][0]).toBe("CREATE DBT PROJECT STITCH_DB.METRICS.NEWPROJ FROM '@D.S.R/branches/main'");
    expect(output).toMatchObject({ project: "STITCH_DB.METRICS.NEWPROJ", created: true, version: "VERSION$1" });
  });

  it("passes DEFAULT_TARGET and EXTERNAL_ACCESS_INTEGRATIONS when creating", async () => {
    runQuery
      .mockResolvedValueOnce({ rows: [], total: 0 })
      .mockResolvedValueOnce({ rows: [], total: 0 })
      .mockResolvedValueOnce({ rows: [{ name: "dbt_project.yml" }], total: 1 })
      .mockResolvedValueOnce({ rows: [], total: 0 })
      .mockResolvedValueOnce({ rows: [{ name: "VERSION$1", is_last: "true" }], total: 1 });
    await dbtCommand.run([
      "deploy",
      "d.s.newproj",
      "--repo",
      "d.s.r",
      "--branch",
      "main",
      "--target",
      "prod",
      "--integrations",
      "DBT_HUB,PIP_ACCESS",
    ]);
    expect(runQuery.mock.calls[3][0]).toBe(
      "CREATE DBT PROJECT D.S.NEWPROJ FROM '@D.S.R/branches/main' DEFAULT_TARGET = 'prod' EXTERNAL_ACCESS_INTEGRATIONS = (DBT_HUB, PIP_ACCESS)",
    );
  });

  it("requires a fully qualified name to create a project", async () => {
    runQuery.mockResolvedValueOnce({ rows: [], total: 0 });
    await expect(dbtCommand.run(["deploy", "ghost", "--repo", "d.s.r", "--branch", "main"])).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  it("requires a git source to create a project", async () => {
    runQuery.mockResolvedValueOnce({ rows: [], total: 0 });
    await expect(dbtCommand.run(["deploy", "d.s.newproj"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  it("rejects --target on an existing project", async () => {
    runQuery.mockResolvedValueOnce({ rows: [GIT_ROW], total: 1 });
    await expect(dbtCommand.run(["deploy", "my_project", "--target", "prod"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(runQuery).toHaveBeenCalledTimes(1);
  });
});

describe("dbt drop", () => {
  it("checks the write grant before anything else", async () => {
    requireGrant.mockImplementation(() => {
      throw Object.assign(new Error("Write capability 'dbt.drop' is not granted"), { code: "WRITE_NOT_ALLOWED" });
    });
    await expect(dbtCommand.run(["drop", "my_project"])).rejects.toMatchObject({ code: "WRITE_NOT_ALLOWED" });
    expect(requireGrant).toHaveBeenCalledWith("dbt.drop");
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("resolves and drops an existing project", async () => {
    runQuery.mockResolvedValueOnce({ rows: [PROJECT_ROW], total: 1 }).mockResolvedValueOnce({ rows: [], total: 0 });
    const output = (await dbtCommand.run(["drop", "my_project"])) as Record<string, unknown>;
    expect(runQuery.mock.calls[1][0]).toBe("DROP DBT PROJECT IF EXISTS STITCH_DB.METRICS.MY_PROJECT");
    expect(output).toEqual({ project: "STITCH_DB.METRICS.MY_PROJECT", dropped: true });
  });

  it("threads --role through the lookup and the drop", async () => {
    runQuery.mockResolvedValueOnce({ rows: [PROJECT_ROW], total: 1 }).mockResolvedValueOnce({ rows: [], total: 0 });
    await dbtCommand.run(["drop", "my_project", "--role", "ANALYTICS_ROLE"]);
    expect(runQuery.mock.calls[0][1]).toEqual({ role: "ANALYTICS_ROLE" });
    expect(runQuery.mock.calls[1][1]).toEqual({ role: "ANALYTICS_ROLE" });
  });

  it("is an idempotent no-op when the project is absent", async () => {
    runQuery.mockResolvedValueOnce({ rows: [], total: 0 });
    const output = (await dbtCommand.run(["drop", "d.s.ghost"])) as Record<string, unknown>;
    expect(output).toMatchObject({ dropped: false, note: "not found (no-op)" });
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  it("errors on ambiguous names before dropping", async () => {
    runQuery.mockResolvedValueOnce({ rows: [PROJECT_ROW, OTHER_ROW], total: 2 });
    await expect(dbtCommand.run(["drop", "my_pro"])).rejects.toMatchObject({ code: "AMBIGUOUS" });
    expect(runQuery).toHaveBeenCalledTimes(1);
  });
});

describe("dbt local verbs", () => {
  it("dispatches every local write verb through the dbt.build grant with parsed flags", async () => {
    runLocalDbt.mockResolvedValue({ ok: true });
    for (const verb of ["run", "build", "test", "seed", "snapshot"]) {
      await dbtCommand.run([verb, "--select", "my_model", "--fail-fast"]);
      expect(requireGrant).toHaveBeenLastCalledWith("dbt.build");
      expect(runLocalDbt).toHaveBeenLastCalledWith(
        expect.objectContaining({ verb, select: "my_model", failFast: true, timeoutSeconds: 1800 }),
      );
    }
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("parses the deferral flags on build and compile and forwards them to runLocalDbt", async () => {
    runLocalDbt.mockResolvedValue({ ok: true });
    await dbtCommand.run(["build", "--select", "fct_sales+", "--defer", "--state", "prod", "--favor-state"]);
    expect(runLocalDbt).toHaveBeenLastCalledWith(
      expect.objectContaining({ verb: "build", select: "fct_sales+", defer: true, state: "prod", favorState: true }),
    );

    await dbtCommand.run(["compile", "--state", "prod"]);
    expect(runLocalDbt).toHaveBeenLastCalledWith(
      expect.objectContaining({ verb: "compile", state: "prod", defer: false, favorState: false }),
    );
  });

  it("compile is ungated and offers --full-refresh only where dbt accepts it", async () => {
    runLocalDbt.mockResolvedValue({ ok: true });
    await dbtCommand.run(["compile"]);
    expect(requireGrant).not.toHaveBeenCalled();
    expect(runLocalDbt).toHaveBeenLastCalledWith(expect.objectContaining({ verb: "compile", timeoutSeconds: 600 }));

    await dbtCommand.run(["seed", "--full-refresh"]);
    expect(runLocalDbt).toHaveBeenLastCalledWith(expect.objectContaining({ verb: "seed", fullRefresh: true }));
    await expect(dbtCommand.run(["snapshot", "--full-refresh"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("--full-refresh"),
    });
  });

  it("offers --empty on run and build only, materializing at near-zero cost", async () => {
    runLocalDbt.mockResolvedValue({ ok: true });
    await dbtCommand.run(["build", "--select", "m", "--empty"]);
    expect(runLocalDbt).toHaveBeenLastCalledWith(expect.objectContaining({ verb: "build", empty: true }));
    await dbtCommand.run(["run", "--empty"]);
    expect(runLocalDbt).toHaveBeenLastCalledWith(expect.objectContaining({ verb: "run", empty: true }));
    await expect(dbtCommand.run(["test", "--empty"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("--empty"),
    });
  });
});

describe("dbt ls", () => {
  it("is ungated and forwards selectors to runLocalList", async () => {
    runLocalList.mockResolvedValue({ ok: true });
    await dbtCommand.run(["ls", "--select", "+fct_sales", "--resource-type", "model", "--state", "prod"]);
    expect(requireGrant).not.toHaveBeenCalled();
    expect(runLocalList).toHaveBeenLastCalledWith(
      expect.objectContaining({ select: "+fct_sales", resourceType: "model", state: "prod", timeoutSeconds: 300 }),
    );
    expect(runQuery).not.toHaveBeenCalled();
  });
});

describe("dbt compiled", () => {
  it("reads the model's compiled SQL, ungated", async () => {
    readCompiledSql.mockReturnValue({ model: "fct_sales", sql: "select 1" });
    const output = (await dbtCommand.run(["compiled", "fct_sales", "--project-dir", "sub"])) as Record<string, unknown>;
    expect(requireGrant).not.toHaveBeenCalled();
    expect(readCompiledSql).toHaveBeenCalledWith("fct_sales", "sub");
    expect(output.sql).toBe("select 1");
  });

  it("requires a model positional", async () => {
    await expect(dbtCommand.run(["compiled"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(readCompiledSql).not.toHaveBeenCalled();
  });
});

describe("dbt state", () => {
  it("compiles the whole project into the reference directory, ungated", async () => {
    runLocalDbt.mockResolvedValue({ manifest: "prod-artifacts/manifest.json" });
    await dbtCommand.run(["state", "--target", "prod", "--into", "prod-artifacts"]);
    expect(requireGrant).not.toHaveBeenCalled();
    expect(runLocalDbt).toHaveBeenLastCalledWith(
      expect.objectContaining({ verb: "compile", target: "prod", captureManifestTo: "prod-artifacts" }),
    );
    // The reference must cover the whole DAG, so it is never narrowed by --select.
    expect(runLocalDbt.mock.calls[0][0]).not.toHaveProperty("select", expect.anything());
  });

  it("requires --into before compiling", async () => {
    await expect(dbtCommand.run(["state", "--target", "prod"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runLocalDbt).not.toHaveBeenCalled();
  });
});

describe("dbt verb hints", () => {
  it("points credential-free verbs at the raw dbt CLI without touching Snowflake", async () => {
    await expect(dbtCommand.run(["deps"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "'deps' is not a dbt subcommand",
      suggestions: expect.arrayContaining([expect.stringContaining("needs no Snowflake credentials")]),
    });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("names the valid subcommands for unwrapped verbs", async () => {
    await expect(dbtCommand.run(["docs", "generate"])).rejects.toMatchObject({
      suggestions: expect.arrayContaining([
        expect.stringContaining(
          "Valid subcommands: list, describe, ls, compile, compiled, state, run, build, test, seed, snapshot",
        ),
      ]),
    });
  });
});

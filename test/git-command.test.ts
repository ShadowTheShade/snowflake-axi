import { beforeEach, describe, expect, it, vi } from "vitest";

const runQuery = vi.hoisted(() => vi.fn());
vi.mock("../src/snowflake.js", () => ({ runQuery }));
const requireGrant = vi.hoisted(() => vi.fn());
vi.mock("../src/grants.js", () => ({ requireGrant }));

import { gitCommand } from "../src/commands/git.js";

const REPO_ROW = {
  name: "CODE_REPO",
  database_name: "ANALYTICS_DB",
  schema_name: "PUBLIC",
  origin: "https://bitbucket.org/org/snowflake-dbt.git",
  last_fetched_at: "2026-07-07 18:30:12.457Z",
  repository_size: "5125246",
};

const BRANCH_ROW = {
  name: "development",
  path: "/branches/development",
  checkouts: "",
  commit_hash: "0fad10474952abc123",
};

beforeEach(() => {
  runQuery.mockReset();
  requireGrant.mockReset();
});

describe("git list", () => {
  it("lists account-wide by default with a minimal schema", async () => {
    runQuery.mockResolvedValueOnce({ rows: [REPO_ROW], total: 1 });
    const output = (await gitCommand.run([])) as Record<string, unknown>;
    expect(runQuery.mock.calls[0][0]).toBe("SHOW GIT REPOSITORIES IN ACCOUNT");
    expect(output.count).toBe("1 git repositories");
    expect(output.repositories).toEqual([
      {
        name: "CODE_REPO",
        scope: "ANALYTICS_DB.PUBLIC",
        origin: "https://bitbucket.org/org/snowflake-dbt.git",
        last_fetched: "2026-07-07",
      },
    ]);
  });

  it("scopes to a database or schema from the positional", async () => {
    runQuery.mockResolvedValue({ rows: [], total: 0 });
    await gitCommand.run(["my_db"]);
    expect(runQuery.mock.calls[0][0]).toBe("SHOW GIT REPOSITORIES IN DATABASE MY_DB");
    await gitCommand.run(["my_db.public"]);
    expect(runQuery.mock.calls[1][0]).toBe("SHOW GIT REPOSITORIES IN SCHEMA MY_DB.PUBLIC");
  });

  it("wraps bare --like words as contains patterns", async () => {
    runQuery.mockResolvedValueOnce({ rows: [REPO_ROW], total: 1 });
    await gitCommand.run(["--like", "dbt"]);
    expect(runQuery.mock.calls[0][0]).toBe("SHOW GIT REPOSITORIES LIKE '%dbt%' IN ACCOUNT");
  });

  it("rejects unsafe --like patterns before querying", async () => {
    await expect(gitCommand.run(["--like", "x' OR '1"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("reports empty scopes definitively", async () => {
    runQuery.mockResolvedValueOnce({ rows: [], total: 0 });
    const output = (await gitCommand.run(["--like", "nope"])) as Record<string, unknown>;
    expect(output.count).toBe("0 git repositories matching '%nope%' in account");
  });
});

describe("git branches", () => {
  it("lists branches with short commit hashes", async () => {
    runQuery.mockResolvedValueOnce({ rows: [BRANCH_ROW], total: 1 });
    const output = (await gitCommand.run(["branches", "analytics_db.public.code_repo"])) as Record<string, unknown>;
    expect(runQuery.mock.calls[0][0]).toBe("SHOW GIT BRANCHES IN ANALYTICS_DB.PUBLIC.CODE_REPO");
    expect(output.repository).toBe("ANALYTICS_DB.PUBLIC.CODE_REPO");
    expect(output.branches).toEqual([{ name: "development", commit: "0fad10474952" }]);
  });

  it("truncates with a help hint and filters with --like", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ ...BRANCH_ROW, name: `b${i}` }));
    runQuery.mockResolvedValueOnce({ rows, total: 5 });
    const output = (await gitCommand.run(["branches", "d.s.r", "--like", "b", "--limit", "2"])) as Record<
      string,
      unknown
    >;
    expect(runQuery.mock.calls[0][0]).toBe("SHOW GIT BRANCHES LIKE '%b%' IN D.S.R");
    expect((output.branches as unknown[]).length).toBe(2);
    expect((output.help as string[])[0]).toContain("Showing 2 of 5");
  });

  it("reports an empty repository definitively", async () => {
    runQuery.mockResolvedValueOnce({ rows: [], total: 0 });
    const output = (await gitCommand.run(["branches", "d.s.r"])) as Record<string, unknown>;
    expect(output.count).toBe("0 branches in D.S.R");
  });

  it("rejects a repository name that is not fully qualified", async () => {
    await expect(gitCommand.run(["branches", "just_repo"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runQuery).not.toHaveBeenCalled();
  });
});

describe("git fetch", () => {
  it("checks the write grant before anything else", async () => {
    requireGrant.mockImplementation(() => {
      throw Object.assign(new Error("Write capability 'git.fetch' is not granted"), { code: "WRITE_NOT_ALLOWED" });
    });
    await expect(gitCommand.run(["fetch", "d.s.r"])).rejects.toMatchObject({ code: "WRITE_NOT_ALLOWED" });
    expect(requireGrant).toHaveBeenCalledWith("git.fetch");
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("fetches then reports the refreshed repository", async () => {
    runQuery.mockResolvedValueOnce({ rows: [], total: 0 }).mockResolvedValueOnce({ rows: [REPO_ROW], total: 1 });
    const output = (await gitCommand.run(["fetch", "analytics_db.public.code_repo"])) as Record<string, unknown>;
    expect(runQuery.mock.calls[0][0]).toBe("ALTER GIT REPOSITORY ANALYTICS_DB.PUBLIC.CODE_REPO FETCH");
    expect(runQuery.mock.calls[1][0]).toBe("SHOW GIT REPOSITORIES LIKE 'CODE_REPO' IN SCHEMA ANALYTICS_DB.PUBLIC");
    expect(output).toMatchObject({
      repository: "ANALYTICS_DB.PUBLIC.CODE_REPO",
      fetched: "2026-07-07 18:30:12.457Z",
      size: "4.9MB",
    });
  });

  it("threads --role and --timeout through the fetch", async () => {
    runQuery.mockResolvedValueOnce({ rows: [], total: 0 }).mockResolvedValueOnce({ rows: [REPO_ROW], total: 1 });
    await gitCommand.run(["fetch", "analytics_db.public.code_repo", "--role", "ANALYTICS_ROLE", "--timeout", "120"]);
    expect(runQuery.mock.calls[0][1]).toEqual({ role: "ANALYTICS_ROLE", timeoutSeconds: 120 });
    expect(runQuery.mock.calls[1][1]).toEqual({ role: "ANALYTICS_ROLE" });
  });
});

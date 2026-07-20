import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AxiError } from "axi-sdk-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

const loadPgConfig = vi.hoisted(() => vi.fn());
const loadDbtPgConfig = vi.hoisted(() => vi.fn());
const requireGrant = vi.hoisted(() => vi.fn());
vi.mock("../src/config.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/config.js")>()),
  loadPgConfig,
  loadDbtPgConfig,
}));
vi.mock("../src/grants.js", () => ({ requireGrant }));

import {
  buildEphemeralPgProfile,
  DBT_PG_PASSWORD_ENV,
  type PgDbtArgs,
  resolvePgTarget,
  runPgDbt,
  splitPgDbtArgs,
} from "../src/pg-dbt.js";

const PG = {
  host: "pg.internal",
  port: 5432,
  database: "prod",
  user: "svc",
  password: "sekret",
  sslmode: "require",
} as const;

let dir: string;
let stderrSpy: { mockRestore(): void };

beforeEach(() => {
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  dir = mkdtempSync(join(tmpdir(), "axi-pg-dbt-"));
  loadPgConfig.mockReset();
  loadPgConfig.mockReturnValue({ ...PG });
  loadDbtPgConfig.mockReset();
  loadDbtPgConfig.mockReturnValue({ projectDir: undefined, target: undefined, bin: undefined });
  requireGrant.mockReset();
});

afterEach(() => {
  stderrSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

function expectAxi(fn: () => unknown, code: string, messagePart: string): AxiError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  const axi = caught as AxiError;
  expect(axi, `expected an AxiError with code ${code}`).toBeDefined();
  expect(axi.code).toBe(code);
  expect(axi.message).toContain(messagePart);
  return axi;
}

describe("splitPgDbtArgs", () => {
  it("peels our flags and forwards the rest to dbt verbatim, order preserved", () => {
    const parsed = splitPgDbtArgs([
      "build",
      "--select",
      "tag:serving_pg",
      "--database",
      "serving_dev",
      "--target",
      "serving_pg",
      "--timeout",
      "60",
    ]);
    expect(parsed).toEqual<PgDbtArgs>({
      database: "serving_dev",
      target: "serving_pg",
      projectDir: undefined,
      timeoutSeconds: 60,
      dbtArgs: ["build", "--select", "tag:serving_pg"],
    });
  });

  it("accepts --flag=value form", () => {
    const parsed = splitPgDbtArgs(["compile", "--database=serving_dev", "--select", "srv_gl_detail"]);
    expect(parsed.database).toBe("serving_dev");
    expect(parsed.dbtArgs).toEqual(["compile", "--select", "srv_gl_detail"]);
  });

  it("defaults the timeout and leaves our flags unset", () => {
    const parsed = splitPgDbtArgs(["ls"]);
    expect(parsed.timeoutSeconds).toBe(1800);
    expect(parsed.database).toBeUndefined();
    expect(parsed.dbtArgs).toEqual(["ls"]);
  });

  it("rejects injected flags passed through to dbt", () => {
    expectAxi(() => splitPgDbtArgs(["compile", "-t", "prod"]), "VALIDATION_ERROR", "Pass --target to");
    expectAxi(() => splitPgDbtArgs(["compile", "--profiles-dir", "/x"]), "VALIDATION_ERROR", "Pass --profiles-dir to");
  });

  it("rejects a non-identifier database and a bad timeout", () => {
    expectAxi(() => splitPgDbtArgs(["compile", "--database", "bad-name"]), "VALIDATION_ERROR", "Invalid database");
    expectAxi(() => splitPgDbtArgs(["compile", "--timeout", "0"]), "VALIDATION_ERROR", "--timeout");
  });

  it("rejects a value flag with no value", () => {
    expectAxi(() => splitPgDbtArgs(["compile", "--database"]), "VALIDATION_ERROR", "requires a value");
  });
});

describe("resolvePgTarget", () => {
  const profile = {
    outputs: { serving_pg: { type: "postgres" }, serving_dev: { type: "postgres" }, sf: { type: "snowflake" } },
    defaultTarget: "serving_pg",
  };

  it("prefers flag, then configured, then the profile default", () => {
    expect(resolvePgTarget(profile, "serving_dev", "serving_pg").name).toBe("serving_dev");
    expect(resolvePgTarget(profile, undefined, "serving_dev").name).toBe("serving_dev");
    expect(resolvePgTarget(profile, undefined, undefined).name).toBe("serving_pg");
  });

  it("lists the targets when none is resolvable", () => {
    const error = expectAxi(
      () => resolvePgTarget({ outputs: profile.outputs }, undefined, undefined),
      "VALIDATION_ERROR",
      "Choose a dbt target",
    );
    expect(error.suggestions[0]).toContain("serving_pg, serving_dev, sf");
  });

  it("rejects unknown and non-postgres targets", () => {
    expectAxi(() => resolvePgTarget(profile, "nope", undefined), "VALIDATION_ERROR", "Unknown dbt target");
    expectAxi(() => resolvePgTarget(profile, "sf", undefined), "CONFIG_ERROR", "needs a postgres target");
  });
});

describe("buildEphemeralPgProfile", () => {
  it("replaces the connection with the tool's creds and keeps the password off disk", () => {
    const output = {
      type: "postgres",
      host: "committed.host",
      user: "committed_user",
      password: "committed_pw",
      dbname: "committed_db",
      port: 9999,
      sslmode: "disable",
      schema: "analytics",
      threads: 8,
    };
    const profile = buildEphemeralPgProfile("demo", "serving_pg", output, { ...PG }, "serving_dev") as {
      demo: { target: string; outputs: { serving_pg: Record<string, unknown> } };
    };
    const target = profile.demo.outputs.serving_pg;
    expect(profile.demo.target).toBe("serving_pg");
    expect(target).toMatchObject({
      type: "postgres",
      host: "pg.internal",
      port: 5432,
      user: "svc",
      dbname: "serving_dev",
      sslmode: "require",
      schema: "analytics",
      threads: 8,
    });
    // The password is an env-var reference, never the literal.
    expect(target.password).toBe(`{{ env_var('${DBT_PG_PASSWORD_ENV}') }}`);
    expect(JSON.stringify(profile)).not.toContain("committed");
  });

  it("defaults threads when the target omits them", () => {
    const profile = buildEphemeralPgProfile("demo", "t", { type: "postgres" }, { ...PG }, "prod") as {
      demo: { outputs: { t: { threads: number } } };
    };
    expect(profile.demo.outputs.t.threads).toBe(4);
  });
});

/** A fake dbt that records its argv/env/profile, then writes run_results.json into the project's target dir. */
function installFakeDbt(script: string): { bin: string; capture: string } {
  const binDir = join(dir, "bin");
  const capture = join(dir, "capture");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(capture, { recursive: true });
  const bin = join(binDir, "dbt");
  writeFileSync(
    bin,
    `#!/bin/sh
printf '%s\\n' "$@" > "${capture}/argv.txt"
printf '%s' "$${DBT_PG_PASSWORD_ENV}" > "${capture}/password.txt"
while [ $# -gt 0 ]; do
  if [ "$1" = "--profiles-dir" ]; then cp "$2/profiles.yml" "${capture}/profile.yml"; fi
  shift
done
${script}`,
    { mode: 0o755 },
  );
  return { bin, capture };
}

function writeProject(profilesYml: string): string {
  const project = join(dir, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "dbt_project.yml"), "name: demo\nprofile: demo\n");
  writeFileSync(join(project, "profiles.yml"), profilesYml);
  return project;
}

const PROJECT_PROFILES = `demo:
  target: serving_pg
  outputs:
    serving_pg:
      type: postgres
      host: "committed.host"
      user: committed_user
      password: "{{ env_var('X') }}"
      dbname: committed_db
      schema: analytics
      threads: 8
`;

function runResults(entries: Array<{ id: string; status: string; message?: string }>): string {
  return JSON.stringify({
    results: entries.map((entry) => ({
      unique_id: entry.id,
      status: entry.status,
      execution_time: 1.2,
      message: entry.message ?? "",
    })),
  });
}

function shimWriting(project: string, json: string, exitCode: number): string {
  const results = join(dir, "results.json");
  writeFileSync(results, json);
  return `mkdir -p "${join(project, "target")}"
cp "${results}" "${join(project, "target", "run_results.json")}"
exit ${exitCode}`;
}

describe("runPgDbt", () => {
  it("runs a read verb free, injects the tool's creds, and summarizes run_results", async () => {
    const project = writeProject(PROJECT_PROFILES);
    const { bin, capture } = installFakeDbt(
      shimWriting(project, runResults([{ id: "model.demo.srv_gl_detail", status: "success" }]), 0),
    );
    loadDbtPgConfig.mockReturnValue({ bin, projectDir: project, target: undefined });

    const result = await runPgDbt(["compile", "--select", "srv_gl_detail", "--database", "serving_dev"]);

    expect(requireGrant).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      project: "demo",
      target: "serving_pg",
      database: "serving_dev",
      command: "dbt compile --select srv_gl_detail",
      count: "1 nodes (1 success)",
    });

    const argv = readFileSync(join(capture, "argv.txt"), "utf8").split("\n");
    expect(argv).toContain("--no-version-check");
    expect(argv).toContain("--project-dir");
    expect(argv).toContain(project);
    // The injected target and the passthrough selector both reach dbt.
    expect(argv).toContain("srv_gl_detail");
    expect(argv.filter((a) => a === "serving_pg")).toHaveLength(1);

    expect(readFileSync(join(capture, "password.txt"), "utf8")).toBe("sekret");
    const profile = parseYaml(readFileSync(join(capture, "profile.yml"), "utf8")) as {
      demo: { outputs: { serving_pg: Record<string, unknown> } };
    };
    expect(profile.demo.outputs.serving_pg).toMatchObject({ host: "pg.internal", user: "svc", dbname: "serving_dev" });
  });

  it("gates a write verb behind pg.write", async () => {
    const project = writeProject(PROJECT_PROFILES);
    const { bin } = installFakeDbt(shimWriting(project, runResults([{ id: "model.demo.m", status: "success" }]), 0));
    loadDbtPgConfig.mockReturnValue({ bin, projectDir: project, target: undefined });

    await runPgDbt(["build", "--select", "m"]);
    expect(requireGrant).toHaveBeenCalledWith("pg.write");
  });

  it("defaults the database to the pg connection when --database is omitted", async () => {
    const project = writeProject(PROJECT_PROFILES);
    const { bin, capture } = installFakeDbt(shimWriting(project, runResults([]), 0));
    loadDbtPgConfig.mockReturnValue({ bin, projectDir: project, target: undefined });

    const result = await runPgDbt(["compile"]);
    expect(result).toMatchObject({ database: "prod", status: "succeeded" });
    const profile = parseYaml(readFileSync(join(capture, "profile.yml"), "utf8")) as {
      demo: { outputs: { serving_pg: { dbname: string } } };
    };
    expect(profile.demo.outputs.serving_pg.dbname).toBe("prod");
  });

  it("raises DBT_ERROR with the failing nodes", async () => {
    const project = writeProject(PROJECT_PROFILES);
    const { bin } = installFakeDbt(
      shimWriting(project, runResults([{ id: "model.demo.bad", status: "error", message: "boom" }]), 1),
    );
    loadDbtPgConfig.mockReturnValue({ bin, projectDir: project, target: undefined });

    const error = (await runPgDbt(["build", "--select", "bad"]).catch((e) => e)) as AxiError;
    expect(error.code).toBe("DBT_ERROR");
    expect(error.suggestions.join(" ")).toContain("bad: boom");
  });

  it("refuses when no dbt command is given", async () => {
    await expect(runPgDbt(["--database", "serving_dev"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

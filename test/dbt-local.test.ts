import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AxiError } from "axi-sdk-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("../src/config.js", () => ({
  loadConfig,
  envFilePath: () => "/home/user/.config/snowflake-axi/env",
}));

import {
  buildEphemeralProfile,
  DBT_PASSWORD_ENV,
  loadOutputs,
  resolveProject,
  resolveTarget,
  runLocalDbt,
} from "../src/dbt-local.js";

let dir: string;
const originalPath = process.env.PATH;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "axi-dbt-local-"));
  loadConfig.mockReset();
  loadConfig.mockReturnValue({ account: "MYACCT", user: "SVC_USER", token: "sekret-token", dbtTarget: undefined });
});

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.FAKE_CAPTURE;
  rmSync(dir, { recursive: true, force: true });
});

function writeProjectFiles(profilesYml?: string): void {
  writeFileSync(join(dir, "dbt_project.yml"), "name: demo\nprofile: demo\n");
  if (profilesYml !== undefined) writeFileSync(join(dir, "profiles.yml"), profilesYml);
}

const PROFILES = `demo:
  target: dev
  outputs:
    dev:
      type: snowflake
      account: ""
      user: ""
      role: MY_ROLE
      database: MY_DB
      schema: MY_SCHEMA
      warehouse: MY_WH
      threads: 4
    keypair:
      type: snowflake
      account: "{{ env_var('SNOWFLAKE_ACCOUNT') }}"
      user: someone
      authenticator: snowflake_jwt
      private_key_path: /tmp/key.pem
      role: OTHER_ROLE
      database: OTHER_DB
      schema: PUBLIC
      warehouse: "{{ env_var('WH', 'DEV_WH') }}"
`;

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

describe("resolveProject", () => {
  it("fails definitively outside a dbt project", () => {
    expectAxi(() => resolveProject(dir), "NOT_FOUND", "No dbt_project.yml");
  });

  it("reads name, profile, and a custom target-path", () => {
    writeFileSync(join(dir, "dbt_project.yml"), "name: demo\nprofile: revenue\ntarget-path: out\n");
    const project = resolveProject(dir);
    expect(project).toMatchObject({ name: "demo", profileName: "revenue", targetPath: "out" });
  });

  it("requires a profile entry", () => {
    writeFileSync(join(dir, "dbt_project.yml"), "name: demo\n");
    expectAxi(() => resolveProject(dir), "CONFIG_ERROR", "no profile: entry");
  });
});

describe("loadOutputs", () => {
  it("requires a committed profiles.yml", () => {
    writeProjectFiles();
    expectAxi(() => loadOutputs(resolveProject(dir)), "CONFIG_ERROR", "No profiles.yml");
  });

  it("names the available profiles when the wanted one is missing", () => {
    writeProjectFiles("other:\n  outputs: {}\n");
    const error = expectAxi(() => loadOutputs(resolveProject(dir)), "CONFIG_ERROR", "no profile 'demo'");
    expect(error.suggestions[0]).toContain("other");
  });

  it("returns the outputs map", () => {
    writeProjectFiles(PROFILES);
    expect(Object.keys(loadOutputs(resolveProject(dir)))).toEqual(["dev", "keypair"]);
  });
});

describe("resolveTarget", () => {
  const outputs = { dev: { type: "snowflake" }, prod: { type: "snowflake" }, pg: { type: "postgres" } };

  it("lists the repo's targets when none is chosen", () => {
    const error = expectAxi(() => resolveTarget(outputs, undefined, undefined), "VALIDATION_ERROR", "--target");
    expect(error.suggestions[0]).toContain("dev, prod, pg");
    expect(error.suggestions[1]).toContain("SNOWFLAKE_AXI_DBT_TARGET");
  });

  it("prefers the flag over the configured default", () => {
    expect(resolveTarget(outputs, "prod", "dev")).toBe("prod");
    expect(resolveTarget(outputs, undefined, "dev")).toBe("dev");
  });

  it("rejects unknown and non-snowflake targets", () => {
    expectAxi(() => resolveTarget(outputs, "nope", undefined), "VALIDATION_ERROR", "Unknown dbt target");
    expectAxi(() => resolveTarget(outputs, "pg", undefined), "CONFIG_ERROR", "type 'postgres'");
  });
});

describe("buildEphemeralProfile", () => {
  it("replaces every auth field and carries the rest, jinja included", () => {
    writeProjectFiles(PROFILES);
    const outputs = loadOutputs(resolveProject(dir));
    const profile = buildEphemeralProfile("demo", "keypair", outputs.keypair, {
      account: "MYACCT",
      user: "SVC_USER",
    });
    const target = (profile.demo as { outputs: Record<string, Record<string, unknown>> }).outputs.keypair;
    expect(target.account).toBe("MYACCT");
    expect(target.user).toBe("SVC_USER");
    expect(target.password).toBe(`{{ env_var('${DBT_PASSWORD_ENV}') }}`);
    expect(target.authenticator).toBeUndefined();
    expect(target.private_key_path).toBeUndefined();
    expect(target.role).toBe("OTHER_ROLE");
    expect(target.warehouse).toBe("{{ env_var('WH', 'DEV_WH') }}");
  });
});

/** Installs a fake `dbt` on PATH; capture lands in $FAKE_CAPTURE. */
function installShim(script: string): string {
  const binDir = join(dir, "bin");
  const captureDir = join(dir, "capture");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(captureDir, { recursive: true });
  writeFileSync(
    join(binDir, "dbt"),
    `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_CAPTURE/argv.txt"
printf '%s' "$${DBT_PASSWORD_ENV}" > "$FAKE_CAPTURE/password.txt"
while [ $# -gt 0 ]; do
  if [ "$1" = "--profiles-dir" ]; then
    printf '%s' "$2" > "$FAKE_CAPTURE/profiles_dir.txt"
    cp "$2/profiles.yml" "$FAKE_CAPTURE/profile.yml"
  fi
  shift
done
${script}`,
    { mode: 0o755 },
  );
  process.env.PATH = `${binDir}:${originalPath}`;
  process.env.FAKE_CAPTURE = captureDir;
  return captureDir;
}

function runResults(entries: Array<{ id: string; status: string; message?: string }>): string {
  return JSON.stringify({
    results: entries.map((entry) => ({
      unique_id: entry.id,
      status: entry.status,
      execution_time: 1.234,
      message: entry.message ?? "",
    })),
  });
}

function shimWritingResults(json: string, exitCode: number): string {
  writeFileSync(join(dir, "results.json"), json);
  return installShim(`mkdir -p "${join(dir, "target")}"
cp "${join(dir, "results.json")}" "${join(dir, "target", "run_results.json")}"
exit ${exitCode}`);
}

describe("runLocalDbt", () => {
  it("summarizes a successful build and never writes the token to disk", async () => {
    writeProjectFiles(PROFILES);
    const capture = shimWritingResults(
      runResults([
        { id: "model.demo.stg_flavors", status: "success", message: "SUCCESS 1" },
        { id: "test.demo.unique_stg_flavors_id.abc123", status: "pass" },
      ]),
      0,
    );

    const output = await runLocalDbt({ verb: "build", projectDir: dir, target: "dev", timeoutSeconds: 30 });
    expect(output.project).toBe("demo");
    expect(output.target).toBe("dev");
    expect(output.count).toBe("2 nodes (1 success, 1 pass)");
    expect((output.nodes as Array<{ node: string }>)[0].node).toBe("stg_flavors");

    const written = parseYaml(readFileSync(join(capture, "profile.yml"), "utf8")) as Record<string, unknown>;
    const target = (written.demo as { outputs: Record<string, Record<string, unknown>> }).outputs.dev;
    expect(target.account).toBe("MYACCT");
    expect(target.password).toBe(`{{ env_var('${DBT_PASSWORD_ENV}') }}`);
    expect(readFileSync(join(capture, "profile.yml"), "utf8")).not.toContain("sekret-token");
    expect(readFileSync(join(capture, "password.txt"), "utf8")).toBe("sekret-token");

    const argv = readFileSync(join(capture, "argv.txt"), "utf8").split("\n");
    expect(argv).toContain("build");
    expect(argv).toContain("--target");
    const ephemeralDir = readFileSync(join(capture, "profiles_dir.txt"), "utf8");
    expect(existsSync(ephemeralDir)).toBe(false);
  });

  it("reports per-node failures as a structured error", async () => {
    writeProjectFiles(PROFILES);
    shimWritingResults(
      runResults([
        { id: "model.demo.stg_flavors", status: "success", message: "SUCCESS 1" },
        { id: "model.demo.fct_sales", status: "error", message: "Database Error: invalid identifier 'FOO'" },
      ]),
      1,
    );

    const promise = runLocalDbt({ verb: "build", projectDir: dir, target: "dev", timeoutSeconds: 30 });
    await expect(promise).rejects.toMatchObject({
      code: "DBT_ERROR",
      message: expect.stringContaining("1 of 2 nodes failed"),
      suggestions: [expect.stringContaining("fct_sales: Database Error")],
    });
  });

  it("surfaces log errors when dbt dies before writing results", async () => {
    writeProjectFiles(PROFILES);
    installShim(`echo "14:22:01  Compilation Error in model foo"
exit 2`);

    const promise = runLocalDbt({ verb: "compile", projectDir: dir, target: "dev", timeoutSeconds: 30 });
    await expect(promise).rejects.toMatchObject({
      code: "DBT_ERROR",
      message: expect.stringContaining("failed before producing results"),
      suggestions: [expect.stringContaining("Compilation Error in model foo")],
    });
  });

  it("summarizes compile with counts only and reports empty selections definitively", async () => {
    writeProjectFiles(PROFILES);
    shimWritingResults(runResults([{ id: "model.demo.stg_flavors", status: "success" }]), 0);
    const compiled = await runLocalDbt({ verb: "compile", projectDir: dir, target: "dev", timeoutSeconds: 30 });
    expect(compiled.count).toBe("1 nodes compiled");
    expect(compiled.nodes).toBeUndefined();

    shimWritingResults(runResults([]), 0);
    const empty = await runLocalDbt({
      verb: "build",
      projectDir: dir,
      target: "dev",
      select: "nothing_here",
      timeoutSeconds: 30,
    });
    expect(empty.count).toBe("0 nodes matched --select 'nothing_here'");
  });

  it("uses the configured default target when no flag is given", async () => {
    loadConfig.mockReturnValue({ account: "MYACCT", user: "SVC_USER", token: "sekret-token", dbtTarget: "dev" });
    writeProjectFiles(PROFILES);
    const capture = shimWritingResults(runResults([{ id: "model.demo.stg_flavors", status: "success" }]), 0);
    const output = await runLocalDbt({ verb: "compile", projectDir: dir, timeoutSeconds: 30 });
    expect(output.target).toBe("dev");
    expect(readFileSync(join(capture, "argv.txt"), "utf8")).toContain("dev");
  });

  it("fails with an install hint when dbt is missing", async () => {
    writeProjectFiles(PROFILES);
    const emptyBin = join(dir, "empty-bin");
    mkdirSync(emptyBin);
    process.env.PATH = emptyBin;
    const promise = runLocalDbt({ verb: "compile", projectDir: dir, target: "dev", timeoutSeconds: 30 });
    await expect(promise).rejects.toMatchObject({
      code: "CONFIG_ERROR",
      suggestions: [expect.stringContaining("uv tool install dbt-core")],
    });
  });

  it("kills a hung dbt after --timeout", async () => {
    writeProjectFiles(PROFILES);
    installShim("exec sleep 30");
    const promise = runLocalDbt({ verb: "compile", projectDir: dir, target: "dev", timeoutSeconds: 1 });
    await expect(promise).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

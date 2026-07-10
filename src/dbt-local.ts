import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AxiError } from "axi-sdk-js";
import { parse as parseYaml } from "yaml";
import { envFilePath, loadConfig } from "./config.js";

/**
 * Local dbt: spawns the dbt CLI against the project in the working directory,
 * injecting the tool's credentials into an ephemeral profile so a repo can
 * keep its committed profiles.yml credential-less (the dbt Projects on
 * Snowflake layout, where the server session supplies auth the same way).
 * The token itself never touches disk: the generated profile references an
 * env var that only the dbt subprocess receives.
 */

export const DBT_PASSWORD_ENV = "SNOWFLAKE_AXI_DBT_PASSWORD";

// Everything that authenticates a dbt-snowflake target; the ephemeral profile
// replaces these wholesale so local runs always use the tool's identity.
const AUTH_FIELDS = new Set([
  "account",
  "user",
  "password",
  "token",
  "authenticator",
  "private_key",
  "private_key_path",
  "private_key_passphrase",
  "oauth_client_id",
  "oauth_client_secret",
  "refresh_token",
]);

const MAX_NODE_ROWS = 100;
const FAILURE_STATUSES = new Set(["error", "fail", "runtime error"]);

export type LocalVerb = "compile" | "build" | "run" | "test" | "seed" | "snapshot";

export interface LocalDbtOptions {
  verb: LocalVerb;
  projectDir?: string;
  target?: string;
  select?: string;
  exclude?: string;
  fullRefresh?: boolean;
  failFast?: boolean;
  timeoutSeconds: number;
}

export interface DbtProject {
  dir: string;
  name: string;
  profileName: string;
  targetPath: string;
}

function readYaml(file: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(file, "utf8"));
  } catch (error) {
    throw new AxiError(
      `Cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
      "CONFIG_ERROR",
      [
        "dbt tolerates unquoted jinja in YAML but this tool needs plain YAML; quote expressions like \"{{ env_var('X') }}\"",
      ],
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AxiError(`${file} is not a YAML mapping`, "CONFIG_ERROR");
  }
  return parsed as Record<string, unknown>;
}

export function resolveProject(projectDirFlag: string | undefined): DbtProject {
  const dir = resolve(projectDirFlag ?? process.cwd());
  const file = join(dir, "dbt_project.yml");
  if (!existsSync(file)) {
    throw new AxiError(`No dbt_project.yml in ${dir}`, "NOT_FOUND", [
      "Run from a dbt project root, or point at one with --project-dir <path>",
    ]);
  }
  const raw = readYaml(file);
  const profileName = typeof raw.profile === "string" ? raw.profile : undefined;
  if (!profileName) {
    throw new AxiError(`dbt_project.yml in ${dir} has no profile: entry`, "CONFIG_ERROR", [
      "Add `profile: <name>` matching a profile in the repo's profiles.yml",
    ]);
  }
  return {
    dir,
    name: typeof raw.name === "string" ? raw.name : profileName,
    profileName,
    targetPath: typeof raw["target-path"] === "string" ? raw["target-path"] : "target",
  };
}

export function loadOutputs(project: DbtProject): Record<string, Record<string, unknown>> {
  const file = join(project.dir, "profiles.yml");
  if (!existsSync(file)) {
    throw new AxiError(`No profiles.yml next to dbt_project.yml in ${project.dir}`, "CONFIG_ERROR", [
      "Local runs read targets (role, database, schema, warehouse) from the repo's committed credential-less profiles.yml",
      "For a repo that keeps profiles in ~/.dbt instead, run dbt directly with your own profile",
    ]);
  }
  const profiles = readYaml(file);
  const profile = profiles[project.profileName];
  if (typeof profile !== "object" || profile === null) {
    const available = Object.keys(profiles).filter((key) => key !== "config");
    throw new AxiError(
      `profiles.yml has no profile '${project.profileName}' (named by dbt_project.yml)`,
      "CONFIG_ERROR",
      [available.length > 0 ? `Profiles present: ${available.join(", ")}` : "The file defines no profiles"],
    );
  }
  const outputs = (profile as Record<string, unknown>).outputs;
  if (typeof outputs !== "object" || outputs === null) {
    throw new AxiError(`Profile '${project.profileName}' in profiles.yml has no outputs`, "CONFIG_ERROR");
  }
  return Object.fromEntries(
    Object.entries(outputs as Record<string, unknown>).filter(
      (entry): entry is [string, Record<string, unknown>] => typeof entry[1] === "object" && entry[1] !== null,
    ),
  );
}

export function resolveTarget(
  outputs: Record<string, Record<string, unknown>>,
  flag: string | undefined,
  configured: string | undefined,
): string {
  const names = Object.keys(outputs);
  const name = flag ?? configured;
  if (!name) {
    throw new AxiError("Choose a dbt target: pass --target or set SNOWFLAKE_AXI_DBT_TARGET", "VALIDATION_ERROR", [
      `Targets in this repo's profiles.yml: ${names.join(", ")}`,
      `Set SNOWFLAKE_AXI_DBT_TARGET in ${envFilePath()} to make one the default`,
    ]);
  }
  const output = outputs[name];
  if (!output) {
    throw new AxiError(`Unknown dbt target '${name}'`, "VALIDATION_ERROR", [
      `Targets in this repo's profiles.yml: ${names.join(", ")}`,
    ]);
  }
  if (typeof output.type === "string" && output.type !== "snowflake") {
    throw new AxiError(
      `Target '${name}' has type '${output.type}'; only snowflake targets are supported`,
      "CONFIG_ERROR",
    );
  }
  return name;
}

export function buildEphemeralProfile(
  profileName: string,
  targetName: string,
  output: Record<string, unknown>,
  identity: { account: string; user: string },
): Record<string, unknown> {
  const carried = Object.fromEntries(Object.entries(output).filter(([key]) => !AUTH_FIELDS.has(key)));
  return {
    [profileName]: {
      target: targetName,
      outputs: {
        [targetName]: {
          ...carried,
          type: "snowflake",
          account: identity.account,
          user: identity.user,
          password: `{{ env_var('${DBT_PASSWORD_ENV}') }}`,
        },
      },
    },
  };
}

interface DbtExit {
  code: number;
  tail: string[];
}

function runDbt(argv: string[], env: NodeJS.ProcessEnv, timeoutSeconds: number): Promise<DbtExit> {
  return new Promise((resolveExit, reject) => {
    const child = spawn("dbt", argv, { env, stdio: ["ignore", "pipe", "pipe"] });
    let buffered = "";
    const capture = (chunk: Buffer) => {
      process.stderr.write(chunk);
      buffered = (buffered + chunk.toString()).slice(-16384);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutSeconds * 1000);
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        reject(
          new AxiError("The dbt CLI is not installed or not on PATH", "CONFIG_ERROR", [
            "Install it with `uv tool install dbt-core --with dbt-snowflake` (or pipx/pip)",
          ]),
        );
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new AxiError(`dbt did not finish within ${timeoutSeconds}s`, "TIMEOUT", [
            "Raise --timeout, or narrow the run with --select",
          ]),
        );
        return;
      }
      resolveExit({ code: code ?? 1, tail: buffered.split("\n") });
    });
  });
}

interface NodeRow {
  node: string;
  type: string;
  status: string;
  time: string;
  detail: string;
}

function shapeResult(raw: unknown): NodeRow {
  const rec = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const uniqueId = typeof rec.unique_id === "string" ? rec.unique_id : "";
  const [type, , ...rest] = uniqueId.split(".");
  const message = typeof rec.message === "string" ? rec.message : "";
  const seconds = typeof rec.execution_time === "number" ? rec.execution_time : 0;
  return {
    node: rest.join(".") || uniqueId,
    type: type || "node",
    status: String(rec.status ?? ""),
    time: `${seconds.toFixed(1)}s`,
    detail: message.replace(/\s+/g, " ").slice(0, 140),
  };
}

function readRunResults(project: DbtProject, startedMs: number): NodeRow[] | undefined {
  const file = join(project.dir, project.targetPath, "run_results.json");
  try {
    if (statSync(file).mtimeMs < startedMs - 2000) return undefined;
  } catch {
    return undefined;
  }
  let parsed: { results?: unknown };
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as { results?: unknown };
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed.results)) return undefined;
  return parsed.results.map(shapeResult);
}

function statusCounts(rows: NodeRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  return [...counts.entries()].map(([status, n]) => `${n} ${status}`).join(", ");
}

function errorLines(tail: string[]): string[] {
  const cleaned = tail.map((line) => line.replace(/^\d{2}:\d{2}:\d{2}\s+/, "").trim()).filter(Boolean);
  const errors = cleaned.filter((line) => /error/i.test(line));
  const picked = (errors.length > 0 ? errors : cleaned).slice(-8);
  return picked.length > 0 ? picked : ["dbt produced no output; run dbt manually in the project to inspect"];
}

export async function runLocalDbt(options: LocalDbtOptions): Promise<Record<string, unknown>> {
  const config = loadConfig();
  const project = resolveProject(options.projectDir);
  const outputs = loadOutputs(project);
  const targetName = resolveTarget(outputs, options.target, config.dbtTarget);
  const profile = buildEphemeralProfile(project.profileName, targetName, outputs[targetName], config);

  const profilesDir = mkdtempSync(join(tmpdir(), "snowflake-axi-dbt-"));
  const argv = ["--no-use-colors", options.verb, "--profiles-dir", profilesDir, "--project-dir", project.dir];
  argv.push("--target", targetName);
  if (options.select) argv.push("--select", options.select);
  if (options.exclude) argv.push("--exclude", options.exclude);
  if (options.fullRefresh) argv.push("--full-refresh");
  if (options.failFast) argv.push("--fail-fast");

  const started = Date.now();
  let exit: DbtExit;
  try {
    writeFileSync(join(profilesDir, "profiles.yml"), `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
    exit = await runDbt(argv, { ...process.env, [DBT_PASSWORD_ENV]: config.token }, options.timeoutSeconds);
  } finally {
    rmSync(profilesDir, { recursive: true, force: true });
  }

  const elapsed = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  const command = `dbt ${options.verb}${options.select ? ` --select ${options.select}` : ""}`;
  const results = readRunResults(project, started);

  const failures = (results ?? []).filter((row) => FAILURE_STATUSES.has(row.status));
  if (failures.length > 0) {
    throw new AxiError(
      `${command} on ${project.name}: ${failures.length} of ${results?.length} nodes failed`,
      "DBT_ERROR",
      [
        ...failures.slice(0, 20).map((row) => `${row.node}: ${row.detail || row.status}`),
        ...(failures.length > 20 ? [`... and ${failures.length - 20} more failures`] : []),
      ],
    );
  }
  if (exit.code !== 0) {
    throw new AxiError(
      `${command} on ${project.name} failed before producing results`,
      "DBT_ERROR",
      errorLines(exit.tail),
    );
  }

  const base = { project: project.name, target: targetName, command };
  if (!results) return { ...base, status: "succeeded", elapsed };
  if (results.length === 0) {
    return {
      ...base,
      count: `0 nodes matched${options.select ? ` --select '${options.select}'` : ""}`,
      elapsed,
      help: ["Check the selector: dbt matches by name, +ancestors/descendants+, tag:, path:"],
    };
  }
  if (options.verb === "compile") {
    return {
      ...base,
      count: `${results.length} nodes compiled`,
      elapsed,
      help: [
        `Compiled SQL is under ${project.targetPath}/compiled/ in the project`,
        "Run `snowflake-axi dbt run --select <model>` to materialize a model, or `dbt build` to include its tests (write; dbt.build grant)",
      ],
    };
  }
  const shown = results.slice(0, MAX_NODE_ROWS);
  return {
    ...base,
    count: `${results.length} nodes (${statusCounts(results)})`,
    nodes: shown,
    ...(results.length > shown.length ? { note: `first ${shown.length} of ${results.length} nodes shown` } : {}),
    elapsed,
  };
}

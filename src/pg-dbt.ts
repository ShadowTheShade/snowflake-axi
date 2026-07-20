import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { configDir, type DbtPgConfig, IDENTIFIER, loadDbtPgConfig, loadPgConfig, type PgConfig } from "./config.js";
import { type DbtProfile, loadProfile, resolveProject } from "./dbt-local.js";
import {
  type DbtExit,
  errorLines,
  FAILURE_STATUSES,
  type MissingDbt,
  readRunResults,
  spawnDbt,
  statusCounts,
} from "./dbt-run.js";
import { startTimer } from "./format.js";
import { requireGrant } from "./grants.js";

/**
 * Classic dbt-postgres against Snowflake Postgres: a passthrough wrapper that
 * runs a pinned dbt-core + dbt-postgres 1.8 (matching the serving-plane Fargate
 * image, deliberately NOT dbt Fusion) from a managed venv, and injects the
 * tool's Postgres credentials into an ephemeral profile so the repo keeps a
 * credential-less committed profiles.yml. The password never touches disk: the
 * generated profile references an env var that only the dbt subprocess sees.
 * Write verbs (build, run, run-operation, seed, snapshot, test, ...) go behind
 * the same pg.write grant as `pg query --write`.
 */

export const DBT_PG_PASSWORD_ENV = "SNOWFLAKE_AXI_DBT_PG_PASSWORD";

// Pinned to the Fargate runtime so local == prod. `~=1.8` is >=1.8,<1.9.
const RUNTIME_DIRNAME = "dbt-postgres-1.8";
const INSTALL_SPECS = ["dbt-core>=1.8,<1.9", "dbt-postgres>=1.8,<1.9"];
export const RUNTIME_LABEL = "dbt-core 1.8 + dbt-postgres 1.8";

// dbt-postgres identity/endpoint keys, replaced wholesale by the tool's PG
// config so a local run always connects to the tool's endpoint as its identity.
// Everything else the repo's target declares - schema, threads, search_path,
// role, retries, connect_timeout, keepalives - is tuning, not credentials, and
// is carried through verbatim.
const PG_CONN_FIELDS = new Set([
  "host",
  "hostaddr",
  "port",
  "user",
  "username",
  "pass",
  "password",
  "dbname",
  "database",
  "sslmode",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "sslpassword",
]);

// dbt verbs that only read (introspect/compile/inspect); everything else can
// write to the target, so it needs the pg.write grant. Unknown verbs are
// treated as writes - reads-free, writes-by-consent errs on the side of consent.
const READ_VERBS = new Set([
  "compile",
  "ls",
  "list",
  "parse",
  "deps",
  "debug",
  "docs",
  "clean",
  "source",
  "show",
  "init",
  "environment",
]);

const MAX_NODE_ROWS = 100;
const TIMEOUT_DEFAULT = 1800;
const TIMEOUT_MIN = 1;
const TIMEOUT_MAX = 14400;

// Our own flags, peeled off the argv; everything else passes through to dbt.
const OWN_VALUE_FLAGS = new Set(["--database", "--project-dir", "--target", "--timeout"]);
// Flags we inject ourselves and so must not receive twice from the passthrough.
const INJECTED_FLAGS = new Set(["-t", "--profiles-dir"]);

export interface PgDbtArgs {
  database?: string;
  projectDir?: string;
  target?: string;
  timeoutSeconds: number;
  /** dbt argv, verbatim, with our own flags removed. */
  dbtArgs: string[];
}

export function splitPgDbtArgs(raw: string[]): PgDbtArgs {
  const own: Record<string, string> = {};
  const dbtArgs: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (OWN_VALUE_FLAGS.has(name)) {
      const value = eq !== -1 ? arg.slice(eq + 1) : raw[++i];
      if (value === undefined || (eq === -1 && value.startsWith("--"))) {
        throw new AxiError(`Flag ${name} requires a value`, "VALIDATION_ERROR");
      }
      own[name] = value;
    } else {
      dbtArgs.push(arg);
    }
  }

  for (const bad of dbtArgs) {
    if (INJECTED_FLAGS.has(bad)) {
      throw new AxiError(
        `Pass ${bad === "-t" ? "--target" : bad} to \`pg dbt\`, not through to dbt`,
        "VALIDATION_ERROR",
        [
          "--target and the profiles directory are managed by the wrapper (the profile is generated with the tool's creds)",
        ],
      );
    }
  }

  const database = own["--database"];
  if (database !== undefined && !IDENTIFIER.test(database)) {
    throw new AxiError(`Invalid database '${database}'`, "VALIDATION_ERROR", ["Use an unquoted identifier"]);
  }
  let timeoutSeconds = TIMEOUT_DEFAULT;
  if (own["--timeout"] !== undefined) {
    const n = Number(own["--timeout"]);
    if (!Number.isInteger(n) || n < TIMEOUT_MIN || n > TIMEOUT_MAX) {
      throw new AxiError(
        `Flag --timeout must be an integer between ${TIMEOUT_MIN} and ${TIMEOUT_MAX}`,
        "VALIDATION_ERROR",
      );
    }
    timeoutSeconds = n;
  }
  return { database, projectDir: own["--project-dir"], target: own["--target"], timeoutSeconds, dbtArgs };
}

export function resolvePgTarget(
  profile: DbtProfile,
  flag: string | undefined,
  configured: string | undefined,
): { name: string; output: Record<string, unknown> } {
  const names = Object.keys(profile.outputs);
  const name = flag ?? configured ?? profile.defaultTarget;
  if (!name) {
    throw new AxiError("Choose a dbt target: pass --target or set SNOWFLAKE_AXI_DBT_PG_TARGET", "VALIDATION_ERROR", [
      `Targets in this repo's profiles.yml: ${names.join(", ")}`,
      "Or give the profile a `target:` default",
    ]);
  }
  const output = profile.outputs[name];
  if (!output) {
    throw new AxiError(`Unknown dbt target '${name}'`, "VALIDATION_ERROR", [
      `Targets in this repo's profiles.yml: ${names.join(", ")}`,
    ]);
  }
  if (typeof output.type === "string" && output.type !== "postgres") {
    throw new AxiError(
      `Target '${name}' has type '${output.type}'; \`pg dbt\` needs a postgres target`,
      "CONFIG_ERROR",
      ["For a snowflake target, use `snowflake-axi dbt` instead"],
    );
  }
  return { name, output };
}

export function buildEphemeralPgProfile(
  profileName: string,
  targetName: string,
  output: Record<string, unknown>,
  pg: PgConfig,
  database: string,
): Record<string, unknown> {
  const carried = Object.fromEntries(Object.entries(output).filter(([key]) => !PG_CONN_FIELDS.has(key)));
  return {
    [profileName]: {
      target: targetName,
      outputs: {
        [targetName]: {
          threads: 4,
          ...carried,
          type: "postgres",
          host: pg.host,
          port: pg.port,
          user: pg.user,
          password: `{{ env_var('${DBT_PG_PASSWORD_ENV}') }}`,
          dbname: database,
          sslmode: pg.sslmode,
        },
      },
    },
  };
}

function venvBin(venvDir: string, name: string): string {
  return process.platform === "win32" ? join(venvDir, "Scripts", `${name}.exe`) : join(venvDir, "bin", name);
}

function hasCommand(cmd: string): boolean {
  return !spawnSync(cmd, ["--version"], { stdio: "ignore" }).error;
}

function runProvision(cmd: string, args: string[]): void {
  const result = spawnSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
  if (result.error) {
    throw new AxiError(`Could not run ${cmd}: ${result.error.message}`, "CONFIG_ERROR", [
      "Provisioning the dbt-postgres runtime needs uv or python3 on PATH",
    ]);
  }
  if (result.status !== 0) {
    throw new AxiError(
      `${cmd} ${args[0]} failed (exit ${result.status}) provisioning the dbt-postgres runtime`,
      "CONFIG_ERROR",
      ["Check network access to PyPI, or set SNOWFLAKE_AXI_DBT_PG_BIN to a dbt-postgres you manage"],
    );
  }
}

function provision(venvDir: string): void {
  mkdirSync(join(configDir(), "runtimes"), { recursive: true });
  rmSync(venvDir, { recursive: true, force: true });
  process.stderr.write(`Provisioning ${RUNTIME_LABEL} runtime (one-time, this can take a minute)...\n`);
  if (hasCommand("uv")) {
    runProvision("uv", ["venv", venvDir]);
    runProvision("uv", ["pip", "install", "--python", venvBin(venvDir, "python"), ...INSTALL_SPECS]);
  } else if (hasCommand("python3")) {
    runProvision("python3", ["-m", "venv", venvDir]);
    const pip = venvBin(venvDir, "pip");
    runProvision(pip, ["install", "--quiet", "--upgrade", "pip"]);
    runProvision(pip, ["install", ...INSTALL_SPECS]);
  } else {
    throw new AxiError("Cannot provision the dbt-postgres runtime: neither uv nor python3 is on PATH", "CONFIG_ERROR", [
      "Install uv (https://docs.astral.sh/uv/) or python3, then rerun",
      "Or set SNOWFLAKE_AXI_DBT_PG_BIN to a dbt-postgres 1.8 executable you manage",
    ]);
  }
}

/** Resolves the classic dbt-postgres executable, provisioning the managed venv on first use. */
export function ensureDbtPgBin(override: string | undefined): string {
  if (override) {
    if (!existsSync(override)) {
      throw new AxiError(`SNOWFLAKE_AXI_DBT_PG_BIN points at a missing file: ${override}`, "CONFIG_ERROR", [
        "Set it to a dbt-postgres executable, or unset it to use the managed venv",
      ]);
    }
    return override;
  }
  const venvDir = join(configDir(), "runtimes", RUNTIME_DIRNAME);
  const bin = venvBin(venvDir, "dbt");
  if (existsSync(bin)) return bin;
  provision(venvDir);
  if (!existsSync(bin)) {
    throw new AxiError(`Provisioned the venv but found no dbt at ${bin}`, "CONFIG_ERROR", [
      "Remove the runtimes directory and rerun to reprovision",
    ]);
  }
  return bin;
}

const missingRuntime =
  (bin: string): MissingDbt =>
  () =>
    new AxiError(`The dbt-postgres runtime is missing at ${bin}`, "CONFIG_ERROR", [
      "Remove the runtimes directory under the config dir and rerun to reprovision",
    ]);

export async function runPgDbt(raw: string[]): Promise<Record<string, unknown>> {
  const parsed = splitPgDbtArgs(raw);
  const verb = parsed.dbtArgs.find((arg) => !arg.startsWith("-"));
  if (!verb) {
    throw new AxiError("No dbt command given", "VALIDATION_ERROR", [
      "Run `snowflake-axi pg dbt <command>`, e.g. `pg dbt compile` or `pg dbt build --select <selector>`",
    ]);
  }
  // Gate writes before doing any work (including provisioning the runtime).
  if (!READ_VERBS.has(verb)) requireGrant("pg.write");

  const config: DbtPgConfig = loadDbtPgConfig();
  const pg = loadPgConfig();
  const project = resolveProject(parsed.projectDir ?? config.projectDir);
  const profile = loadProfile(project);
  const { name: targetName, output } = resolvePgTarget(profile, parsed.target, config.target);

  const bin = ensureDbtPgBin(config.bin);
  const dbname = parsed.database ?? pg.database;
  const ephemeral = buildEphemeralPgProfile(project.profileName, targetName, output, pg, dbname);
  const profilesDir = mkdtempSync(join(tmpdir(), "snowflake-axi-pgdbt-"));
  writeFileSync(join(profilesDir, "profiles.yml"), `${JSON.stringify(ephemeral, null, 2)}\n`, { mode: 0o600 });

  const argv = [
    "--no-use-colors",
    "--no-version-check",
    ...parsed.dbtArgs,
    "--project-dir",
    project.dir,
    "--profiles-dir",
    profilesDir,
    "--target",
    targetName,
  ];
  const env = { ...process.env, [DBT_PG_PASSWORD_ENV]: pg.password };

  const started = Date.now();
  const timer = startTimer();
  let exit: DbtExit;
  try {
    exit = await spawnDbt(bin, argv, env, parsed.timeoutSeconds, missingRuntime(bin));
  } finally {
    rmSync(profilesDir, { recursive: true, force: true });
  }

  const elapsed = timer();
  const command = `dbt ${parsed.dbtArgs.join(" ")}`;
  const base = { runtime: RUNTIME_LABEL, project: project.name, target: targetName, database: dbname, command };
  const results = readRunResults(join(project.dir, project.targetPath, "run_results.json"), started);

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
    throw new AxiError(`${command} on ${project.name} failed`, "DBT_ERROR", errorLines(exit.tail));
  }
  if (!results || results.length === 0) return { ...base, status: "succeeded", elapsed };
  const shown = results.slice(0, MAX_NODE_ROWS);
  return {
    ...base,
    count: `${results.length} nodes (${statusCounts(results)})`,
    nodes: shown,
    ...(results.length > shown.length ? { note: `first ${shown.length} of ${results.length} nodes shown` } : {}),
    elapsed,
  };
}

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AxiError } from "axi-sdk-js";
import { parse as parseYaml } from "yaml";
import { type AuthMode, envFilePath, loadConfig } from "./config.js";
import { type DbtExit, errorLines, FAILURE_STATUSES, readRunResults, spawnDbt, statusCounts } from "./dbt-run.js";
import { startTimer } from "./format.js";
import { hasLogin, refreshedAccessToken } from "./oauth.js";

/**
 * Local dbt: spawns the dbt CLI against the project in the working directory,
 * injecting the tool's credentials into an ephemeral profile so a repo can
 * keep its committed profiles.yml credential-less (the dbt Projects on
 * Snowflake layout, where the server session supplies auth the same way).
 * The credential itself never touches disk: the generated profile references
 * an env var that only the dbt subprocess receives - the PAT as dbt's
 * password, or under OAuth a freshly refreshed access token via dbt's native
 * `authenticator: oauth`.
 */

export const DBT_PASSWORD_ENV = "SNOWFLAKE_AXI_DBT_PASSWORD";
export const DBT_TOKEN_ENV = "SNOWFLAKE_AXI_DBT_TOKEN";

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

export type LocalVerb = "compile" | "build" | "run" | "test" | "seed" | "snapshot";

export interface LocalDbtOptions {
  verb: LocalVerb;
  projectDir?: string;
  target?: string;
  select?: string;
  exclude?: string;
  fullRefresh?: boolean;
  failFast?: boolean;
  empty?: boolean;
  defer?: boolean;
  state?: string;
  favorState?: boolean;
  /** After a successful compile, copy the fresh manifest.json into this directory (for `dbt state`). */
  captureManifestTo?: string;
  timeoutSeconds: number;
}

export interface LocalListOptions {
  projectDir?: string;
  target?: string;
  select?: string;
  exclude?: string;
  resourceType?: string;
  state?: string;
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

export interface DbtProfile {
  outputs: Record<string, Record<string, unknown>>;
  /** The profile's own `target:` default, if it declares one. */
  defaultTarget?: string;
}

/** Reads the repo's profiles.yml: the named profile's targets and its declared default target. */
export function loadProfile(project: DbtProject): DbtProfile {
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
  const record = profile as Record<string, unknown>;
  if (typeof record.outputs !== "object" || record.outputs === null) {
    throw new AxiError(`Profile '${project.profileName}' in profiles.yml has no outputs`, "CONFIG_ERROR");
  }
  return {
    outputs: Object.fromEntries(
      Object.entries(record.outputs as Record<string, unknown>).filter(
        (entry): entry is [string, Record<string, unknown>] => typeof entry[1] === "object" && entry[1] !== null,
      ),
    ),
    defaultTarget: typeof record.target === "string" ? record.target : undefined,
  };
}

export function loadOutputs(project: DbtProject): Record<string, Record<string, unknown>> {
  return loadProfile(project).outputs;
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
  auth: AuthMode = "pat",
): Record<string, unknown> {
  const carried = Object.fromEntries(Object.entries(output).filter(([key]) => !AUTH_FIELDS.has(key)));
  // OAuth access tokens live ~10 minutes: connections opened while it is
  // valid outlast it, so reuse them unless the repo profile says otherwise.
  const credential =
    auth === "oauth"
      ? {
          authenticator: "oauth",
          token: `{{ env_var('${DBT_TOKEN_ENV}') }}`,
          reuse_connections: carried.reuse_connections ?? true,
        }
      : { password: `{{ env_var('${DBT_PASSWORD_ENV}') }}` };
  return {
    [profileName]: {
      target: targetName,
      outputs: {
        [targetName]: {
          ...carried,
          type: "snowflake",
          account: identity.account,
          user: identity.user,
          ...credential,
        },
      },
    },
  };
}

// dbt-snowflake is installed by the operator; pg-dbt manages its own venv instead.
const dbtMissing = () =>
  new AxiError("The dbt CLI is not installed or not on PATH", "CONFIG_ERROR", [
    "Install it with `uv tool install dbt-core --with dbt-snowflake` (or pipx/pip)",
  ]);

/** Help lines for a failed dbt run: the error tail, plus the OAuth pinned-role hint when it smells role-related. */
function dbtFailureHelp(auth: string, tail: string[]): string[] {
  const roleHint =
    auth === "oauth" && tail.some((line) => /role/i.test(line))
      ? [
          "OAuth sessions run as the token's pinned role; if this target's role: differs, run `snowflake-axi login --role <that role>` first",
        ]
      : [];
  return [...errorLines(tail), ...roleHint];
}

/**
 * Validates a --state directory and resolves it to an absolute path. --state
 * names a directory holding a manifest.json from a prior run; both `--defer`
 * and `state:` selectors read it. Checked before dbt spawns so a bad reference
 * fails loud here rather than as an opaque dbt stack trace.
 */
function resolveStateDir(state: string | undefined): string | undefined {
  if (state === undefined) return undefined;
  const dir = resolve(state);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new AxiError(`--state is not a directory: ${dir}`, "NOT_FOUND", [
      "Point --state at the directory that contains manifest.json, not at the file itself",
    ]);
  }
  if (!existsSync(join(dir, "manifest.json"))) {
    throw new AxiError(`No manifest.json in --state directory ${dir}`, "NOT_FOUND", [
      "--state reads manifest.json from this directory; copy one there from a prior dbt run or compile",
    ]);
  }
  return dir;
}

/**
 * dbt deferral. `--defer` resolves unselected `ref()`s to the --state manifest
 * (typically production) instead of building those upstreams - what keeps a
 * narrow `--select` run cheap. `--favor-state` only means anything alongside
 * deferral, so it turns it on.
 */
export function resolveDeferral(options: LocalDbtOptions): { state?: string; defer: boolean; favorState: boolean } {
  const favorState = options.favorState ?? false;
  const defer = (options.defer ?? false) || favorState;
  if (defer && options.state === undefined) {
    throw new AxiError(
      `${options.favorState ? "--favor-state" : "--defer"} needs a reference manifest`,
      "VALIDATION_ERROR",
      [
        "Pass --state <dir>: a directory holding a manifest.json from a prior run (e.g. production) to resolve unselected ref()s against",
        "Produce one with `snowflake-axi dbt state --target <prod> --into <dir>`",
      ],
    );
  }
  return { state: resolveStateDir(options.state), defer, favorState };
}

interface PreparedRun {
  project: DbtProject;
  targetName: string;
  outputs: Record<string, Record<string, unknown>>;
  auth: AuthMode;
  /** dbt argv prefix through --target, ready for verb-specific flags to be appended. */
  argvHead: string[];
  env: NodeJS.ProcessEnv;
  profilesDir: string;
}

/**
 * Shared setup for every local dbt spawn: resolve the project and target, write
 * the ephemeral credentialed profile, and pick the credential env. The caller
 * owns the profilesDir and must delete it after the run (try/finally).
 */
async function prepareLocalRun(verb: string, options: { projectDir?: string; target?: string }): Promise<PreparedRun> {
  const config = loadConfig();
  const project = resolveProject(options.projectDir);
  const outputs = loadOutputs(project);
  const targetName = resolveTarget(outputs, options.target, config.dbtTarget);
  const profile = buildEphemeralProfile(project.profileName, targetName, outputs[targetName], config, config.auth);

  const profilesDir = mkdtempSync(join(tmpdir(), "snowflake-axi-dbt-"));
  writeFileSync(join(profilesDir, "profiles.yml"), `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  // dbt connects as the target's role, so prefer that role's login from the
  // token ring; without one, the default login runs and a mismatch surfaces
  // Snowflake's role error with the login --role hint below.
  const targetRole = outputs[targetName].role;
  const tokenRole = typeof targetRole === "string" && hasLogin(targetRole) ? targetRole : undefined;
  const credentialEnv =
    config.auth === "oauth"
      ? { [DBT_TOKEN_ENV]: await refreshedAccessToken(tokenRole) }
      : { [DBT_PASSWORD_ENV]: config.token };
  return {
    project,
    targetName,
    outputs,
    auth: config.auth,
    argvHead: [
      "--no-use-colors",
      verb,
      "--profiles-dir",
      profilesDir,
      "--project-dir",
      project.dir,
      "--target",
      targetName,
    ],
    env: { ...process.env, ...credentialEnv },
    profilesDir,
  };
}

// A compile always refreshes target/manifest.json; `dbt state` copies it into a
// reference directory so a later --defer run can resolve unselected refs to it.
function captureManifest(project: DbtProject, into: string): string {
  const source = join(project.dir, project.targetPath, "manifest.json");
  if (!existsSync(source)) {
    throw new AxiError(`Compile did not produce ${source}`, "NOT_FOUND", [
      "Expected dbt to write target/manifest.json; run `snowflake-axi dbt compile` and check the log",
    ]);
  }
  const dir = resolve(into);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, "manifest.json");
  copyFileSync(source, dest);
  return dest;
}

export async function runLocalDbt(options: LocalDbtOptions): Promise<Record<string, unknown>> {
  const deferral = resolveDeferral(options);
  const prepared = await prepareLocalRun(options.verb, options);
  const { project, targetName, auth, argvHead, env, profilesDir } = prepared;

  const argv = [...argvHead];
  if (options.select) argv.push("--select", options.select);
  if (options.exclude) argv.push("--exclude", options.exclude);
  if (options.fullRefresh) argv.push("--full-refresh");
  if (options.failFast) argv.push("--fail-fast");
  if (options.empty) argv.push("--empty");
  if (deferral.state) argv.push("--state", deferral.state);
  if (deferral.defer) argv.push("--defer");
  if (deferral.favorState) argv.push("--favor-state");

  // Wall clock for the run_results.json mtime check; the elapsed label runs on the monotonic clock.
  const started = Date.now();
  const timer = startTimer();
  let exit: DbtExit;
  try {
    exit = await spawnDbt("dbt", argv, env, options.timeoutSeconds, dbtMissing);
  } finally {
    rmSync(profilesDir, { recursive: true, force: true });
  }

  const elapsed = timer();
  const command = `dbt ${options.verb}${options.select ? ` --select ${options.select}` : ""}`;
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
    throw new AxiError(
      `${command} on ${project.name} failed before producing results`,
      "DBT_ERROR",
      dbtFailureHelp(auth, exit.tail),
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
    if (options.captureManifestTo !== undefined) {
      const manifest = captureManifest(project, options.captureManifestTo);
      return {
        ...base,
        count: `${results.length} nodes compiled`,
        manifest,
        elapsed,
        help: [
          `Use it as a --defer reference: \`snowflake-axi dbt build --select <model> --defer --state ${options.captureManifestTo}\``,
        ],
      };
    }
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

// dbt writes resource names to stdout (one per line, whitespace-free); the human
// log goes to stderr. --quiet keeps stdout to the list alone across dbt versions.
const NODE_NAME = /^\S+$/;

export async function runLocalList(options: LocalListOptions): Promise<Record<string, unknown>> {
  const stateDir = resolveStateDir(options.state);
  const prepared = await prepareLocalRun("ls", options);
  const { project, targetName, auth, argvHead, env, profilesDir } = prepared;

  const argv = ["--quiet", ...argvHead, "--output", "name"];
  if (options.select) argv.push("--select", options.select);
  if (options.exclude) argv.push("--exclude", options.exclude);
  if (options.resourceType) argv.push("--resource-type", options.resourceType);
  if (stateDir) argv.push("--state", stateDir);

  let exit: DbtExit;
  try {
    exit = await spawnDbt("dbt", argv, env, options.timeoutSeconds, dbtMissing);
  } finally {
    rmSync(profilesDir, { recursive: true, force: true });
  }

  if (exit.code !== 0) {
    throw new AxiError(`dbt ls on ${project.name} failed`, "DBT_ERROR", dbtFailureHelp(auth, exit.tail));
  }

  const nodes = exit.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => NODE_NAME.test(line));
  const base = { project: project.name, target: targetName };
  if (nodes.length === 0) {
    return {
      ...base,
      count: `0 nodes matched${options.select ? ` --select '${options.select}'` : ""}`,
      help: ["Check the selector: dbt matches by name, +ancestors/descendants+, tag:, path:, state:"],
    };
  }
  const shown = nodes.slice(0, MAX_NODE_ROWS);
  return {
    ...base,
    count: `${nodes.length} nodes`,
    nodes: shown,
    ...(nodes.length > shown.length ? { note: `first ${shown.length} of ${nodes.length} nodes shown` } : {}),
  };
}

function findCompiled(dir: string, filename: string, found: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findCompiled(full, filename, found);
    else if (entry.name === filename) found.push(full);
  }
}

const MAX_COMPILED_CHARS = 20000;

export function readCompiledSql(name: string, projectDirFlag: string | undefined): Record<string, unknown> {
  const project = resolveProject(projectDirFlag);
  const compiledRoot = join(project.dir, project.targetPath, "compiled");
  if (!existsSync(compiledRoot)) {
    throw new AxiError(`No compiled output in ${project.targetPath}/compiled`, "NOT_FOUND", [
      "Run `snowflake-axi dbt compile` first; it writes compiled SQL there",
    ]);
  }
  const filename = name.endsWith(".sql") ? name : `${name}.sql`;
  const matches: string[] = [];
  findCompiled(compiledRoot, filename, matches);
  if (matches.length === 0) {
    throw new AxiError(`No compiled SQL for '${name}'`, "NOT_FOUND", [
      `Check the model name, or recompile: \`snowflake-axi dbt compile --select ${name}\``,
    ]);
  }
  if (matches.length > 1) {
    throw new AxiError(`${matches.length} compiled files match '${filename}'`, "AMBIGUOUS", [
      ...matches.map((path) => path.slice(project.dir.length + 1)),
    ]);
  }
  const path = matches[0].slice(project.dir.length + 1);
  const sql = readFileSync(matches[0], "utf8");
  const truncated = sql.length > MAX_COMPILED_CHARS;
  return {
    model: name.replace(/\.sql$/, ""),
    path,
    ...(truncated ? { note: `SQL truncated to ${MAX_COMPILED_CHARS} chars; read ${path} for the full file` } : {}),
    sql: truncated ? sql.slice(0, MAX_COMPILED_CHARS) : sql,
  };
}

import { AxiError } from "axi-sdk-js";
import { type ActionDef, type CommandArgs, defineCommand, type FlagDef } from "../command.js";
import { type LocalVerb, runLocalDbt } from "../dbt-local.js";
import { requireGrant } from "../grants.js";
import { IDENTIFIER, parseScope, resolveRepoName, type Scope, safeLike, scopeClause, scopeLabel } from "../names.js";
import { runQuery } from "../snowflake.js";

async function showProjects(like: string | undefined, scope: Scope, role?: string): Promise<Record<string, unknown>[]> {
  const likeClause = like === undefined ? "" : ` LIKE '${like}'`;
  const { rows } = await runQuery(`SHOW DBT PROJECTS${likeClause}${scopeClause(scope)}`, { role });
  return rows;
}

function fqnOf(row: Record<string, unknown>): string {
  return `${row.database_name}.${row.schema_name}.${row.name}`;
}

function day(value: unknown): string {
  return String(value ?? "").slice(0, 10);
}

function integrationsOf(row: Record<string, unknown>): string[] {
  const raw = row.external_access_integrations;
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

async function list(args: CommandArgs): Promise<Record<string, unknown>> {
  const scope = parseScope(args.positionals[0]);
  const rawLike = args.str("--like");
  const like = rawLike === undefined ? undefined : safeLike(rawLike, "--like");

  const rows = await showProjects(like, scope);
  const matchLabel = like === undefined ? "" : ` matching '${like}'`;
  if (rows.length === 0) {
    return { scope: scopeLabel(scope), count: `0 dbt projects${matchLabel} in ${scopeLabel(scope)}` };
  }
  return {
    scope: scopeLabel(scope),
    count: `${rows.length} dbt projects${matchLabel}`,
    projects: rows.map((row) => ({
      name: row.name,
      scope: `${row.database_name}.${row.schema_name}`,
      dbt_version: row.dbt_version,
      target: row.default_target ?? "",
      updated: day(row.updated_on),
    })),
    help: ["Run `snowflake-axi dbt describe <name>` for versions, source, and integrations"],
  };
}

function detail(row: Record<string, unknown>): Record<string, unknown> {
  const integrations = integrationsOf(row);
  return {
    project: fqnOf(row),
    owner: row.owner,
    ...(row.comment ? { comment: row.comment } : {}),
    dbt_version: row.dbt_version,
    adapter_version: row.dbt_snowflake_version,
    ...(row.default_target ? { target: row.default_target } : {}),
    version: row.default_version_name,
    source: row.default_version_source_location_uri,
    files: row.default_version_location_uri,
    ...(integrations.length > 0 ? { integrations } : {}),
    created: day(row.created_on),
    updated: day(row.updated_on),
  };
}

function parseProjectName(raw: string): string[] {
  const parts = raw.split(".");
  if (parts.length === 2 || parts.length > 3 || !parts.every((p) => IDENTIFIER.test(p))) {
    throw new AxiError(`Invalid project name '${raw}'`, "VALIDATION_ERROR", [
      "Use `name` (searched account-wide) or `db.schema.name`",
    ]);
  }
  return parts.map((p) => p.toUpperCase());
}

// Bare names resolve account-wide, exact match first, then contains.
async function findProject(
  upper: string[],
  role?: string,
): Promise<{ match?: Record<string, unknown>; label: string; matches: Record<string, unknown>[] }> {
  if (upper.length === 3) {
    const rows = await showProjects(upper[2], { database: upper[0], schema: upper[1] }, role);
    const match = rows.find((row) => row.name === upper[2]);
    return { match, label: upper.join("."), matches: match ? [match] : [] };
  }
  const rows = await showProjects(`%${upper[0]}%`, {}, role);
  const exact = rows.filter((row) => row.name === upper[0]);
  const matches = exact.length > 0 ? exact : rows;
  return { match: matches.length === 1 ? matches[0] : undefined, label: upper[0], matches };
}

async function describe(args: CommandArgs): Promise<Record<string, unknown>> {
  const upper = parseProjectName(args.positionals[0]);
  const { match, label, matches } = await findProject(upper);
  if (match) return detail(match);
  if (matches.length > 1) {
    return {
      count: `${matches.length} dbt projects match '${label}'`,
      matches: matches.map((row) => ({ project: fqnOf(row) })),
      help: ["Run `snowflake-axi dbt describe <db.schema.name>` with the full name"],
    };
  }
  const where = upper.length === 3 ? `named ${label}` : `match '${label}' in account`;
  return {
    count: `0 dbt projects ${where}`,
    help: ["Run `snowflake-axi dbt` to list projects account-wide"],
  };
}

async function execute(args: CommandArgs): Promise<Record<string, unknown>> {
  requireGrant("dbt.execute");
  const dbtArgs = args.str("--args");
  if (!dbtArgs) {
    throw new AxiError("--args is required: the dbt command to run inside the project", "VALIDATION_ERROR", [
      'Example: snowflake-axi dbt execute MY_PROJECT --args "run --target prod"',
    ]);
  }

  const role = args.str("--role");
  const upper = parseProjectName(args.positionals[0]);
  const { match, label, matches } = await findProject(upper, role);
  if (!match) {
    if (matches.length > 1) {
      throw new AxiError(`${matches.length} dbt projects match '${label}'; use the full db.schema.name`, "AMBIGUOUS", [
        ...matches.map((row) => `snowflake-axi dbt execute ${fqnOf(row)} --args "${dbtArgs}"`),
      ]);
    }
    throw new AxiError(`No dbt project matches '${label}'`, "NOT_FOUND", [
      "Run `snowflake-axi dbt` to list projects account-wide",
    ]);
  }

  const fqn = fqnOf(match);
  const literal = dbtArgs.replace(/\\/g, "\\\\").replace(/'/g, "''");
  const started = Date.now();
  const { rows } = await runQuery(`EXECUTE DBT PROJECT ${fqn} args='${literal}'`, {
    timeoutSeconds: args.int("--timeout"),
    role,
  });
  return {
    project: fqn,
    args: dbtArgs,
    elapsed: `${((Date.now() - started) / 1000).toFixed(1)}s`,
    ...(rows.length > 0 ? { rows } : { note: "Snowflake returned no output rows" }),
  };
}

interface GitSource {
  repo: string;
  refKind: "branches" | "tags" | "commits";
  ref: string;
  path: string;
}

const GIT_REF = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

// A version's source URI is git-deployable only when it points at a git repository
// stage; workspace and snow://dbt sources belong to their own tools, not deploy.
function parseGitSource(uri: unknown): GitSource | undefined {
  if (typeof uri !== "string" || !uri.startsWith("@")) return undefined;
  const [repo, refKind, ref, ...rest] = uri.slice(1).split("/");
  if (!repo || (refKind !== "branches" && refKind !== "tags" && refKind !== "commits") || !ref) return undefined;
  return { repo, refKind, ref, path: rest.join("/") };
}

function assertRef(raw: string, flag: string): string {
  if (!GIT_REF.test(raw)) {
    throw new AxiError(`Invalid ${flag} '${raw}'`, "VALIDATION_ERROR", [
      "Use letters, digits, and _ . / - (no spaces or quotes)",
    ]);
  }
  return raw;
}

// A redeploy inherits the project's current git source; a new project must be given one.
function resolveSource(storedUri: unknown, fqn: string, args: CommandArgs): GitSource {
  const stored = parseGitSource(storedUri);
  const repoFlag = args.str("--repo");
  const branchFlag = args.str("--branch");
  const pathFlag = args.str("--path");
  const repo = repoFlag ? resolveRepoName(repoFlag).fqn : stored?.repo;
  const refKind: GitSource["refKind"] = branchFlag ? "branches" : (stored?.refKind ?? "branches");
  const ref = branchFlag ? assertRef(branchFlag, "--branch") : stored?.ref;
  const path = pathFlag !== undefined ? assertRef(pathFlag, "--path") : (stored?.path ?? "");
  if (!repo || !ref) {
    throw new AxiError(`Cannot infer a git source for ${fqn}`, "VALIDATION_ERROR", [
      stored ? "Its current version is not from a git repository" : "A new project needs an explicit git source",
      "Pass --repo DB.SCHEMA.REPO and --branch <name> to point at a git repository",
    ]);
  }
  return { repo, refKind, ref, path };
}

function gitLocation(source: GitSource): string {
  const base = `@${source.repo}/${source.refKind}/${source.ref}`;
  return source.path ? `${base}/${source.path}` : base;
}

const INTEGRATION = /^[A-Za-z_][A-Za-z0-9_$]*$/;

// CREATE-only clauses; both stay empty on a redeploy, which only adds a version.
function targetClause(raw: string | undefined): string {
  if (raw === undefined) return "";
  if (!/^[A-Za-z0-9_]+$/.test(raw)) {
    throw new AxiError(`Invalid --target '${raw}'`, "VALIDATION_ERROR", ["Use a plain target name like dev or prod"]);
  }
  return ` DEFAULT_TARGET = '${raw}'`;
}

function integrationsClause(raw: string | undefined): string {
  if (raw === undefined) return "";
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of names) {
    if (!INTEGRATION.test(name)) {
      throw new AxiError(`Invalid integration name '${name}'`, "VALIDATION_ERROR", [
        "Pass a comma-separated list of external access integration names",
      ]);
    }
  }
  return names.length > 0 ? ` EXTERNAL_ACCESS_INTEGRATIONS = (${names.join(", ")})` : "";
}

async function deploy(args: CommandArgs): Promise<Record<string, unknown>> {
  requireGrant("dbt.deploy");
  const role = args.str("--role");
  const timeoutSeconds = args.int("--timeout");
  const upper = parseProjectName(args.positionals[0]);
  const { match, label, matches } = await findProject(upper, role);

  if (!match && matches.length > 1) {
    throw new AxiError(`${matches.length} dbt projects match '${label}'; use the full db.schema.name`, "AMBIGUOUS", [
      ...matches.map((row) => `snowflake-axi dbt deploy ${fqnOf(row)}`),
    ]);
  }
  const creating = !match;
  if (creating && upper.length !== 3) {
    throw new AxiError(`No dbt project matches '${label}'`, "NOT_FOUND", [
      "Run `snowflake-axi dbt` to list projects account-wide",
      "To create a new project, give its full db.schema.name with --repo and --branch",
    ]);
  }
  if (!creating && (args.str("--target") !== undefined || args.str("--integrations") !== undefined)) {
    throw new AxiError("--target and --integrations only apply when creating a new project", "VALIDATION_ERROR", [
      `${fqnOf(match)} already exists; deploy adds a version and leaves target and integrations unchanged`,
      "Change them in Snowflake with ALTER DBT PROJECT ... SET",
    ]);
  }

  const fqn = match ? fqnOf(match) : upper.join(".");
  const source = resolveSource(match?.default_version_source_location_uri, fqn, args);
  const location = gitLocation(source);
  const create = `CREATE DBT PROJECT ${fqn} FROM '${location}'${targetClause(args.str("--target"))}${integrationsClause(args.str("--integrations"))}`;
  const started = Date.now();

  if (!args.bool("--no-fetch")) {
    await runQuery(`ALTER GIT REPOSITORY ${source.repo} FETCH`, { role, timeoutSeconds });
  }

  const { rows: manifest } = await runQuery(`LIST ${location}/dbt_project.yml`, { role });
  if (manifest.length === 0) {
    throw new AxiError(`No dbt_project.yml under ${location}`, "NOT_FOUND", [
      "Check --branch and --path point at the dbt project root inside the repository",
      `Run \`snowflake-axi stage ${location}/\` to inspect the tree`,
    ]);
  }

  const write = creating ? create : `ALTER DBT PROJECT ${fqn} ADD VERSION FROM '${location}'`;
  await runQuery(write, { role, timeoutSeconds });

  const { rows: versions } = await runQuery(`SHOW VERSIONS IN DBT PROJECT ${fqn}`, { role });
  const latest = versions.find((row) => String(row.is_last) === "true") ?? versions[versions.length - 1];
  const commit = latest?.git_commit_hash ? String(latest.git_commit_hash).slice(0, 12) : undefined;

  return {
    project: fqn,
    ...(creating ? { created: true } : {}),
    deployed_from: location,
    version: latest?.name ?? "(unknown)",
    ...(latest?.alias ? { alias: latest.alias } : {}),
    ...(commit ? { commit } : {}),
    is_default: String(latest?.is_default) === "true",
    elapsed: `${((Date.now() - started) / 1000).toFixed(1)}s`,
    help: [`Run \`snowflake-axi dbt execute ${fqn.split(".").pop()} --args "build"\` to run this version`],
  };
}

const SELECT_FLAG: FlagDef = {
  type: "string",
  placeholder: "<spec>",
  description:
    'dbt node selector: model_x, +model_x (with ancestors), model_x+ (with descendants), tag:nightly; quote a union into one value: --select "model_x+ model_y+"',
};
const EXCLUDE_FLAG: FlagDef = { type: "string", placeholder: "<spec>", description: "dbt node selector to skip" };
const LOCAL_TARGET_FLAG: FlagDef = {
  type: "string",
  placeholder: "<name>",
  description: "target from the repo's profiles.yml (default: SNOWFLAKE_AXI_DBT_TARGET from the tool config)",
};
const PROJECT_DIR_FLAG: FlagDef = {
  type: "string",
  placeholder: "<path>",
  description: "dbt project root (default: current directory)",
};

function localTimeoutFlag(defaultSeconds: number): FlagDef {
  return {
    type: "int",
    placeholder: "<s>",
    description: "kill the dbt subprocess after this many seconds",
    default: defaultSeconds,
    min: 1,
    max: 14400,
  };
}

function runLocal(args: CommandArgs, verb: LocalVerb): Promise<Record<string, unknown>> {
  return runLocalDbt({
    verb,
    projectDir: args.str("--project-dir"),
    target: args.str("--target"),
    select: args.str("--select"),
    exclude: args.str("--exclude"),
    fullRefresh: args.bool("--full-refresh"),
    failFast: args.bool("--fail-fast"),
    timeoutSeconds: args.int("--timeout"),
  });
}

// The gated local verbs mirror dbt's own vocabulary 1:1; all share the single
// dbt.build grant because each one writes to the chosen target.
function localWrite(
  verb: LocalVerb,
  description: string,
  options: { fullRefresh?: boolean; notes?: string[]; examples: string[] },
): ActionDef {
  return {
    description: `${description} (write; dbt.build grant)`,
    flags: {
      "--select": SELECT_FLAG,
      "--exclude": EXCLUDE_FLAG,
      "--target": LOCAL_TARGET_FLAG,
      ...(options.fullRefresh
        ? { "--full-refresh": { type: "boolean", description: "rebuild incremental models from scratch" } as FlagDef }
        : {}),
      "--fail-fast": { type: "boolean", description: "stop at the first failure" },
      "--project-dir": PROJECT_DIR_FLAG,
      "--timeout": localTimeoutFlag(1800),
    },
    notes: [
      "Refused with WRITE_NOT_ALLOWED until the user grants dbt.build (see `snowflake-axi allow --help`).",
      ...(options.notes ?? []),
    ],
    examples: options.examples,
    run: (args) => {
      requireGrant("dbt.build");
      return runLocal(args, verb);
    },
  };
}

async function drop(args: CommandArgs): Promise<Record<string, unknown>> {
  requireGrant("dbt.drop");
  const role = args.str("--role");
  const upper = parseProjectName(args.positionals[0]);
  const { match, label, matches } = await findProject(upper, role);
  if (!match) {
    if (matches.length > 1) {
      throw new AxiError(`${matches.length} dbt projects match '${label}'; use the full db.schema.name`, "AMBIGUOUS", [
        ...matches.map((row) => `snowflake-axi dbt drop ${fqnOf(row)}`),
      ]);
    }
    // Idempotent: an absent project is already the desired end state.
    return { project: label, dropped: false, note: "not found (no-op)" };
  }

  const fqn = fqnOf(match);
  await runQuery(`DROP DBT PROJECT IF EXISTS ${fqn}`, { role });
  return { project: fqn, dropped: true };
}

const NO_CREDS_HINT = (verb: string) =>
  `\`dbt ${verb}\` needs no Snowflake credentials; run the dbt CLI directly in the repo`;
const UNWRAPPED_HINT = "This dbt verb is outside the wrapped surface";

export const dbtCommand = defineCommand("dbt", {
  summary: "dbt Projects on Snowflake plus local dbt: compile, and (gated) run, build, test, seed, snapshot",
  description:
    "List, inspect, execute, deploy, and drop dbt Projects on Snowflake, and compile, run, build, test, seed, or snapshot the local dbt project in the working directory",
  verbHints: {
    ls: [NO_CREDS_HINT("ls")],
    parse: [NO_CREDS_HINT("parse")],
    deps: [NO_CREDS_HINT("deps")],
    clean: [NO_CREDS_HINT("clean")],
    debug: [NO_CREDS_HINT("debug")],
    init: [NO_CREDS_HINT("init")],
    show: [
      UNWRAPPED_HINT,
      "Preview built tables with `snowflake-axi sample <table>`, or compile and inspect target/compiled SQL",
    ],
    docs: [UNWRAPPED_HINT, "Compiled SQL lands in target/compiled after `snowflake-axi dbt compile`"],
    retry: [
      UNWRAPPED_HINT,
      "Re-run `snowflake-axi dbt build` with the same --select; completed incremental work is preserved",
    ],
    clone: [UNWRAPPED_HINT],
    "run-operation": [UNWRAPPED_HINT, "Arbitrary macro execution is out of scope, like arbitrary DML through `query`"],
    source: [UNWRAPPED_HINT],
  },
  defaultSubcommand: "list",
  subcommands: {
    list: {
      description: "List dbt projects, account-wide by default",
      positionals: { usage: "[db[.schema]]", min: 0, max: 1 },
      flags: {
        "--like": {
          type: "string",
          placeholder: "<pattern>",
          description: "filter by name, case-insensitive; bare words match as contains",
        },
      },
      notes: [
        "For the SQL of a local dbt model file, use `snowflake-axi model <name>`.",
        "Executing a project is a write and needs the human-granted dbt.execute capability.",
      ],
      examples: ["snowflake-axi dbt", "snowflake-axi dbt --like usage", "snowflake-axi dbt MY_DB.MY_SCHEMA"],
      run: list,
    },
    describe: {
      description: "Versions, source, target, and integrations for one dbt project",
      positionals: { usage: "<name | db.schema.name>", min: 1, max: 1 },
      notes: ["Bare names are searched account-wide: exact match first, then contains."],
      examples: ["snowflake-axi dbt describe MY_PROJECT"],
      run: describe,
    },
    compile: {
      description: "Compile the local dbt project against Snowflake (read-only)",
      flags: {
        "--select": SELECT_FLAG,
        "--exclude": EXCLUDE_FLAG,
        "--target": LOCAL_TARGET_FLAG,
        "--project-dir": PROJECT_DIR_FLAG,
        "--timeout": localTimeoutFlag(600),
      },
      notes: [
        "Local verbs (compile, run, build, test, seed, snapshot) spawn the dbt CLI on the project in the working directory, injecting the tool's credentials into an ephemeral profile; the repo's committed profiles.yml stays credential-less and only supplies targets (role, database, schema, warehouse).",
        "Compile validates jinja and refs via dbt's introspective metadata queries; no models are materialized.",
      ],
      examples: ["snowflake-axi dbt compile", "snowflake-axi dbt compile --select +fct_sales --target dev"],
      run: (args) => runLocal(args, "compile"),
    },
    run: localWrite("run", "Materialize models from local code, skipping their tests", {
      fullRefresh: true,
      notes: [
        "Faster than build for iteration; build additionally runs each node's tests and gates downstream nodes on them.",
      ],
      examples: ["snowflake-axi dbt run --select my_model"],
    }),
    build: localWrite("build", "Run models, tests, seeds, and snapshots from local code in DAG order", {
      fullRefresh: true,
      notes: [
        "Writes land where the chosen target points; a personal sandbox target keeps local iteration isolated.",
        "For a project deployed on Snowflake, use `snowflake-axi dbt execute` instead.",
      ],
      examples: ["snowflake-axi dbt build --select my_model"],
    }),
    test: localWrite("test", "Run tests from local code", {
      notes: [
        "Shares the dbt.build grant: projects configured with store_failures persist failing rows to the target schema, so tests are writes too.",
      ],
      examples: ["snowflake-axi dbt test --select my_model"],
    }),
    seed: localWrite("seed", "Load CSV seed files from local code into the target", {
      fullRefresh: true,
      examples: ["snowflake-axi dbt seed --select my_seed"],
    }),
    snapshot: localWrite("snapshot", "Run snapshots from local code", {
      examples: ["snowflake-axi dbt snapshot --select my_snapshot"],
    }),
    execute: {
      description: "Run a dbt command inside a deployed project (write; needs the dbt.execute grant)",
      positionals: { usage: "<name | db.schema.name>", min: 1, max: 1 },
      flags: {
        "--args": {
          type: "string",
          placeholder: '"<dbt command>"',
          description: 'the dbt command to run, e.g. "build" or "run --select my_model"',
        },
        "--timeout": {
          type: "int",
          placeholder: "<s>",
          description: "statement timeout in seconds",
          default: 3600,
          min: 1,
          max: 14400,
        },
        "--role": {
          type: "string",
          placeholder: "<name>",
          description: "run as another role granted to the user, when the default role cannot execute the project",
        },
      },
      notes: [
        "Refused with WRITE_NOT_ALLOWED until the user grants dbt.execute (see `snowflake-axi allow --help`).",
        "The connection's user needs a role with the privileges to execute the project; pass it with --role.",
      ],
      examples: ['snowflake-axi dbt execute MY_PROJECT --args "build"'],
      run: execute,
    },
    deploy: {
      description:
        "Deploy a project from its git repository - create it or cut a new version (write; dbt.deploy grant)",
      positionals: { usage: "<name | db.schema.name>", min: 1, max: 1 },
      flags: {
        "--branch": {
          type: "string",
          placeholder: "<name>",
          description: "git branch to deploy (default: the project's current source branch)",
        },
        "--repo": {
          type: "string",
          placeholder: "<db.schema.repo>",
          description: "git repository object to deploy from (default: the project's current source)",
        },
        "--path": {
          type: "string",
          placeholder: "<subdir>",
          description: "project subdirectory within the branch (default: the project's current source path)",
        },
        "--no-fetch": {
          type: "boolean",
          description: "skip refreshing the repository from origin; deploy the already-fetched commit",
        },
        "--timeout": {
          type: "int",
          placeholder: "<s>",
          description: "statement timeout in seconds",
          default: 600,
          min: 1,
          max: 14400,
        },
        "--target": {
          type: "string",
          placeholder: "<name>",
          description: "DEFAULT_TARGET for a newly created project (e.g. dev, prod)",
        },
        "--integrations": {
          type: "string",
          placeholder: "<a,b>",
          description: "comma-separated EXTERNAL_ACCESS_INTEGRATIONS for a newly created project",
        },
        "--role": {
          type: "string",
          placeholder: "<name>",
          description: "run as another role granted to the user; needs OWNERSHIP on the project and WRITE on the repo",
        },
      },
      notes: [
        "Refused with WRITE_NOT_ALLOWED until the user grants dbt.deploy (see `snowflake-axi allow --help`).",
        "Git-native: fetches the repository, then ADD VERSION from '@repo/branches/<branch>/<path>' - no file upload.",
        "With no flags it redeploys from the project's current git source; the new version becomes LAST, which is what execute runs.",
        "Creates the project (CREATE DBT PROJECT) when its full db.schema.name does not exist yet and --repo and --branch are given; --target and --integrations apply only then.",
        "The role needs OWNERSHIP on the project (or CREATE DBT PROJECT on the schema for a new one) and WRITE on the git repository; switch to it with --role.",
      ],
      examples: [
        "snowflake-axi dbt deploy MY_PROJECT --role DBT_ROLE",
        "snowflake-axi dbt deploy MY_DB.MY_SCHEMA.MY_PROJECT --branch main --path analytics",
        "snowflake-axi dbt deploy MY_DB.MY_SCHEMA.NEW_PROJECT --repo MY_DB.PUBLIC.MY_REPO --branch main --target dev",
      ],
      run: deploy,
    },
    drop: {
      description: "Drop a dbt project and all its versions (write; needs the dbt.drop grant)",
      positionals: { usage: "<name | db.schema.name>", min: 1, max: 1 },
      flags: {
        "--role": {
          type: "string",
          placeholder: "<name>",
          description: "run as another role granted to the user; needs OWNERSHIP on the project",
        },
      },
      notes: [
        "Refused with WRITE_NOT_ALLOWED until the user grants dbt.drop (see `snowflake-axi allow --help`).",
        "Destructive and irreversible: removes the project object and every version. Dropping an absent project is a no-op (exit 0).",
        "The role needs OWNERSHIP on the project; switch to it with --role.",
      ],
      examples: ["snowflake-axi dbt drop MY_DB.MY_SCHEMA.MY_PROJECT --role DBT_ROLE"],
      run: drop,
    },
  },
});

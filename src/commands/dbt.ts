import { AxiError } from "axi-sdk-js";
import { type CommandArgs, defineCommand } from "../command.js";
import { requireGrant } from "../grants.js";
import { IDENTIFIER, likePattern, parseScope, type Scope } from "../names.js";
import { runQuery } from "../snowflake.js";

// SHOW commands take no bind variables, so LIKE patterns are interpolated and
// must stay within identifier characters plus SQL wildcards.
const SAFE_LIKE = /^[A-Za-z0-9_$%]+$/;

function scopeClause(scope: Scope): string {
  if (scope.database && scope.schema) return ` IN SCHEMA ${scope.database}.${scope.schema}`;
  if (scope.database) return ` IN DATABASE ${scope.database}`;
  return " IN ACCOUNT";
}

function scopeLabel(scope: Scope): string {
  if (scope.database) return [scope.database, scope.schema].filter(Boolean).join(".");
  return "account";
}

async function showProjects(like: string | undefined, scope: Scope): Promise<Record<string, unknown>[]> {
  const likeClause = like === undefined ? "" : ` LIKE '${like}'`;
  const { rows } = await runQuery(`SHOW DBT PROJECTS${likeClause}${scopeClause(scope)}`);
  return rows;
}

function safeLike(raw: string, flagName: string): string {
  if (!SAFE_LIKE.test(raw)) {
    throw new AxiError(`Invalid ${flagName} pattern '${raw}'`, "VALIDATION_ERROR", [
      "Use identifier characters and % wildcards, e.g. --like usage or --like USAGE%",
    ]);
  }
  return likePattern(raw);
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
): Promise<{ match?: Record<string, unknown>; label: string; matches: Record<string, unknown>[] }> {
  if (upper.length === 3) {
    const rows = await showProjects(upper[2], { database: upper[0], schema: upper[1] });
    const match = rows.find((row) => row.name === upper[2]);
    return { match, label: upper.join("."), matches: match ? [match] : [] };
  }
  const rows = await showProjects(`%${upper[0]}%`, {});
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

  const upper = parseProjectName(args.positionals[0]);
  const { match, label, matches } = await findProject(upper);
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
  });
  return {
    project: fqn,
    args: dbtArgs,
    elapsed: `${((Date.now() - started) / 1000).toFixed(1)}s`,
    ...(rows.length > 0 ? { rows } : { note: "Snowflake returned no output rows" }),
  };
}

export const dbtCommand = defineCommand("dbt", {
  summary: "dbt Projects on Snowflake: list, inspect, and (gated) execute",
  description: "List, inspect, and execute dbt Projects on Snowflake (server-side dbt objects)",
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
      },
      notes: [
        "Refused with WRITE_NOT_ALLOWED until the user grants dbt.execute (see `snowflake-axi allow --help`).",
        "The connection's user needs a role with the privileges to execute the project.",
      ],
      examples: ['snowflake-axi dbt execute MY_PROJECT --args "build"'],
      run: execute,
    },
  },
});

import { AxiError } from "axi-sdk-js";
import { type CommandArgs, defineCommand } from "../command.js";
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

async function describe(args: CommandArgs): Promise<Record<string, unknown>> {
  const raw = args.positionals[0];
  const parts = raw.split(".");
  if (parts.length === 2 || parts.length > 3 || !parts.every((p) => IDENTIFIER.test(p))) {
    throw new AxiError(`Invalid project name '${raw}'`, "VALIDATION_ERROR", [
      "Use `name` (searched account-wide) or `db.schema.name`",
    ]);
  }
  const upper = parts.map((p) => p.toUpperCase());

  if (upper.length === 3) {
    const rows = await showProjects(upper[2], { database: upper[0], schema: upper[1] });
    const match = rows.find((row) => row.name === upper[2]);
    if (!match) {
      return {
        count: `0 dbt projects named ${upper.join(".")}`,
        help: ["Run `snowflake-axi dbt` to list projects account-wide"],
      };
    }
    return detail(match);
  }

  const name = upper[0];
  const rows = await showProjects(`%${name}%`, {});
  const exact = rows.filter((row) => row.name === name);
  const matches = exact.length > 0 ? exact : rows;
  if (matches.length === 0) {
    return {
      count: `0 dbt projects match '${name}' in account`,
      help: ["Run `snowflake-axi dbt` to list projects account-wide"],
    };
  }
  if (matches.length > 1) {
    return {
      count: `${matches.length} dbt projects match '${name}'`,
      matches: matches.map((row) => ({ project: fqnOf(row) })),
      help: ["Run `snowflake-axi dbt describe <db.schema.name>` with the full name"],
    };
  }
  return detail(matches[0]);
}

export const dbtCommand = defineCommand("dbt", {
  summary: "dbt Projects on Snowflake: list and inspect (read-only)",
  description: "List and inspect dbt Projects on Snowflake (server-side dbt objects)",
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
        "Deploying or executing projects is a write; hand `EXECUTE DBT PROJECT <db.schema.name>` to the operator.",
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
  },
});

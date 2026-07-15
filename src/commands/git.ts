import { type CommandArgs, defineCommand } from "../command.js";
import { humanBytes, startTimer } from "../format.js";
import { requireGrant } from "../grants.js";
import { parseScope, resolveRepoName, safeLike, scopeClause, scopeLabel } from "../names.js";
import { runQuery } from "../snowflake.js";

function day(value: unknown): string {
  return String(value ?? "").slice(0, 10);
}

function shortHash(value: unknown): string {
  return String(value ?? "").slice(0, 12);
}

async function list(args: CommandArgs): Promise<Record<string, unknown>> {
  const scope = parseScope(args.positionals[0]);
  const rawLike = args.str("--like");
  const like = rawLike === undefined ? undefined : safeLike(rawLike, "--like");
  const likeClause = like === undefined ? "" : ` LIKE '${like}'`;

  const { rows } = await runQuery(`SHOW GIT REPOSITORIES${likeClause}${scopeClause(scope)}`);
  const matchLabel = like === undefined ? "" : ` matching '${like}'`;
  if (rows.length === 0) {
    return { scope: scopeLabel(scope), count: `0 git repositories${matchLabel} in ${scopeLabel(scope)}` };
  }
  return {
    scope: scopeLabel(scope),
    count: `${rows.length} git repositories${matchLabel}`,
    repositories: rows.map((row) => ({
      name: row.name,
      scope: `${row.database_name}.${row.schema_name}`,
      origin: row.origin,
      last_fetched: day(row.last_fetched_at),
    })),
    help: [
      "Run `snowflake-axi git branches <db.schema.repo>` to list branches",
      "Run `snowflake-axi git fetch <db.schema.repo>` to refresh one from origin (gated)",
    ],
  };
}

async function branches(args: CommandArgs): Promise<Record<string, unknown>> {
  const repo = resolveRepoName(args.positionals[0]);
  const rawLike = args.str("--like");
  const like = rawLike === undefined ? undefined : safeLike(rawLike, "--like");
  const likeClause = like === undefined ? "" : ` LIKE '${like}'`;
  const limit = args.int("--limit");

  const { rows } = await runQuery(`SHOW GIT BRANCHES${likeClause} IN ${repo.fqn}`);
  const matchLabel = like === undefined ? "" : ` matching '${like}'`;
  if (rows.length === 0) {
    return { repository: repo.fqn, count: `0 branches${matchLabel} in ${repo.fqn}` };
  }
  const shown = rows.slice(0, limit);
  const help: string[] = [];
  if (shown.length < rows.length) {
    help.push(`Showing ${shown.length} of ${rows.length}; rerun with --limit ${rows.length} for all`);
  }
  help.push(`Run \`snowflake-axi stage @${repo.fqn}/branches/<name>/\` to list a branch's files`);
  return {
    repository: repo.fqn,
    count: `${rows.length} branches${matchLabel}`,
    branches: shown.map((row) => ({ name: row.name, commit: shortHash(row.commit_hash) })),
    help,
  };
}

async function fetch(args: CommandArgs): Promise<Record<string, unknown>> {
  requireGrant("git.fetch");
  const repo = resolveRepoName(args.positionals[0]);
  const role = args.str("--role");
  const timeoutSeconds = args.int("--timeout");

  const elapsed = startTimer();
  await runQuery(`ALTER GIT REPOSITORY ${repo.fqn} FETCH`, { role, timeoutSeconds });
  const { rows } = await runQuery(
    `SHOW GIT REPOSITORIES LIKE '${repo.name}' IN SCHEMA ${repo.database}.${repo.schema}`,
    {
      role,
    },
  );
  const info = rows.find((row) => row.name === repo.name);
  return {
    repository: repo.fqn,
    fetched: info ? String(info.last_fetched_at) : "ok",
    ...(info?.repository_size ? { size: humanBytes(Number(info.repository_size)) } : {}),
    elapsed: elapsed(),
    help: [`Run \`snowflake-axi git branches ${repo.fqn}\` to see the refreshed branches`],
  };
}

export const gitCommand = defineCommand("git", {
  summary: "Git repositories on Snowflake: list, branches, and (gated) fetch",
  description:
    "List git repositories, inspect their branches, and refresh them from origin (server-side git integration)",
  defaultSubcommand: "list",
  subcommands: {
    list: {
      description: "List git repositories, account-wide by default",
      positionals: { usage: "[db[.schema]]", min: 0, max: 1 },
      flags: {
        "--like": {
          type: "string",
          placeholder: "<pattern>",
          description: "filter by name, case-insensitive; bare words match as contains",
        },
      },
      notes: [
        "A git repository is a read-only stage; browse a branch's files with `snowflake-axi stage @db.schema.repo/branches/<name>/`.",
        "Deploy a dbt project from a repository with `snowflake-axi dbt deploy`.",
      ],
      examples: ["snowflake-axi git", "snowflake-axi git --like dbt", "snowflake-axi git MY_DB.MY_SCHEMA"],
      run: list,
    },
    branches: {
      description: "List branches in a git repository",
      positionals: { usage: "<db.schema.repo>", min: 1, max: 1 },
      flags: {
        "--like": {
          type: "string",
          placeholder: "<pattern>",
          description: "filter branch names; bare words match as contains",
        },
        "--limit": {
          type: "int",
          placeholder: "<n>",
          description: "max branches shown",
          default: 100,
          min: 1,
          max: 10000,
        },
      },
      examples: ["snowflake-axi git branches MY_DB.MY_SCHEMA.MY_REPO"],
      run: branches,
    },
    fetch: {
      description: "Refresh a git repository from its origin (write; needs the git.fetch grant)",
      positionals: { usage: "<db.schema.repo>", min: 1, max: 1 },
      flags: {
        "--role": {
          type: "string",
          placeholder: "<name>",
          description: "run as another role granted to the user; needs WRITE on the repository",
        },
        "--timeout": {
          type: "int",
          placeholder: "<s>",
          description: "statement timeout in seconds",
          default: 300,
          min: 1,
          max: 14400,
        },
      },
      notes: [
        "Refused with WRITE_NOT_ALLOWED until the user grants git.fetch (see `snowflake-axi allow --help`).",
        "FETCH pulls the latest commits, branches, and tags from origin into Snowflake's clone; refs deleted upstream are pruned.",
      ],
      examples: ["snowflake-axi git fetch MY_DB.MY_SCHEMA.MY_REPO --role DBT_ROLE"],
      run: fetch,
    },
  },
});

# snowflake-axi

[![npm version](https://img.shields.io/npm/v/snowflake-axi.svg)](https://www.npmjs.com/package/snowflake-axi)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

A read-first Snowflake explorer for coding agents, built on the [AXI principles](https://axi.md/).

It replaces heavier MCP paths for read and discovery work: zero standing token cost (invoked via Bash on demand), and roughly 40% leaner output than JSON.
Statements run over the Snowflake SQL API with a PAT as a bearer token - one stateless HTTPS request, no driver, no login handshake - so a full query round trip takes about half a second.

## Features

- **Read-first by design.** Reads are always free; writes are refused until you grant them, MCP-style.
- **Token-efficient output.** Compact [TOON](https://toonformat.dev/), minimal schemas, pre-computed aggregates (row counts and sizes without a scan), definitive empty states. Append `--json` to any command for machine-readable JSON (results and errors alike) when piping into a parser.
- **Agent-ergonomic.** Structured errors with `code` and `help[]` next steps, fail-loud flags, and a content-first home view.
- **Beyond raw SQL.** Semantic-view discovery, warehouse credit burn, staged-file peeks, dbt (on Snowflake and local), git repositories, and Snowflake Postgres - each as a focused command.

## Install

```sh
npm install -g snowflake-axi      # global
npx snowflake-axi <command>       # or run without installing
```

From a checkout: `npm install && npm run build && npm link`.

## Quick start

Copy the bundled `env.template` to `~/.config/snowflake-axi/env` and fill in three values:

```sh
SNOWFLAKE_ACCOUNT=<account identifier>
SNOWFLAKE_USER=<service user>
SNOWFLAKE_TOKEN=<programmatic access token>
```

Then verify and explore:

```sh
snowflake-axi doctor                        # check the connection; prints a fix for anything wrong
snowflake-axi                               # connection context + databases
snowflake-axi tables MY_DB.MY_SCHEMA        # tables with row counts and sizes
snowflake-axi find orders                   # search tables/views by name, account-wide
snowflake-axi schema MY_TABLE               # columns, types, row count, size
snowflake-axi sample MY_TABLE --limit 5     # preview rows
snowflake-axi query "SELECT COUNT(*) FROM MY_TABLE"
snowflake-axi semantics                     # curated metric maps with verified queries
```

Run `snowflake-axi <command> --help` for a command's flags and examples.

## Commands

**Explore and query**

| Command | Purpose |
|---|---|
| (no args) | Connection context, databases, next-step suggestions |
| `tables [db[.schema]]` | Tables with row counts and sizes; a database scope lists its schemas |
| `find <pattern>` | Search tables and views by name across every database the roles can see |
| `schema <table>` | Columns with types and nullability, plus row count and size |
| `sample <table>` | Preview rows; `--fields`, `--where`, `--limit`, `--full` |
| `query <sql>` | One statement; reads free, writes gated (below); `--limit`, `--full`, `--timeout`, `--warehouse`, `--role` |
| `result <handle>` | Collect an earlier statement's output without re-running it |
| `semantics [name]` | Semantic views: tables, metrics, dimensions, custom instructions, verified queries; `--like`, `--sql` |
| `warehouses` | Warehouse states, 7-day credit burn, usage guidance; `--full` |

**dbt, git, and stages**

| Command | Purpose |
|---|---|
| `model <name>` | dbt model SQL found by filename across the local model directories |
| `dbt` / `dbt describe <name>` | dbt Projects on Snowflake: account-wide list; versions, source, integrations |
| `dbt ls` / `compile` / `compiled <model>` / `state` | Local dbt read verbs: scope, compile, print compiled SQL, stash a defer reference |
| `dbt run` / `build` / `test` / `seed` / `snapshot` | Local dbt write verbs (1:1 with dbt); need the `dbt.build` grant |
| `dbt execute` / `deploy` / `drop` | Deployed-project writes; each behind its own grant |
| `git [db[.schema]]` / `git branches <repo>` | List git repositories and their branches |
| `git fetch <repo>` | Refresh a repository from origin; needs the `git.fetch` grant |
| `stage <@stage>` / `stage read <@stage/file>` | List stage files; read staged records via a named file format |

**Snowflake Postgres**

| Command | Purpose |
|---|---|
| `pg [tables [schema]]` | Postgres tables largest first with estimated rows and size; `--like`, `--views`, `--limit` |
| `pg schema <table>` | Columns, nullability, defaults, primary key, size (case-insensitive names) |
| `pg sample <table>` | Preview Postgres rows; `--fields`, `--where`, `--limit`, `--full` |
| `pg query <sql>` | One statement; reads free on a read-only session, writes behind the `pg.write` grant |
| `pg dbt <args>` | Run classic dbt-postgres against the serving plane with managed creds; read verbs free, write verbs behind `pg.write` |

**Auth and setup**

| Command | Purpose |
|---|---|
| `role [name]` | Show or switch the persisted active role; `role default` reverts, `--grants` lists granted roles |
| `auth [mode]` | Show or switch the auth mode (`pat`, `oauth`, `default` to clear) |
| `login` / `logout` | Add or remove a browser-SSO login (see Authentication) |
| `allow [capability]` | List, grant (interactive terminal only), or revoke write capabilities |
| `doctor` | Diagnose the connection setup end to end and print a fix for anything wrong |
| `context` / `hooks` | Session-hook orientation line and its install/remove (see Agent integration) |
| `update` | Self-update (built into axi-sdk-js) |

Structured commands accept unquoted identifiers only.
A quoted lowercase or special-character name (such as `"my table"`) is reachable through `query`, which passes SQL through verbatim, but not through `tables`, `schema`, or `sample`.

## Reads free, writes by consent

Two independent layers keep everyday use read-only:

1. Run it as a service user whose role can only SELECT.
2. `query` classifies each statement before any connection is made: a read (`SELECT`, `WITH`, `SHOW`, `DESC`, `DESCRIBE`, `EXPLAIN`) runs for free, and anything else is a write, refused unless `sql.write` is granted.

There is no allow-list of write verbs: whatever the token's role can do, a granted `query` can do.
The write commands - `query` and `pg query`, the local `dbt run`/`build`/`test`/`seed`/`snapshot`, and `dbt execute`/`deploy`/`drop` and `git fetch` - stay disabled until you opt in:

- Until granted, the command fails loud with `WRITE_NOT_ALLOWED` and tells the agent to ask you in conversation.
- After you agree, the agent runs `snowflake-axi allow <capability> --agent`; the harness permission prompt is your confirmation.
- Humans grant directly with `snowflake-axi allow <capability>` in a terminal; `--revoke` withdraws consent anytime.

The grants file (`~/.config/snowflake-axi/grants`) expresses consent, not privilege: what the Snowflake user's roles allow remains the hard boundary, so grant the service user exactly the roles you intend an agent to reach.

## Configuration

Credentials live in `~/.config/snowflake-axi/env` (mode 0600, never committed); process env overrides file values.
Everything else is derived at runtime: role, warehouse, and default namespace come from the Snowflake user's own defaults, and dbt model directories are discovered from the working directory.

Manage the defaults on the Snowflake user rather than in the tool:

```sql
ALTER USER <service user> SET
  DEFAULT_WAREHOUSE = <warehouse>,
  DEFAULT_NAMESPACE = <db.schema>,
  DEFAULT_ROLE = <role>;
```

PAT auth requires a network policy attached to the user; without one, authentication fails with a network-policy error.
The PAT must be minted **without** `ROLE_RESTRICTION` - a role-restricted token pins every session to one role and disables role switching.

If you already use the official snow CLI, no configuration is needed: snowflake-axi falls back to a PAT connection in `~/.snowflake/connections.toml` (or the `[connections]` table of `config.toml`), selected the way snow selects it.

<details>
<summary>Optional overrides and role precedence</summary>

Pin values client-side only if you want them fixed regardless of the user's defaults:

```sh
SNOWFLAKE_ROLE=<primary role per request>
SNOWFLAKE_DATABASE=<default database>
SNOWFLAKE_SCHEMA=<default schema>
SNOWFLAKE_AXI_MODEL_DIRS=<colon-separated dbt model dirs, used instead of discovery>
SNOWFLAKE_AXI_DEFAULT_FILE_FORMAT=<named file format, for the stage command>
SNOWFLAKE_AXI_DBT_TARGET=<default target for local dbt compile/build/test>
```

The warehouse is never configured: statements run on the user's `DEFAULT_WAREHOUSE`, `query --warehouse <name>` switches one statement, and dbt runs use the warehouse in the project's own profiles.

Role precedence per statement, highest first: `--role` on the command, then `SNOWFLAKE_ROLE` in the process env (pins one session), then the persisted active role from `snowflake-axi role` (machine-wide), then `SNOWFLAKE_ROLE` from the env file.

</details>

## Authentication

PAT auth is the default whenever a `SNOWFLAKE_TOKEN` is configured.
Browser SSO via Snowflake OAuth is an alternative that runs under your own identity.

<details>
<summary>Browser SSO login (OAuth)</summary>

`snowflake-axi login` runs Snowflake's built-in OAuth authorization-code flow with PKCE as a public client (no client secret ships in the tool), then refreshes silently for up to 90 days.

One-time admin setup:

```sql
CREATE SECURITY INTEGRATION AXI_OAUTH
  TYPE = OAUTH
  OAUTH_CLIENT = CUSTOM
  OAUTH_CLIENT_TYPE = 'PUBLIC'
  OAUTH_REDIRECT_URI = 'http://localhost:8976/callback'
  OAUTH_ALLOW_NON_TLS_REDIRECT_URI = TRUE
  OAUTH_ISSUE_REFRESH_TOKENS = TRUE
  OAUTH_REFRESH_TOKEN_VALIDITY = 7776000
  OAUTH_USE_SECONDARY_ROLES = IMPLICIT
  ENABLED = TRUE;

SELECT SYSTEM$SHOW_OAUTH_CLIENT_SECRETS('AXI_OAUTH');  -- OAUTH_CLIENT_ID
```

Each user adds to the env file and runs `snowflake-axi login`:

```sh
SNOWFLAKE_ACCOUNT=<account identifier>
SNOWFLAKE_OAUTH_CLIENT_ID=<from SYSTEM$SHOW_OAUTH_CLIENT_SECRETS>
SNOWFLAKE_OAUTH_ROLE_SCOPE=<optional: pin a session role at login>
```

Every Snowflake OAuth token is pinned to exactly one role, so the token file is a **ring** of independent logins keyed by role:

- `login --role <name>` adds that role's login, one browser consent each.
- Per-query `--role <name>` selects the matching login; a role without one fails fast with the exact command to run.
- `snowflake-axi role <name>` sets a persisted active role every command uses; `role default` reverts.
- `logout [--role <name> | --all]` removes logins; removing the last one falls back to PAT.

`snowflake-axi auth oauth` persists the switch to OAuth (`auth pat` switches back), and `SNOWFLAKE_AUTH` overrides per session.
Refresh tokens on disk are long-lived credentials; the file is 0600 and should be treated like a PAT.

</details>

<details>
<summary>Provisioning access for agents</summary>

A PAT service user reaches any granted role instantly, so an agent never waits on a human; OAuth adds SSO/MFA and a per-user audit trail at the cost of a browser login per role.

For agent-heavy use, provision a dedicated service user and let secondary roles cover object visibility:

```sql
CREATE USER SVC_AGENT TYPE = SERVICE COMMENT = 'snowflake-axi agent access';
GRANT ROLE ANALYTICS_READ TO USER SVC_AGENT;
ALTER USER SVC_AGENT SET
  DEFAULT_ROLE = ANALYTICS_READ,
  DEFAULT_WAREHOUSE = <warehouse>,
  DEFAULT_NAMESPACE = <db.schema>,
  DEFAULT_SECONDARY_ROLES = ('ALL');
```

With `DEFAULT_SECONDARY_ROLES = ('ALL')` every statement carries the union of the user's granted roles, so the agent never has to guess which role can see an object.
On a purpose-built service user that union is exactly the intended boundary - blast radius is controlled by granting precisely the roles the agent should reach, and nothing else.
Writes that create objects still care about the primary role (it becomes the owner); pick it with `--role` or pin it with `snowflake-axi role`.

To require every statement be attributable to one explicit role instead, keep `DEFAULT_SECONDARY_ROLES = ()`; the agent then discovers the right role with `snowflake-axi role --grants` and retries with `--role <name>`.

</details>

## Local dbt

`dbt ls`, `compile`, `state`, and the write verbs `run`/`build`/`test`/`seed`/`snapshot` spawn the local dbt CLI on the project in the working directory, so an agent can iterate on model code before it is committed or deployed.
The verbs mirror dbt's own 1:1: `run` materializes without tests, `build` adds each node's tests.
`dbt ls` prints the nodes a selector matches without running anything (`--select +my_model` for ancestors, `my_model+` for descendants); `dbt compiled <model>` prints compiled SQL straight from `target/compiled`.

They target the dbt-Projects-on-Snowflake layout, where the repo commits a credential-less `profiles.yml`.
Locally, snowflake-axi reads the repo's targets and injects its own credentials into an ephemeral profile handed to the dbt subprocess - the token never touches disk, and no `~/.dbt/profiles.yml` is needed.
The target comes from `--target`, else `SNOWFLAKE_AXI_DBT_TARGET`; with neither, the command fails loud and lists the repo's targets.
The dbt CLI must be installed separately (for example, dbt-core with the dbt-snowflake adapter).

<details>
<summary>Slim builds and defer</summary>

`--defer --state <dir>` builds only the selected nodes and resolves unselected upstream `ref()`s to the `manifest.json` in `<dir>` (a prior, typically production, run) instead of rebuilding the whole DAG.
`--favor-state` prefers that manifest even when a node also exists in the target, and implies `--defer`.
`--state` alone enables `state:` selectors such as `--select state:modified+`.
A missing directory or absent `manifest.json` fails loud before dbt spawns.

`dbt state --target prod --into <dir>` produces that reference in one step, and on `run`/`build`, `--empty` materializes with `LIMIT 0` to validate SQL and schema at near-zero cost.

</details>

## Snowflake Postgres

The `pg` command group explores a Snowflake Postgres database over a direct wire connection, mirroring the Snowflake surface verb for verb.
Bare `pg` lists every user schema's tables largest first with a connection header, so one call orients an agent completely.

The connection uses its own keys in the same env file, deliberately separate from ambient `PGHOST`-style variables:

```sh
SNOWFLAKE_AXI_PG_HOST=<instance endpoint>
SNOWFLAKE_AXI_PG_USER=<postgres role>
SNOWFLAKE_AXI_PG_PASSWORD=<password>
SNOWFLAKE_AXI_PG_PORT=<optional, default 5432>
SNOWFLAKE_AXI_PG_DATABASE=<optional, default postgres>
SNOWFLAKE_AXI_PG_SSLMODE=<optional: disable, require (default), verify-full>
```

The connection is pinned to one database; pass `--database <name>` on any `pg` command to switch per call - handy for hopping between prod and dev - or set `SNOWFLAKE_AXI_PG_DATABASE` for the default.

`pg query` reads on a session opened `default_transaction_read_only=on`, so even DML smuggled past the head check is rejected by the server; writes run on a read-write session behind `pg.write`.
`EXPLAIN ANALYZE` is classified by what it wraps, since it executes what it plans.
A read that writes in fact - a `SELECT` calling a `VOLATILE` function that performs `INSERT`/`TRUNCATE` - is rejected by the read-only session; pass `--write` to route it through the read-write session:

```sh
snowflake-axi pg query --write "SELECT dim_ingest.refresh_all('light')"
```

Row counts in `pg tables`/`pg schema` are planner estimates; `pg query` probes one row past `--limit`, reporting an exact `N (complete)` or an honest `first N rows (more exist)`.

### Classic dbt against Postgres

`pg dbt <args>` runs a dbt project against Snowflake Postgres, the Postgres counterpart to the Snowflake-side [local dbt](#local-dbt).
It is a thin passthrough: the verb and every dbt flag (`--select`, `--exclude`, `--full-refresh`, ...) go straight to dbt, while `--database`, `--target`, `--project-dir`, and `--timeout` are read by the wrapper.

```sh
snowflake-axi pg dbt compile --select <selector> --database <db>
snowflake-axi pg dbt build --select tag:<tag> --database <db>
snowflake-axi pg dbt run-operation <macro> --database <db>
```

It runs a managed, pinned `dbt-core` + `dbt-postgres` 1.8 - classic dbt, not Fusion - so a local run matches a serving-plane deployment verb for verb.
The runtime is a venv under the config directory, provisioned on first use via `uv` (or `python3`); point `SNOWFLAKE_AXI_DBT_PG_BIN` at your own dbt to skip it.
Credentials come from the same `SNOWFLAKE_AXI_PG_*` connection above, injected into an ephemeral profile so the repo keeps a credential-less committed `profiles.yml`; the password stays off disk behind an env var, and the wrapper also injects `--profiles-dir`, `--target`, and `--no-version-check`.
The project root is `--project-dir`, else `SNOWFLAKE_AXI_DBT_PG_PROJECT_DIR`, else the working directory; the target is `--target`, else `SNOWFLAKE_AXI_DBT_PG_TARGET`, else the profile's own default (and it must be a `postgres` target).
`--database` sets the dbt dbname for the call, defaulting to `SNOWFLAKE_AXI_PG_DATABASE`, so hopping between prod and dev stays a one-flag switch.

Read verbs (`compile`, `ls`, `parse`, `deps`, `debug`, `docs`, `source`, `show`) run free; write verbs (`build`, `run`, `run-operation`, `seed`, `snapshot`, `test`, and anything else) are refused until the user grants `pg.write` - the same grant as `pg query --write`.

## Agent integration

Two complementary paths teach agents that the tool exists; install either or both.

- **Session hook.** `snowflake-axi hooks install` registers a SessionStart hook for Claude Code, Codex, and OpenCode that prints a one-line, config-derived context (no connection is made, so it can never hang a session start). `snowflake-axi hooks remove` withdraws it.
- **Skill.** `skill/SKILL.md` is an installable [Agent Skill](https://agentskills.io) that teaches the command surface upfront, so no discovery turns are spent on `--help`. Copy it to your agent's skill directory (Claude Code: `~/.claude/skills/snowflake-axi/SKILL.md`). It loads on demand with no per-session token cost.

## Plugins

Domain-specific commands load from `~/.config/snowflake-axi/plugins/*.mjs`, keeping private routing knowledge out of this repo.
Each plugin default-exports a factory that returns `commands` and optional `homeHelp`:

```js
export default function myPlugin({ sql, config, AxiError, helpers }) {
  return {
    commands: {
      mycmd: {
        summary: "One-line summary for the top-level help",
        help: "Full --help text",
        run: async (args) => ({ answer: 42 }),
      },
    },
    homeHelp: ["Run `snowflake-axi mycmd` to ..."],
  };
}
```

`sql(text, { binds, maxRows })` runs a statement on the shared read-only connection; returned objects are rendered as TOON; throw `AxiError(message, code, suggestions)` for structured errors.
Plugins cannot shadow core commands, and a broken plugin is skipped with a warning on stderr.

## Development

```sh
npm install
npm run build            # tsc -> dist/
npm test                 # unit tests (mocked SQL)
npm run test:integration # end-to-end against a real account
```

The integration suite works against **any** Snowflake account: it touches only universal objects (`GENERATOR`, the shared `SNOWFLAKE` database, `INFORMATION_SCHEMA`, `SHOW`), needs no fixtures or write access, and skips the live tests when no credentials are configured.
`test-integration/docs.test.ts` is a doc-drift guard: every `snowflake-axi` example in this README and in `skill/SKILL.md` is run against the built CLI, so a renamed flag or removed command cannot leave stale docs behind.
CI runs the build, the unit suite, and the credential-free integration tests on Node 22 and 24.

The command dispatch, TOON serialization, structured errors, and self-update come from [axi-sdk-js](https://www.npmjs.com/package/axi-sdk-js); this repo contains only Snowflake logic.

## License

[MIT](LICENSE)

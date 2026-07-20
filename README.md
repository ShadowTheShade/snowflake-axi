# snowflake-axi

Read-only Snowflake explorer for coding agents, built on the [AXI principles](https://axi.md/): TOON output, minimal schemas, pre-computed aggregates, definitive empty states, fail-loud flags.
It replaces heavier MCP paths for read and discovery work: zero standing token cost (invoked via Bash on demand) and ~40% leaner output than JSON.
Statements run over the Snowflake SQL API with the PAT as a bearer token - one stateless HTTPS request, no driver, no login handshake - so a full query round trip completes in about half a second.

## Usage

```sh
snowflake-axi                 # home view: connection context + databases
snowflake-axi tables          # tables in the default schema, largest first
snowflake-axi tables MY_DB    # schema summary for a database
snowflake-axi find flavor     # search tables/views by name across the account
snowflake-axi schema MY_TABLE # columns, types, row count, size
snowflake-axi sample MY_TABLE --limit 3 --fields COL_A,COL_B
snowflake-axi query "SELECT COUNT(*) FROM MY_TABLE"
snowflake-axi query "UPDATE MY_TABLE SET STATUS = 'DONE' WHERE ID = 1"   # write, gated by sql.write
snowflake-axi result 01b66701-0000-23c5-0000-45a100012345  # collect an earlier statement's output
snowflake-axi semantics       # semantic views: the curated map of tables, metrics, verified queries
snowflake-axi warehouses      # states + 7-day credit burn
snowflake-axi model my_model  # local dbt model SQL behind a table
snowflake-axi dbt             # dbt Projects on Snowflake, account-wide
snowflake-axi dbt ls --select +my_model             # list local nodes matching a selector, without running them
snowflake-axi dbt compile     # compile the local dbt repo with the tool's credentials
snowflake-axi dbt compiled my_model                 # print my_model's compiled SQL from the last compile
snowflake-axi dbt state --target prod --into prod-artifacts   # stash prod's manifest.json as a --defer reference
snowflake-axi dbt run --select my_model             # materialize local models into the chosen target (write, gated)
snowflake-axi dbt build --select my_model --defer --state prod-artifacts   # slim build against a reference manifest (write, gated)
snowflake-axi dbt deploy MY_PROJECT --branch main   # cut a new project version from git (write, gated)
snowflake-axi git             # git repositories on Snowflake, account-wide
snowflake-axi git branches MY_DB.MY_SCHEMA.MY_REPO  # branches with commit hashes
snowflake-axi stage @DB.SCHEMA.STAGE
snowflake-axi pg              # Snowflake Postgres: every schema's tables, largest first
snowflake-axi pg schema orders              # columns, types, defaults, primary key
snowflake-axi pg sample orders --limit 3
snowflake-axi pg query "SELECT count(*) FROM orders"
snowflake-axi pg query "UPDATE MY_TABLE SET status = 'done' WHERE id = 1"   # write, gated by pg.write
snowflake-axi allow           # write capabilities and their grant status
snowflake-axi hooks           # session-start hook status; see Agent integration
snowflake-axi doctor          # diagnose connection setup and print a fix for anything wrong
snowflake-axi <command> --help
```

Install globally with `npm install -g snowflake-axi`, or run without installing via `npx snowflake-axi <command>`.
From a checkout, use `npm install && npm run build && npm link`.

## Configuration

Credentials live in `~/.config/snowflake-axi/env` (process env overrides file values, never commit this file).
Copy `env.template` (shipped with the package) to that path as a starting point, then run `snowflake-axi doctor` to verify the connection and get a fix for anything missing.
Three values are required for PAT auth (or skip the PAT entirely with browser SSO; see [Browser SSO login](#browser-sso-login-oauth)):

```
SNOWFLAKE_ACCOUNT=<account identifier>
SNOWFLAKE_USER=<service user>
SNOWFLAKE_TOKEN=<programmatic access token>
```

Everything else the tool derives at runtime, so there is nothing more to configure:

- Role, warehouse, and default namespace come from the Snowflake user's own defaults; unqualified table names and the bare `tables` command resolve against `DEFAULT_NAMESPACE` inside the session.
- dbt model directories are discovered from the working directory (`dbt_project.yml` upward and a few levels down, honoring `model-paths`).

The Snowflake user is the recommended place to manage all of it:

```sql
ALTER USER <service user> SET
  DEFAULT_WAREHOUSE = <warehouse>,
  DEFAULT_NAMESPACE = <db.schema>,
  DEFAULT_ROLE = <role>,
  DEFAULT_SECONDARY_ROLES = ();  -- one explicit role per statement
```

Granting and revoking Snowflake roles on the user is the single access control; the CLI needs no role configuration at all.
Statements run as the user's `DEFAULT_ROLE`, and `--role <name>` on `query` and `dbt execute` runs a single statement as another granted role, so privileges stay explicit per action.
When roles are pinned in several places, precedence per statement is: `--role`, then `SNOWFLAKE_ROLE` in the process env (pins one session without touching shared state), then the persisted active role from `snowflake-axi role` (machine-wide, shared by every session), then `SNOWFLAKE_ROLE` from the env file.
If you prefer every statement to carry the union of all granted roles instead, set `DEFAULT_SECONDARY_ROLES = ('ALL')`; for a dedicated agent user that is usually the right call (see [Provisioning access for agents](#provisioning-access-for-agents)).
Either way the PAT must be minted without `ROLE_RESTRICTION`: a role-restricted token pins every session to that one role and disables secondary roles entirely.

Optional overrides for setups that want them pinned client-side:

```
SNOWFLAKE_ROLE=<primary role per request>
SNOWFLAKE_DATABASE=<default database>
SNOWFLAKE_SCHEMA=<default schema>
SNOWFLAKE_AXI_MODEL_DIRS=<colon-separated dbt model dirs, used instead of discovery>
SNOWFLAKE_AXI_DEFAULT_FILE_FORMAT=<named file format, for the stage command>
SNOWFLAKE_AXI_DBT_TARGET=<default target for local dbt compile/build/test>
```

The warehouse is never configured: statements run on the user's `DEFAULT_WAREHOUSE`, `query --warehouse <name>` switches one statement, and dbt executions use the warehouse pinned in the project's own profiles.

PAT auth requires a network policy attached to the Snowflake user; without one authentication fails with a network-policy error.

When a value is not provided by the process env or the env file, snowflake-axi falls back to the official snow CLI's connection configuration: `~/.snowflake/connections.toml`, or the `[connections]` table in `~/.snowflake/config.toml`.
The connection is selected the way snow selects it (`SNOWFLAKE_DEFAULT_CONNECTION_NAME`, then `default_connection_name` in config.toml, then `default`), and `SNOWFLAKE_HOME` relocates the directory.
Only PAT connections are usable: a `token` with `authenticator = "PROGRAMMATIC_ACCESS_TOKEN"`, or a `password` field that holds a PAT.
Real passwords do not work (statements run over the SQL API, which takes the PAT as a bearer token); browser, SSO, OAuth, and key-pair connections are ignored.
If you already use the snow CLI, snowflake-axi needs no configuration of its own.

## Browser SSO login (OAuth)

`snowflake-axi login` is an alternative to the PAT: one browser login under your own identity (delegating to the account's SSO IdP when one is configured), then silent token refresh for up to 90 days.
It runs Snowflake's built-in OAuth authorization-code flow with PKCE as a public client, so no client secret ships in the tool.

One-time admin setup:

```sql
CREATE SECURITY INTEGRATION AXI_OAUTH
  TYPE = OAUTH
  OAUTH_CLIENT = CUSTOM
  OAUTH_CLIENT_TYPE = 'PUBLIC'
  OAUTH_REDIRECT_URI = 'http://localhost:8976/callback'
  OAUTH_ALLOW_NON_TLS_REDIRECT_URI = TRUE  -- loopback redirect never leaves the machine (RFC 8252)
  OAUTH_ISSUE_REFRESH_TOKENS = TRUE
  OAUTH_REFRESH_TOKEN_VALIDITY = 7776000
  OAUTH_USE_SECONDARY_ROLES = IMPLICIT  -- activate the user's default secondary roles at session start
  ENABLED = TRUE;

SELECT SYSTEM$SHOW_OAUTH_CLIENT_SECRETS('AXI_OAUTH');  -- OAUTH_CLIENT_ID
```

Each user then adds to the env file:

```
SNOWFLAKE_ACCOUNT=<account identifier>
SNOWFLAKE_OAUTH_CLIENT_ID=<from SYSTEM$SHOW_OAUTH_CLIENT_SECRETS>
SNOWFLAKE_OAUTH_ROLE_SCOPE=<optional: pin a session role at login>
```

and runs `snowflake-axi login`.
The browser opens the account's authorize page (headless machines get the URL printed to paste elsewhere), and the tokens land in `~/.config/snowflake-axi/oauth-tokens.json` with mode 0600.
Logging in never switches the auth mode by itself when a PAT is configured: PAT stays the default, and `snowflake-axi auth oauth` persists the switch (`auth pat` switches back, `auth default` clears the choice).
`SNOWFLAKE_AUTH=<mode>` in the process env or the env file overrides the persisted mode, and with no PAT configured the ring activates on its own.

Every Snowflake OAuth token is pinned to exactly one role (`session:role:<name>` is the only session scope the built-in flow accepts), so the token file is a **ring** of independent logins keyed by role:

- `login` adds the default-role login; `login --role <name>` adds that role's login, one browser consent each, every one refreshing silently for its own 90 days.
- Per-query `--role <name>` selects the matching login from the ring; a role without one fails fast with the exact `login --role` command to run.
- `snowflake-axi role <name>` sets a persisted **active role** that every command uses as its default primary role, so `schema`, `tables`, `query`, and the rest run as it without a per-command flag; `role` alone shows it, `role default` reverts to the unscoped login, and `role --grants` lists every role the user could log in as. `--role` on a command still overrides the active role for that one run.
- Without an active role or `--role`, the default login runs - or the only login, when a single role-pinned one exists.
- `logout [--role <name> | --all]` removes logins; removing the last one deletes the file and the tool falls back to PAT.

Access tokens live about ten minutes and refresh silently before each request that needs it; when a login's refresh token expires (default 90 days) or is revoked, commands fail with the exact login command to rerun.

Constraints worth knowing:

- In-session `USE ROLE` does not exist over the stateless SQL API, and Snowflake OAuth has no any-role scope: the ring is the role-switching mechanism, one explicit login per role.
- Secondary roles follow the integration's `OAUTH_USE_SECONDARY_ROLES`: the default `NONE` suppresses them entirely, `IMPLICIT` (above) activates the user's `DEFAULT_SECONDARY_ROLES` at session start (both verified live).
  With `IMPLICIT` and `DEFAULT_SECONDARY_ROLES = ('ALL')` every session ambiently carries the privilege union of all granted roles - including admin roles the user holds, since the blocked-roles list only guards the primary role.
  With the ring available, explicit `--role` selection is usually the better model; keep `DEFAULT_SECONDARY_ROLES = ()` unless queries genuinely need cross-role reads in one statement.
- Snowflake blocks ACCOUNTADMIN and SECURITYADMIN as the primary role over OAuth by default.
- Local dbt verbs work under OAuth: the ephemeral profile uses dbt's native `authenticator: oauth` with a freshly refreshed access token.
  The ring supplies the login matching the target's `role:` when one exists (`login --role <builder role>` once); otherwise the default login connects and a role mismatch fails with that hint.
  Access tokens live ~10 minutes; connections opened while it is valid keep working, and the profile defaults `reuse_connections: true` so long runs ride them.
- The refresh tokens on disk are long-lived credentials; the file is 0600 and should be treated like a PAT.

## Provisioning access for agents

The two auth modes trade off differently for agent use, and the difference shows up in how easily an agent lands on the right role.

- A PAT service user reaches any granted role instantly: `--role` and `snowflake-axi role` switch with zero ceremony, so an agent never waits on a human.
- OAuth runs under your own identity with SSO/MFA, per-role consent, and a real audit trail, but every new role needs a browser login (`login --role <name>`), so an agent is blocked until you add it.

For agent-heavy use, provision a dedicated service user and make role selection a non-problem at the user layer:

```sql
CREATE USER SVC_AGENT TYPE = SERVICE COMMENT = 'snowflake-axi agent access';
GRANT ROLE ANALYTICS_READ TO USER SVC_AGENT;
GRANT ROLE MARTS_READ TO USER SVC_AGENT;
ALTER USER SVC_AGENT SET
  DEFAULT_ROLE = ANALYTICS_READ,
  DEFAULT_WAREHOUSE = <warehouse>,
  DEFAULT_NAMESPACE = <db.schema>,
  DEFAULT_SECONDARY_ROLES = ('ALL');
```

With `DEFAULT_SECONDARY_ROLES = ('ALL')` every statement carries the union of the user's granted roles, so the agent never has to guess which role can see an object.
On a purpose-built service user that union is exactly the intended boundary: blast radius is controlled by granting the user precisely the roles an agent should reach, and nothing else.
The usual caution against `('ALL')` applies to human identities, where the union would ambiently include admin roles the person happens to hold; it does not apply to a user that only holds agent-scoped roles.
Writes that create objects still care about the primary role (it becomes the owner); pick it per statement with `--role` or pin it with `snowflake-axi role`.

Keep `DEFAULT_SECONDARY_ROLES = ()` instead when each statement should be attributable to one explicit role.
The agent then discovers the right role with `snowflake-axi role --grants` and retries with `--role <name>`; a does-not-exist-or-not-authorized error suggests exactly that.

## Read-only by default, writes by consent

Two independent layers keep everyday use read-only:

1. Run it as a service user whose role can only SELECT.
2. `query` classifies each statement before any connection is made: a read (SELECT, WITH, SHOW, DESC, DESCRIBE, EXPLAIN) runs for free, and anything else is treated as a write and refused unless `sql.write` is granted. Single statement only.

So reading is always free, and writing through `query` is gated by consent (see "Writing to Snowflake" below).

Specific write commands exist (`query`/`pg query` for raw Snowflake and Postgres DML/DDL, the local `dbt run`/`build`/`test`/`seed`/`snapshot`, plus `dbt execute`, `dbt deploy`, `dbt drop`, and `git fetch`) but are disabled until the user opts in, MCP-style:

- Until granted, the command fails loud with `WRITE_NOT_ALLOWED` and tells the agent to ask the user in conversation.
- Once the user agrees, the agent runs `snowflake-axi allow <capability> --agent`; the harness permission prompt for that command is the user's confirmation click.
- Humans grant directly with `snowflake-axi allow <capability>` in an interactive terminal; without a terminal and without `--agent`, granting refuses.
- `snowflake-axi allow <capability> --revoke` withdraws consent at any time.

The grants file (`~/.config/snowflake-axi/grants`) expresses user consent, not security: what the Snowflake user's roles allow remains the hard boundary, so grant the service user exactly the roles you intend an agent to reach.

## Commands

| Command | Purpose |
|---|---|
| (no args) | Connection context, databases, next-step suggestions |
| `tables [db[.schema]]` | Tables with row counts and sizes (INFORMATION_SCHEMA, no scan); db scope lists schemas, no scope and no default lists databases |
| `find <pattern>` | Search tables and views by name across every database the roles can see |
| `schema <table>` | Columns with types and nullability, plus row count and size |
| `sample <table>` | Preview rows; `--fields`, `--where`, `--limit`, `--full` |
| `query <sql>` | One statement; reads run free, a write (anything not SELECT/WITH/SHOW/DESC/EXPLAIN) needs the `sql.write` grant and reports Snowflake's count/status row; definitive total counts, 200-char cell truncation, `--full`, `--limit`, `--timeout`, one-off `--warehouse` / `--role` |
| `result <handle>` | Collect an earlier statement's output without re-running it (handles print to stderr when a query runs long) |
| `role [name]` | Show or switch the persisted active role every command runs as; `role <name>` switches, `role default` reverts, `--grants` lists every role granted to the user |
| `auth [mode]` | Show or switch the persisted auth mode (`pat`, `oauth`, `default` to clear); PAT is the default whenever a PAT is configured, and `SNOWFLAKE_AUTH=<mode>` overrides per session |
| `semantics [name]` | Semantic views account-wide; per view: tables, metrics, dimensions, custom instructions, verified queries (`--like` filters, `--sql <query>` prints blessed SQL) |
| `warehouses` | Warehouse states, 7-day credit burn, usage-guidance comments; `--full` |
| `model <name>` | dbt model SQL found by filename across `SNOWFLAKE_AXI_MODEL_DIRS` |
| `dbt` / `dbt describe <name>` | dbt Projects on Snowflake: account-wide list; versions, source, and integrations per project |
| `dbt ls` | List local dbt nodes matching a selector without running them (read-only); `--select`, `--exclude`, `--resource-type`, `--state`, `--target` |
| `dbt compile` | Compile the local dbt project against Snowflake (read-only); `--select`, `--exclude`, `--target`, `--defer`, `--state`, `--project-dir` |
| `dbt compiled <model>` | Print a model's compiled SQL from the last compile (read-only) |
| `dbt state --into <dir>` | Compile the whole project and stash its `manifest.json` as a `--defer`/`--state` reference (read-only) |
| `dbt run` / `build` / `test` / `seed` / `snapshot` | The local dbt write verbs, 1:1 with dbt's own; all need the `dbt.build` grant; `--select`, `--full-refresh`, `--fail-fast`, `--defer`, `--state`, `--favor-state`; `run`/`build` also take `--empty` |
| `dbt execute <name>` | Run a dbt command in a deployed project; write, needs the `dbt.execute` grant; `--role` when the default role cannot execute it |
| `dbt deploy <name>` | Create a project or cut a new version from its git repository (FETCH + CREATE / ADD VERSION, no upload); write, needs the `dbt.deploy` grant; `--branch`, `--repo`, `--path`, `--target`, `--integrations`, `--role` |
| `dbt drop <name>` | Drop a dbt project and all its versions (idempotent); write, needs the `dbt.drop` grant; `--role` |
| `git [db[.schema]]` | List git repositories with origin and last-fetched; scope narrows to a database or schema |
| `git branches <repo>` | Branches in a repository with commit hashes; `--like`, `--limit` |
| `git fetch <repo>` | Refresh a repository from its origin (FETCH); write, needs the `git.fetch` grant; `--role` |
| `stage <@stage>` / `stage read <@stage/file>` | List stage files; read staged records via a named file format |
| `pg [tables [schema]]` | Snowflake Postgres tables largest first with estimated rows and size; `--like`, `--views`, `--limit` |
| `pg schema <table>` | Columns with types, nullability, and defaults, plus primary key and size; names resolve case-insensitively |
| `pg sample <table>` | Preview Postgres rows; `--fields`, `--where`, `--limit`, `--full` |
| `pg query <sql>` | One Postgres statement; reads run free on a server read-only session, a write needs the `pg.write` grant and reports the command tag, `affected` count, and any RETURNING rows; definitive completeness reporting, `--limit`, `--full`, `--timeout` |
| `allow [capability]` | List, grant (interactive terminal only), or revoke write capabilities |
| `context` | One-line config-derived orientation for session hooks; no connection, silent when unconfigured |
| `hooks` | SessionStart hook status; `install` registers it for Claude Code, Codex, and OpenCode, `remove` withdraws it |
| `update` | Self-update (built into axi-sdk-js) |

Structured commands accept unquoted identifiers only.
A table created with a quoted lowercase or special-character name (such as `"my table"`) is reachable through `query`, which passes SQL through verbatim, but not through `tables`, `schema`, or `sample`.

## Writing to Snowflake

`query` runs any single statement, and classifies it by head keyword: a read (SELECT, WITH, SHOW, DESC, DESCRIBE, EXPLAIN) runs for free, and anything else is a write.
A write is refused with `WRITE_NOT_ALLOWED` until the user grants `sql.write` (see "Read-only by default, writes by consent" above); once granted, the same command runs it.
There is no allow-list of write verbs: whatever the token's role can do, a granted `query` can do, so INSERT, UPDATE, DELETE, MERGE, TRUNCATE, CREATE, ALTER, DROP, COPY, CALL, GRANT, and the rest all work through the one verb.

The grant is consent, not privilege: what the token's role is granted to do remains the hard boundary on what a write can actually change, so grant the service user exactly the roles you intend an agent to reach.
Output for a write is whatever Snowflake returns: a single DML count row (`number of rows deleted: 5`) or DDL status row is surfaced inline as `result`, while COPY and CALL that return many rows are shaped like a read with a definitive count.
`--warehouse` and `--role` pick a one-off warehouse or role for the statement, reads and writes alike.

## Local dbt

`dbt ls`, `compile`, `state`, and the write verbs `run`, `build`, `test`, `seed`, and `snapshot` spawn the local dbt CLI on the project in the working directory (or `--project-dir`), so agents can iterate on model code before it is committed or deployed anywhere.
The verbs mirror dbt's own 1:1, so "run my_model" means exactly what it means in dbt; `run` materializes without tests, `build` adds each node's tests and gates downstream nodes on them.
`dbt ls` resolves the DAG and prints the node names a selector matches without running anything, so an agent can scope a build first (`--select +my_model` for ancestors, `my_model+` for descendants); `dbt compiled <model>` prints a model's compiled SQL straight from `target/compiled` so there is no file tree to hunt through.

They are built for the dbt Projects on Snowflake layout, where the repo commits a credential-less `profiles.yml` (empty `account`/`user`) because the server-side session injects identity.
Locally, snowflake-axi plays that same role: it reads the repo's targets (role, database, schema, warehouse), replaces every auth field with its own credentials in an ephemeral profile directory handed to the dbt subprocess, and deletes it after the run.
The token itself never touches disk - the generated profile references an env var that only the dbt subprocess receives.
No `~/.dbt/profiles.yml` or `DBT_PROFILES_DIR` is needed, and existing ones are ignored.

The target comes from `--target`, falling back to `SNOWFLAKE_AXI_DBT_TARGET` from the config; with neither set the command fails loud and lists the repo's targets.
Pointing the default at a personal sandbox target keeps agent iteration isolated from shared schemas.

`--defer --state <dir>` is the slim-build pattern: build only the selected nodes and resolve their unselected upstream `ref()`s to the `manifest.json` in `<dir>` (a prior, typically production, run) instead of rebuilding the whole DAG.
`--favor-state` prefers that manifest even when a node also exists in the target, and implies `--defer`.
`--state` is useful on its own too, enabling `state:` selectors such as `--select state:modified+`.
The state directory is validated before dbt spawns: a missing directory or absent `manifest.json` fails loud rather than surfacing as an opaque dbt error.
`dbt state --target prod --into <dir>` produces that reference in one step: it compiles the whole project against the target and copies the fresh `manifest.json` into `<dir>`, ready to pass back as `--state`.
On `run` and `build`, `--empty` materializes each model with a `LIMIT 0` query, validating its SQL and schema against the real upstream tables at near-zero warehouse cost without building any rows.

dbt's own log streams to stderr for humans; stdout carries a compact per-node summary parsed from `run_results.json`, and node failures become a structured `DBT_ERROR` listing each failing node.
The dbt CLI must be installed separately, for example as a uv tool: dbt-core with the dbt-snowflake adapter alongside.

## Snowflake Postgres

The `pg` command group explores a Snowflake Postgres database over a direct wire connection, mirroring the Snowflake surface verb for verb: `pg tables`, `pg schema`, `pg sample`, and `pg query` (which reads for free and runs writes behind the pg.write grant).
Bare `pg` lists every user schema's tables largest first with a connection header, so one call orients an agent completely.

The connection is configured with its own keys in the same env file, deliberately separate from any ambient `PGHOST`-style variables so shell state from unrelated work can never retarget the tool:

```
SNOWFLAKE_AXI_PG_HOST=<instance endpoint>
SNOWFLAKE_AXI_PG_USER=<postgres role>
SNOWFLAKE_AXI_PG_PASSWORD=<password>
SNOWFLAKE_AXI_PG_PORT=<optional, default 5432>
SNOWFLAKE_AXI_PG_DATABASE=<optional, default postgres>
SNOWFLAKE_AXI_PG_SSLMODE=<optional: disable, require (default), verify-full>
```

`pg query` classifies each statement by head keyword and takes one of two paths:

- A read (SELECT, WITH, TABLE, VALUES, SHOW, or EXPLAIN over a read) runs on a session opened with `default_transaction_read_only=on` in the startup packet, so even DML smuggled past the head check (for example a data-modifying CTE, or `EXPLAIN ANALYZE INSERT`) is rejected by the server. No grant is needed.
- Anything else is a write: refused with `WRITE_NOT_ALLOWED` until the user grants `pg.write`, then run on a session opened `default_transaction_read_only=off`. It reports the server command tag, the `affected` row count for DML, and any RETURNING rows (200-char cell truncation, `--full`).

`EXPLAIN ANALYZE` is classified by what it wraps, because it executes what it plans: `EXPLAIN ANALYZE SELECT` is a read, but `EXPLAIN ANALYZE INSERT` (or the `CREATE TABLE AS` form that slips past even a read-only transaction, verified live) counts as a write.
Both paths run through the extended protocol, which makes multi-statement SQL a server-side error, and the Postgres role's own privileges remain the hard boundary on what a write can actually change.

Head-keyword classification cannot see side effects reached *through* a read: a `SELECT` that calls a `VOLATILE` function performing `INSERT`/`TRUNCATE`, or a `WITH` wrapping a data-modifying CTE, reads by prefix but writes in fact, so the read-only session rejects it.
Pass `--write` to route such a statement through the read-write session (gated by `pg.write`); it then reports as a write - command tag, `affected`, and any returned rows.
The read-only default is preserved for every ordinary read, and the Postgres role's privileges stay the hard boundary regardless.

```sh
snowflake-axi pg query --write "SELECT dim_ingest.refresh_all('light')"   # invoke a writing function
```

Row counts in `pg tables` and `pg schema` are planner estimates (`reltuples`); a blank means the table was never analyzed.
`pg query` streams through a cursor and probes one row past `--limit`, so it reports either an exact `N (complete)` or an honest `first N rows (more exist)` without ever buffering an unbounded result.

## Agent integration

Two complementary paths teach agents that the tool exists; install whichever fits, or both.

The session hook gives every agent session a one-line ambient context: running `snowflake-axi hooks install` (explicit opt-in) registers a SessionStart hook for Claude Code, Codex, and OpenCode.
The hook runs the `snowflake-axi-context` binary (an argument-less alias of the `context` command, which session hooks require), printing a compact config-derived line - no connection is made, so it can never hang a session start, and unconfigured machines stay silent.
Rerunning install repairs a moved binary path; `snowflake-axi hooks remove` withdraws the hook everywhere.

`skill/SKILL.md` is an installable [Agent Skill](https://agentskills.io) teaching agents the command surface upfront, so no discovery turns are spent on `--help`.
Copy it to your agent's skill directory (for Claude Code: `~/.claude/skills/snowflake-axi/SKILL.md`), optionally appending guidance for any private plugin commands.
It loads on demand with no per-session token cost, and works in any agent that supports the skill format.

## Plugins

Domain-specific commands load from `~/.config/snowflake-axi/plugins/*.mjs`, keeping private routing knowledge out of this repo.
Each plugin default-exports a factory:

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

- `sql(text, { binds, maxRows })` runs a statement on the shared read-only connection and returns `{ rows, total }`.
- `defineCommand(name, def)` builds a command declaratively: flags, positional arity, notes, and examples are declared once, and help text, validation, and flag errors are generated from them (this is how all core commands are built).
- `helpers` provides `parseFlags`/`intFlag` (fail-loud flag parsing), month-end date math, and money/percent formatting.
- Returned objects are rendered as TOON by the runtime; throw `AxiError(message, code, suggestions)` for structured errors.
- Plugins cannot shadow core commands; broken plugins are skipped with a warning on stderr.

## Development

```sh
npm install
npm run build            # tsc -> dist/
npm test                 # unit tests: validator, flags, dates, formatting, command logic (mocked SQL)
npm run test:integration # end-to-end: runs the built CLI as a subprocess against a real account
```

The integration suite works against **any Snowflake account**: it touches only universal objects (`GENERATOR` table functions, the shared `SNOWFLAKE` database, `INFORMATION_SCHEMA`, `SHOW`), needs no fixtures or write access, and skips the live tests automatically when no credentials are configured.
It covers what unit tests cannot: real SQL compilation, SQL API response shapes, partial fetches and total counts, error translation, and exit codes.

CI (`.github/workflows/ci.yml`) runs the build, the unit suite, and the credential-free half of the integration suite on Node 22 and 24.

`test-integration/docs.test.ts` is the doc drift guard: every `snowflake-axi` example in this README and in `skill/SKILL.md` runs against the built CLI without credentials, and an exit code of 2 (usage error) fails the build - so a renamed flag or removed command cannot leave stale docs behind.
It also asserts that every core command appears in the skill and that every flag the docs mention exists in a command's `--help`.

The command dispatch, TOON serialization, structured errors, and self-update come from [axi-sdk-js](https://www.npmjs.com/package/axi-sdk-js); this repo contains only Snowflake logic.

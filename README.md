# snowflake-axi

Read-only Snowflake explorer for coding agents, built on the [AXI principles](https://axi.md/): TOON output, minimal schemas, pre-computed aggregates, definitive empty states, fail-loud flags.
It replaces heavier MCP paths for read and discovery work: zero standing token cost (invoked via Bash on demand) and ~40% leaner output than JSON.
Statements run over the Snowflake SQL API with the PAT as a bearer token - one stateless HTTPS request, no driver, no login handshake - so a full query round trip completes in about half a second.

Status: functional, not yet published to npm.

## Usage

```sh
snowflake-axi                 # home view: connection context + databases
snowflake-axi tables          # tables in the default schema, largest first
snowflake-axi tables MY_DB    # schema summary for a database
snowflake-axi find flavor     # search tables/views by name across the account
snowflake-axi schema MY_TABLE # columns, types, row count, size
snowflake-axi sample MY_TABLE --limit 3 --fields COL_A,COL_B
snowflake-axi query "SELECT COUNT(*) FROM MY_TABLE"
snowflake-axi result 01b66701-0000-23c5-0000-45a100012345  # collect an earlier statement's output
snowflake-axi warehouses      # states + 7-day credit burn
snowflake-axi model my_model  # local dbt model SQL behind a table
snowflake-axi dbt             # dbt Projects on Snowflake, account-wide
snowflake-axi stage @DB.SCHEMA.STAGE
snowflake-axi allow           # write capabilities and their grant status
snowflake-axi <command> --help
```

Until published, install with `npm install && npm run build && npm link` from a checkout.

## Configuration

Credentials live in `~/.config/snowflake-axi/env` (process env overrides file values, never commit this file).
Three values are required:

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
  DEFAULT_SECONDARY_ROLES = ('ALL');  -- the tool can use every role granted to the user
```

With secondary roles set to ALL, granting and revoking Snowflake roles on the user is the single access control; the CLI needs no role configuration at all.

Optional overrides for setups that want them pinned client-side:

```
SNOWFLAKE_ROLE=<primary role per request>
SNOWFLAKE_DATABASE=<default database>
SNOWFLAKE_SCHEMA=<default schema>
SNOWFLAKE_AXI_MODEL_DIRS=<colon-separated dbt model dirs, used instead of discovery>
SNOWFLAKE_AXI_DEFAULT_FILE_FORMAT=<named file format, for the stage command>
```

The warehouse is never configured: statements run on the user's `DEFAULT_WAREHOUSE`, `query --warehouse <name>` switches one statement, and dbt executions use the warehouse pinned in the project's own profiles.

PAT auth requires a network policy attached to the Snowflake user; without one authentication fails with a network-policy error.

When a value is not provided by the process env or the env file, snowflake-axi falls back to the official snow CLI's connection configuration: `~/.snowflake/connections.toml`, or the `[connections]` table in `~/.snowflake/config.toml`.
The connection is selected the way snow selects it (`SNOWFLAKE_DEFAULT_CONNECTION_NAME`, then `default_connection_name` in config.toml, then `default`), and `SNOWFLAKE_HOME` relocates the directory.
Only PAT connections are usable: a `token` with `authenticator = "PROGRAMMATIC_ACCESS_TOKEN"`, or a `password` field that holds a PAT.
Real passwords do not work (statements run over the SQL API, which takes the PAT as a bearer token); browser, SSO, OAuth, and key-pair connections are ignored.
If you already use the snow CLI, snowflake-axi needs no configuration of its own.

## Read-only by default, writes by consent

Two independent layers keep everyday use read-only:

1. Run it as a service user whose role can only SELECT.
2. `query` validates SQL before any connection is made: single statement only, head keyword must be SELECT, WITH, SHOW, DESC, DESCRIBE, or EXPLAIN.

Write statements through `query` are rejected with the SQL echoed back so an operator can run it manually; arbitrary DML/DDL is permanently out of scope.

Specific write commands exist (currently `dbt execute`) but are disabled until the user opts in, MCP-style:

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
| `query <sql>` | One read-only statement; definitive total counts, 200-char cell truncation, `--full`, `--limit`, `--timeout` |
| `result <handle>` | Collect an earlier statement's output without re-running it (handles print to stderr when a query runs long) |
| `warehouses` | Warehouse states, 7-day credit burn, usage-guidance comments; `--full` |
| `model <name>` | dbt model SQL found by filename across `SNOWFLAKE_AXI_MODEL_DIRS` |
| `dbt` / `dbt describe <name>` | dbt Projects on Snowflake: account-wide list; versions, source, and integrations per project |
| `dbt execute <name>` | Run a dbt command in a deployed project; write, needs the `dbt.execute` grant |
| `stage <@stage>` / `stage read <@stage/file>` | List stage files; read staged records via a named file format |
| `allow [capability]` | List, grant (interactive terminal only), or revoke write capabilities |
| `update` | Self-update (built into axi-sdk-js) |

## Agent skill

`skill/SKILL.md` is an installable [Agent Skill](https://agentskills.io) teaching agents the command surface upfront, so no discovery turns are spent on `--help`.
Copy it to your agent's skill directory (for Claude Code: `~/.claude/skills/snowflake-axi/SKILL.md`), optionally appending guidance for any private plugin commands.

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

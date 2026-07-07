# snowflake-axi

Read-only Snowflake explorer for coding agents, built on the [AXI principles](https://axi.md/): TOON output, minimal schemas, pre-computed aggregates, definitive empty states, fail-loud flags.
It replaces heavier MCP paths for read and discovery work: zero standing token cost (invoked via Bash on demand) and ~40% leaner output than JSON.

Status: functional, not yet published to npm.

## Usage

```sh
snowflake-axi                 # home view: connection context + databases
snowflake-axi tables          # tables in the default schema, largest first
snowflake-axi tables MY_DB    # schema summary for a database
snowflake-axi schema MY_TABLE # columns, types, row count, size
snowflake-axi sample MY_TABLE --limit 3 --fields COL_A,COL_B
snowflake-axi query "SELECT COUNT(*) FROM MY_TABLE"
snowflake-axi warehouses      # states + 7-day credit burn
snowflake-axi model my_model  # dbt model SQL behind a table
snowflake-axi stage @DB.SCHEMA.STAGE
snowflake-axi <command> --help
```

Until published, install with `npm install && npm run build && npm link` from a checkout.

## Configuration

Credentials and defaults live in `~/.config/snowflake-axi/env` (process env overrides file values, never commit this file):

```
SNOWFLAKE_ACCOUNT=<account identifier>
SNOWFLAKE_USER=<service user>
SNOWFLAKE_TOKEN=<programmatic access token, used as password>
SNOWFLAKE_ROLE=<read-only role>
SNOWFLAKE_WAREHOUSE=<warehouse>
SNOWFLAKE_DATABASE=<default database>
SNOWFLAKE_SCHEMA=<default schema>
SNOWFLAKE_AXI_MODEL_DIRS=<colon-separated dbt model dirs, for the model command>
SNOWFLAKE_AXI_DEFAULT_FILE_FORMAT=<named file format, for the stage command>
```

PAT auth requires a network policy attached to the Snowflake user; without one authentication fails with a network-policy error.

## Read-only by construction

Two independent layers:

1. Run it as a service user whose role can only SELECT.
2. `query` validates SQL before any connection is made: single statement only, head keyword must be SELECT, WITH, SHOW, DESC, DESCRIBE, or EXPLAIN.

Write statements are rejected with the SQL echoed back so an operator can run it manually.
DML/DDL is permanently out of scope.

## Commands

| Command | Purpose |
|---|---|
| (no args) | Connection context, databases, next-step suggestions |
| `tables [db[.schema]]` | Tables with row counts and sizes (INFORMATION_SCHEMA, no scan); db scope lists schemas |
| `schema <table>` | Columns with types and nullability, plus row count and size |
| `sample <table>` | Preview rows; `--fields`, `--where`, `--limit`, `--full` |
| `query <sql>` | One read-only statement; definitive total counts, 200-char cell truncation, `--full`, `--limit`, `--timeout` |
| `warehouses` | Warehouse states, 7-day credit burn, usage-guidance comments |
| `model <name>` | dbt model SQL found by filename across `SNOWFLAKE_AXI_MODEL_DIRS` |
| `stage <@stage>` / `stage read <@stage/file>` | List stage files; read staged records via a named file format |
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
It covers what unit tests cannot: real SQL compilation, driver row shapes, result streaming and total counts, error translation, and exit codes.

The command dispatch, TOON serialization, structured errors, and self-update come from [axi-sdk-js](https://www.npmjs.com/package/axi-sdk-js); this repo contains only Snowflake logic.

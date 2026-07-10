---
name: snowflake-axi
description: >
  Read-only Snowflake access via the snowflake-axi CLI - list tables with row counts,
  search objects account-wide, inspect schemas, sample rows, run SELECT queries,
  discover semantic views with verified queries, check warehouse credit burn, read
  dbt model SQL, browse git repositories on Snowflake, and peek staged parquet files.
  Use for ANY Snowflake read or discovery task instead of an MCP tool or hand-rolled
  connector. Writes (dbt execute/deploy/drop, git fetch) exist but stay locked until
  the user grants them.
user-invocable: false
---

# snowflake-axi

Read-only Snowflake explorer, already on PATH.
TOON output; errors are structured on stdout with a `code` and `help[]` suggestions.
Exit codes: 0 success (including empty results), 1 error, 2 usage error.

Run commands directly - do NOT start with `--help` or the bare command; the examples below are the discovery step.

## Commands

```sh
snowflake-axi tables                        # default schema's tables, largest first, with row counts
snowflake-axi tables MY_DB                  # schema summary for a database
snowflake-axi tables MY_DB.MY_SCHEMA --like orders
snowflake-axi find flavor                   # search tables/views by name, account-wide
snowflake-axi semantics                     # semantic views: curated metric maps with verified queries
snowflake-axi semantics MY_SV --like revenue  # one view's matching metrics, conventions, blessed SQL
snowflake-axi schema MY_TABLE               # columns, types, row count, size
snowflake-axi sample MY_TABLE --limit 3 --fields COL_A,COL_B
snowflake-axi query "SELECT ..." --limit 50 # one read-only statement; total count always reported
snowflake-axi warehouses                    # states + 7-day credit burn + usage guidance
snowflake-axi model my_model                # local dbt model SQL behind a table
snowflake-axi dbt                           # dbt Projects on Snowflake, account-wide
snowflake-axi dbt describe MY_PROJECT       # versions, source, target, integrations
snowflake-axi dbt execute MY_PROJECT --args "build"   # write: locked until the user grants it
snowflake-axi dbt deploy MY_PROJECT --branch main     # write: create or version a project from git, locked until granted
snowflake-axi dbt drop MY_DB.MY_SCHEMA.MY_PROJECT     # write: drop a project and all versions, locked until granted
snowflake-axi git                           # git repositories on Snowflake, account-wide
snowflake-axi git branches MY_DB.MY_SCHEMA.MY_REPO    # branches with commit hashes
snowflake-axi git fetch MY_DB.MY_SCHEMA.MY_REPO       # write: refresh from origin, locked until granted
snowflake-axi stage @DB.SCHEMA.STAGE        # list stage files
snowflake-axi stage read @DB.SCHEMA.STAGE/file.parquet --limit 3
snowflake-axi allow                         # write capabilities and their grant status
snowflake-axi context                       # one-line config-derived context (what session hooks print)
snowflake-axi hooks                         # session-start hook status; install/remove via subcommands
```

- Unqualified table names resolve against the Snowflake user's default namespace;
  if the user has none, qualify names fully (`DB.SCHEMA.TABLE`) - `tables` with no
  arguments then lists readable databases to drill into.
- Structured commands take unquoted identifiers; a quoted lowercase or
  special-character name (`"my table"`) is only reachable through `query`.
- Before hand-writing SQL for metrics or KPIs, check `semantics`: semantic views carry
  the team's routing rules, metric definitions, and human-verified queries.
- `model` finds dbt models in projects around the working directory; run it from
  inside the dbt repo.
- `query` accepts only SELECT / WITH / SHOW / DESC / DESCRIBE / EXPLAIN, single statement.
  Write SQL is rejected; hand it to the operator as paste-ready SQL instead.
- Cells truncate at 200 chars; add `--full` when a hint says content was cut.
- A query that runs long prints a statement handle to stderr;
  `snowflake-axi result <handle>` collects its output later without re-running it.
- Prefer `--fields`, `--like`, `--limit`, and piping through `grep`/`head` to keep output small.
- Write commands are gated: on WRITE_NOT_ALLOWED, ask the user for permission in conversation.
  Only after they explicitly agree, run `snowflake-axi allow <capability> --agent`.
  Never grant without their approval, and never edit the grants file directly.

Domain plugins in `~/.config/snowflake-axi/plugins/` may add further commands;
run `snowflake-axi --help` to see the full surface when unsure.

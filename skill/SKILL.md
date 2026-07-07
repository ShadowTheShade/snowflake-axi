---
name: snowflake-axi
description: >
  Read-only Snowflake access via the snowflake-axi CLI - list tables with row counts,
  inspect schemas, sample rows, run SELECT queries, check warehouse credit burn, read
  dbt model SQL, and peek staged parquet files. Use for ANY Snowflake read or discovery
  task instead of an MCP tool or hand-rolled connector. Writes (dbt execute) exist but
  stay locked until the user grants them.
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
snowflake-axi schema MY_TABLE               # columns, types, row count, size
snowflake-axi sample MY_TABLE --limit 3 --fields COL_A,COL_B
snowflake-axi query "SELECT ..." --limit 50 # one read-only statement; total count always reported
snowflake-axi warehouses                    # states + 7-day credit burn + usage guidance
snowflake-axi model my_model                # local dbt model SQL behind a table
snowflake-axi dbt                           # dbt Projects on Snowflake, account-wide
snowflake-axi dbt describe MY_PROJECT       # versions, source, target, integrations
snowflake-axi dbt execute MY_PROJECT --args "build"   # write: locked until the user grants it
snowflake-axi stage @DB.SCHEMA.STAGE        # list stage files
snowflake-axi stage read @DB.SCHEMA.STAGE/file.parquet --limit 3
snowflake-axi allow                         # write capabilities and their grant status
```

- Unqualified table names resolve against the configured default database.schema.
- `query` accepts only SELECT / WITH / SHOW / DESC / DESCRIBE / EXPLAIN, single statement.
  Write SQL is rejected; hand it to the operator as paste-ready SQL instead.
- Cells truncate at 200 chars; add `--full` when a hint says content was cut.
- Prefer `--fields`, `--like`, `--limit`, and piping through `grep`/`head` to keep output small.
- Write commands are gated: on WRITE_NOT_ALLOWED, ask the user to run `snowflake-axi allow <capability>`
  in their own terminal. Never grant capabilities yourself or edit the grants file.

Domain plugins in `~/.config/snowflake-axi/plugins/` may add further commands;
run `snowflake-axi --help` to see the full surface when unsure.

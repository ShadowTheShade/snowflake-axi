---
name: snowflake-axi
description: >
  Read-only Snowflake access via the snowflake-axi CLI - list tables with row counts,
  search objects account-wide, inspect schemas, sample rows, run SELECT queries,
  discover semantic views with verified queries, check warehouse credit burn, read
  dbt model SQL, compile local dbt repos, browse git repositories on Snowflake,
  peek staged parquet files, explore Snowflake Postgres (pg tables/schema/sample/query,
  read-only), and run classic dbt-postgres against it (pg dbt). Use for ANY Snowflake or
  Snowflake Postgres read or discovery task instead of an MCP tool or hand-rolled connector.
  Writes (Snowflake writes through `query` via the sql.write grant, local dbt
  run/build/test/seed/snapshot, dbt execute/deploy/drop, git fetch, stage copy/unload via
  the stage.write grant, Postgres writes through `pg query` and write-verb `pg dbt` runs via
  the pg.write grant) exist but stay locked until the user grants them.
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
snowflake-axi query "SELECT ..." --limit 50 # one statement; reads free, a write needs the sql.write grant
snowflake-axi query "UPDATE <table> SET ..."          # write: refused until sql.write is granted
snowflake-axi warehouses                    # states + 7-day credit burn + usage guidance
snowflake-axi model my_model                # local dbt model SQL behind a table
snowflake-axi dbt                           # dbt Projects on Snowflake, account-wide
snowflake-axi dbt describe MY_PROJECT       # versions, source, target, integrations
snowflake-axi dbt ls --select +my_model     # list local nodes matching a selector, without running them
snowflake-axi dbt compile                   # compile the local dbt repo (cwd) against Snowflake
snowflake-axi dbt compiled my_model         # print my_model's compiled SQL from the last compile
snowflake-axi dbt state --target prod --into prod-artifacts   # stash prod manifest.json as a --defer reference
snowflake-axi dbt run --select my_model     # write: materialize local models (no tests), locked until granted
snowflake-axi dbt build --select my_model   # write: models + tests + seeds + snapshots, locked until granted
snowflake-axi dbt seed                      # write: load local CSV seeds, locked until granted
snowflake-axi dbt snapshot                  # write: run local snapshots, locked until granted
snowflake-axi dbt execute MY_PROJECT --args "build"   # write: locked until the user grants it
snowflake-axi dbt deploy MY_PROJECT --branch main     # write: create or version a project from git, locked until granted
snowflake-axi dbt drop MY_DB.MY_SCHEMA.MY_PROJECT     # write: drop a project and all versions, locked until granted
snowflake-axi git                           # git repositories on Snowflake, account-wide
snowflake-axi git branches MY_DB.MY_SCHEMA.MY_REPO    # branches with commit hashes
snowflake-axi git fetch MY_DB.MY_SCHEMA.MY_REPO       # write: refresh from origin, locked until granted
snowflake-axi stage @DB.SCHEMA.STAGE        # list stage files
snowflake-axi stage read @DB.SCHEMA.STAGE/file.parquet --limit 3
snowflake-axi stage copy @DB.S.SRC/x/ @DB.S.DST/dev/x/       # write: COPY FILES between stages, locked until stage.write granted
snowflake-axi stage unload FCT_ORDERS @DB.S.EXPORTS/orders/ --single --overwrite   # write: unload a table to a stage
snowflake-axi pg                            # Snowflake Postgres: every schema's tables, largest first
snowflake-axi pg tables public --like orders
snowflake-axi pg schema orders              # columns, types, defaults, primary key
snowflake-axi pg sample orders --limit 3 --fields id,status
snowflake-axi pg query "SELECT count(*) FROM orders"   # reads free (server read-only session)
snowflake-axi pg query "UPDATE <table> SET ..."        # write: refused until pg.write is granted
snowflake-axi pg dbt compile --select <selector>       # classic dbt-postgres (pinned 1.8), read verb, free
snowflake-axi pg dbt build --select <selector> --database <db>   # write: refused until pg.write is granted
snowflake-axi allow                         # write capabilities and their grant status
snowflake-axi login --role <role>           # browser SSO login via Snowflake OAuth (alternative to PAT auth)
snowflake-axi logout --role <role>          # remove an OAuth login from the token ring (--all for every login)
snowflake-axi role                          # show the active role every command runs as, and switchable roles
snowflake-axi role REPORTER                 # switch the active role (persists; `role default` reverts)
snowflake-axi role --grants                 # list every role granted to the user (live)
snowflake-axi auth                          # show the auth mode; `auth pat|oauth|default` switches (PAT is the default when configured)
snowflake-axi context                       # one-line config-derived context (what session hooks print)
snowflake-axi hooks                         # session-start hook status; install/remove via subcommands
snowflake-axi doctor                        # diagnose setup: credentials, reachability, warehouse/namespace, roles, pg
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
- `dbt compile/run/build/test/seed/snapshot` run the local dbt CLI on the repo in the
  working directory, injecting the tool's credentials into the repo's credential-less
  profiles.yml targets; pick the target with `--target` (a missing target fails loud
  and lists them). The write verbs all share the one dbt.build grant.
- `--select` takes dbt selector syntax: `+model_x` pulls ancestors, `model_x+` pulls
  descendants, and a union must be quoted into ONE value
  (`--select "model_x+ model_y+"`), never passed as extra arguments.
  Omit `--select` to run the whole project; `run` skips tests, `build` includes them.
- `--defer --state <dir>` is the slim build: build only the selected nodes and resolve
  unselected upstream `ref()`s to the `manifest.json` in `<dir>` (a prior/production run)
  instead of rebuilding the DAG. `--favor-state` prefers that manifest even when the node
  also exists in the target (implies `--defer`); `--state` alone enables `state:` selectors
  like `--select state:modified+`. A missing dir or manifest.json fails loud before dbt runs.
- `dbt state --target prod --into <dir>` builds that reference in one step (compile whole
  project + copy fresh manifest.json into `<dir>`). `dbt ls` scopes a build without running
  it. On `run`/`build`, `--empty` materializes with `LIMIT 0` - validates SQL and schema at
  near-zero cost. `dbt compiled <model>` prints compiled SQL without hunting target/compiled.
- `query` runs one statement. Reads (SELECT / WITH / SHOW / DESC / DESCRIBE / EXPLAIN) are free;
  anything else is a write, refused with WRITE_NOT_ALLOWED until the user grants sql.write, then run
  (the token's role stays the hard boundary). A write reports Snowflake's count/status row.
- `role <name>` sets a persisted active role that every command runs as by default, so `schema`,
  `tables`, `query`, and the rest need no per-command `--role`; `role` alone shows it, `role default`
  reverts, and `role --grants` lists roles the user could log in as. In OAuth mode a role is only
  switchable once it has a login (`login --role <name>`). `--role` on a command still overrides it once,
  and `SNOWFLAKE_ROLE=<name>` in the process env pins one session, outranking the persisted active role
  (which is shared machine state across concurrent sessions).
- `pg` speaks to Snowflake Postgres directly (SNOWFLAKE_AXI_PG_* keys). `pg query` runs one
  statement: reads (SELECT / WITH / TABLE / VALUES / SHOW / EXPLAIN) run on a server read-only
  session for free; anything else is a write, refused until the user grants pg.write, then run on a
  read-write session (reporting the command tag, affected count, and any RETURNING rows). Table names
  resolve case-insensitively as `table` or `schema.table`; row counts there are planner estimates.
- A SELECT/WITH that actually writes - calls a VOLATILE function doing INSERT/TRUNCATE, or wraps a
  data-modifying CTE - reads by prefix and fails on the read-only session. Pass `--write` to run it on
  the read-write session (needs pg.write); it then reports as a write. Plain reads stay read-only.
- Cells truncate at 200 chars; add `--full` when a hint says content was cut.
- A query that runs long prints a statement handle to stderr;
  `snowflake-axi result <handle>` collects its output later without re-running it.
- Prefer `--fields`, `--like`, `--limit`, and piping through `grep`/`head` to keep output small.
- Write commands are gated: on WRITE_NOT_ALLOWED, ask the user for permission in conversation.
  Only after they explicitly agree, run `snowflake-axi allow <capability> --agent`.
  Never grant without their approval, and never edit the grants file directly.

Domain plugins in `~/.config/snowflake-axi/plugins/` may add further commands;
run `snowflake-axi --help` to see the full surface when unsure.

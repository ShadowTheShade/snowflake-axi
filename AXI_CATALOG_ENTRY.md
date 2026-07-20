# AXI catalog entry

Ready-to-submit entry for the AXI community catalog (<https://github.com/kunchenguid/axi>), per its `CONTRIBUTING.md`.
Community tools are *listed*, not vendored, so this repo stays standalone; only a single entry is added upstream.

Add this block to the `community` list in `catalog.yaml`:

```yaml
  - name: snowflake-axi
    url: https://github.com/ShadowTheShade/snowflake-axi
    author: ShadowTheShade
    domain: Snowflake
    description: "Read-first Snowflake explorer - tables, schemas, SELECT, semantic views, dbt, and Snowflake Postgres in TOON; writes by consent."
```

## Submitting

1. Fork and clone `github.com/kunchenguid/axi`; create a feature branch.
2. Add the block above to the `community` list in `catalog.yaml`. Do not edit any `generated:` region.
3. Regenerate the docs: `pnpm install --frozen-lockfile && pnpm run docs:gen`.
4. Commit every changed file with a conventional message: `docs: add snowflake-axi to community catalog`.
5. Push through the required gate: `no-mistakes init --fork-url git@github.com:<you>/axi.git`, then `git push no-mistakes`. It runs the review/test/build pipeline and opens the PR once green.

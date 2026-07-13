import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { configDir } from "./config.js";

/**
 * Write commands are opt-in per capability, MCP-style: a human grants them
 * with `snowflake-axi allow` in an interactive terminal, and until then the
 * commands fail loud with instructions to ask the user. The grants file is a
 * consent mechanism, not a security boundary; the Snowflake role remains the
 * hard limit on what the token can do.
 */
export const WRITE_CAPABILITIES: Record<string, { description: string; unlocks: string }> = {
  "dbt.build": {
    description: "Run local dbt writes against Snowflake: run, build, test, seed, snapshot (spawns the local dbt CLI)",
    unlocks: "snowflake-axi dbt build --select <model>",
  },
  "dbt.execute": {
    description: "Run a deployed dbt project on Snowflake (EXECUTE DBT PROJECT)",
    unlocks: 'snowflake-axi dbt execute <name> --args "build"',
  },
  "dbt.deploy": {
    description: "Cut a new dbt project version from its git repository (ALTER DBT PROJECT ADD VERSION)",
    unlocks: "snowflake-axi dbt deploy <name> --branch main",
  },
  "dbt.drop": {
    description: "Drop a dbt project and all its versions (DROP DBT PROJECT)",
    unlocks: "snowflake-axi dbt drop <db.schema.name>",
  },
  "git.fetch": {
    description: "Refresh a git repository from its origin (ALTER GIT REPOSITORY FETCH)",
    unlocks: "snowflake-axi git fetch <db.schema.repo>",
  },
  "sql.write": {
    description:
      "Run write statements through `query` over the Snowflake SQL API (anything that is not a SELECT/WITH/SHOW/DESC/EXPLAIN read); the role stays the hard boundary",
    unlocks: 'snowflake-axi query "UPDATE <table> SET ..."',
  },
  "pg.write": {
    description:
      "Run write statements through `pg query` against Snowflake Postgres (anything that is not a SELECT/WITH/TABLE/VALUES/SHOW/EXPLAIN read); the role stays the hard boundary",
    unlocks: 'snowflake-axi pg query "UPDATE <table> SET ..."',
  },
};

const HEADER = "# Write capabilities granted to snowflake-axi (managed by `snowflake-axi allow`)";

export function grantsFilePath(): string {
  return join(configDir(), "grants");
}

export function readGrants(): Set<string> {
  let text: string;
  try {
    text = readFileSync(grantsFilePath(), "utf8");
  } catch {
    return new Set();
  }
  return new Set(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
}

export function writeGrants(grants: Set<string>): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(grantsFilePath(), `${[HEADER, ...[...grants].sort()].join("\n")}\n`);
}

export function requireGrant(capability: string): void {
  if (readGrants().has(capability)) return;
  throw new AxiError(`Write capability '${capability}' is not granted`, "WRITE_NOT_ALLOWED", [
    `Ask the user for permission in conversation; once they agree, run \`snowflake-axi allow ${capability} --agent\``,
    `Or the user runs \`snowflake-axi allow ${capability}\` in their own terminal`,
    "Never grant without the user's explicit approval",
  ]);
}

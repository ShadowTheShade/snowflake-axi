import { AxiError } from "axi-sdk-js";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { loadConfig } from "../config.js";
import { parseFlags } from "../flags.js";
import type { CommandSpec } from "../command.js";

const FLAGS = { "--full": { takesValue: false } };
const SQL_LIMIT = 1500;

interface ModelFile {
  name: string;
  path: string;
}

function collapseHome(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function listModels(dirs: string[]): ModelFile[] {
  const models: ModelFile[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir, { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".sql")) {
        models.push({ name: basename(entry, ".sql"), path: join(dir, entry) });
      }
    }
  }
  return models;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]++;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = current;
    }
  }
  return row[b.length];
}

async function run(args: string[]): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseFlags("model", args, FLAGS);
  if (positionals.length !== 1) {
    throw new AxiError("model takes exactly one model name", "VALIDATION_ERROR", [
      "Run `snowflake-axi model <name>` (dbt model filename, fuzzy contains match)",
    ]);
  }
  const config = loadConfig();
  if (config.modelDirs.length === 0) {
    throw new AxiError("No model directories configured", "CONFIG_ERROR", [
      "Set SNOWFLAKE_AXI_MODEL_DIRS in the env file (colon-separated dbt model dirs)",
    ]);
  }

  const query = positionals[0].toLowerCase().replace(/\.sql$/, "");
  const models = listModels(config.modelDirs);
  const exact = models.filter((m) => m.name.toLowerCase() === query);
  const matches = exact.length > 0 ? exact : models.filter((m) => m.name.toLowerCase().includes(query));

  if (matches.length === 0) {
    const nearest = models
      .map((m) => ({ m, distance: editDistance(query, m.name.toLowerCase()) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3);
    return {
      count: `0 models match '${query}' in ${config.modelDirs.map(collapseHome).join(", ")}`,
      ...(nearest.length > 0
        ? { help: nearest.map(({ m }) => `Did you mean: snowflake-axi model ${m.name}`) }
        : {}),
    };
  }
  if (matches.length > 1) {
    return {
      count: `${matches.length} models match '${query}'`,
      matches: matches.map((m) => ({ name: m.name, path: collapseHome(m.path) })),
      help: ["Run `snowflake-axi model <name>` with the exact name"],
    };
  }

  const match = matches[0];
  const sql = readFileSync(match.path, "utf8");
  const full = flags["--full"] === true;
  const truncated = !full && sql.length > SQL_LIMIT;
  return {
    model: match.name,
    path: collapseHome(match.path),
    sql: truncated ? `${sql.slice(0, SQL_LIMIT)}\n... (truncated, ${sql.length} chars total)` : sql,
    ...(truncated ? { help: [`Run \`snowflake-axi model ${match.name} --full\` for the complete SQL`] } : {}),
  };
}

export const modelCommand: CommandSpec = {
  summary: "Show the dbt model SQL behind a table",
  help: `command: model
description: Find a dbt model by filename across the configured model directories and show its SQL
usage: snowflake-axi model <name> [flags]
flags:
  --full: show the complete SQL (default truncates at ${SQL_LIMIT} chars)
notes:
  Matching is case-insensitive: exact filename first, then contains.
  Directories come from SNOWFLAKE_AXI_MODEL_DIRS in the env file.
examples:
  snowflake-axi model stg_orders
  snowflake-axi model fct_revenue --full
`,
  run,
};

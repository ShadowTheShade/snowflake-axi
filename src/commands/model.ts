import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { type CommandArgs, defineCommand } from "../command.js";
import { loadConfig } from "../config.js";

const SQL_LIMIT = 1500;
const DISCOVERY_DEPTH = 3;
const SKIPPED_DIRS = new Set(["node_modules", "target", "dbt_packages", "venv", ".venv", "dist"]);

interface ModelFile {
  name: string;
  path: string;
}

function collapseHome(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

// dbt_project.yml is YAML, but model-paths is virtually always either the
// inline-list or block-list form; a full YAML parser is not worth a dependency.
function modelPaths(projectFile: string): string[] {
  let yml: string;
  try {
    yml = readFileSync(projectFile, "utf8");
  } catch {
    return ["models"];
  }
  const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, "");
  const inline = yml.match(/^model-paths\s*:\s*\[([^\]]*)\]/m);
  if (inline) {
    const paths = inline[1].split(",").map(unquote).filter(Boolean);
    if (paths.length > 0) return paths;
  }
  const block = yml.match(/^model-paths\s*:\s*\r?\n((?:[ \t]+-[^\n]*\r?\n?)+)/m);
  if (block) {
    const paths = block[1]
      .split("\n")
      .map((line) => unquote(line.replace(/^[ \t]+-/, "")))
      .filter(Boolean);
    if (paths.length > 0) return paths;
  }
  return ["models"];
}

/** dbt projects at or above cwd, plus a shallow scan below it. */
function discoverProjectFiles(start: string): string[] {
  const found: string[] = [];
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = join(dir, "dbt_project.yml");
    if (existsSync(candidate)) found.push(candidate);
    if (dir === dirname(dir) || dir === homedir()) break;
  }
  let level = [start];
  for (let depth = 0; depth < DISCOVERY_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue;
        const child = join(dir, entry.name);
        const candidate = join(child, "dbt_project.yml");
        if (existsSync(candidate)) found.push(candidate);
        else next.push(child);
      }
    }
    level = next;
  }
  return [...new Set(found)];
}

/** Model directories of every dbt project discovered around `start`. */
export function discoverModelDirs(start: string): string[] {
  return discoverProjectFiles(start).flatMap((projectFile) =>
    modelPaths(projectFile).map((path) => join(dirname(projectFile), path)),
  );
}

function modelDirs(): string[] {
  const config = loadConfig();
  if (config.modelDirs.length > 0) return config.modelDirs;
  return discoverModelDirs(process.cwd());
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

async function run(args: CommandArgs): Promise<Record<string, unknown>> {
  const dirs = modelDirs();
  if (dirs.length === 0) {
    throw new AxiError(`No dbt project found around ${collapseHome(process.cwd())}`, "NOT_FOUND", [
      "Run from inside a dbt repo (dbt_project.yml is discovered upward and a few levels down)",
      "Or pin directories with SNOWFLAKE_AXI_MODEL_DIRS in the env file (colon-separated)",
    ]);
  }

  const query = args.positionals[0].toLowerCase().replace(/\.sql$/, "");
  const models = listModels(dirs);
  const exact = models.filter((m) => m.name.toLowerCase() === query);
  const matches = exact.length > 0 ? exact : models.filter((m) => m.name.toLowerCase().includes(query));

  if (matches.length === 0) {
    const nearest = models
      .map((m) => ({ m, distance: editDistance(query, m.name.toLowerCase()) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3);
    return {
      count: `0 models match '${query}' in ${dirs.map(collapseHome).join(", ")}`,
      ...(nearest.length > 0 ? { help: nearest.map(({ m }) => `Did you mean: snowflake-axi model ${m.name}`) } : {}),
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
  const full = args.bool("--full");
  const truncated = !full && sql.length > SQL_LIMIT;
  return {
    model: match.name,
    path: collapseHome(match.path),
    sql: truncated ? `${sql.slice(0, SQL_LIMIT)}\n... (truncated, ${sql.length} chars total)` : sql,
    ...(truncated ? { help: [`Run \`snowflake-axi model ${match.name} --full\` for the complete SQL`] } : {}),
  };
}

export const modelCommand = defineCommand("model", {
  summary: "Show the dbt model SQL behind a table",
  action: {
    description: "Find a dbt model by filename across discovered dbt projects and show its SQL",
    positionals: { usage: "<name>", min: 1, max: 1 },
    flags: {
      "--full": { type: "boolean", description: `show the complete SQL (default truncates at ${SQL_LIMIT} chars)` },
    },
    notes: [
      "Matching is case-insensitive: exact filename first, then contains.",
      "dbt projects are discovered from the working directory (dbt_project.yml upward and a few levels down); SNOWFLAKE_AXI_MODEL_DIRS overrides.",
    ],
    examples: ["snowflake-axi model stg_orders", "snowflake-axi model fct_revenue --full"],
    run,
  },
});

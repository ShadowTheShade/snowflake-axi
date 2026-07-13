import { readFileSync } from "node:fs";
import { runAxiCli } from "axi-sdk-js";
import type { CommandSpec } from "./command.js";
import { allowCommand } from "./commands/allow.js";
import { contextCommand } from "./commands/context.js";
import { dbtCommand } from "./commands/dbt.js";
import { findCommand } from "./commands/find.js";
import { gitCommand } from "./commands/git.js";
import { homeView } from "./commands/home.js";
import { hooksCommand } from "./commands/hooks.js";
import { loginCommand } from "./commands/login.js";
import { modelCommand } from "./commands/model.js";
import { pgCommand } from "./commands/pg.js";
import { queryCommand } from "./commands/query.js";
import { resultCommand } from "./commands/result.js";
import { sampleCommand } from "./commands/sample.js";
import { schemaCommand } from "./commands/schema.js";
import { semanticsCommand } from "./commands/semantics.js";
import { stageCommand } from "./commands/stage.js";
import { tablesCommand } from "./commands/tables.js";
import { warehousesCommand } from "./commands/warehouses.js";
import { envFilePath } from "./config.js";
import { loadPlugins } from "./plugins.js";

const DESCRIPTION = "Read-only Snowflake explorer for agents; TOON output, SELECT-only";

export const CORE_COMMANDS: Record<string, CommandSpec> = {
  tables: tablesCommand,
  find: findCommand,
  schema: schemaCommand,
  sample: sampleCommand,
  query: queryCommand,
  result: resultCommand,
  semantics: semanticsCommand,
  warehouses: warehousesCommand,
  model: modelCommand,
  dbt: dbtCommand,
  git: gitCommand,
  stage: stageCommand,
  pg: pgCommand,
  login: loginCommand,
  allow: allowCommand,
  context: contextCommand,
  hooks: hooksCommand,
};

function topLevelHelp(specs: Record<string, CommandSpec>): string {
  const width = Math.max(...Object.keys(specs).map((name) => name.length));
  const lines = Object.entries(specs)
    .map(([name, spec]) => `  ${name.padEnd(width)}  ${spec.summary}`)
    .join("\n");
  return `snowflake-axi - ${DESCRIPTION}

usage: snowflake-axi <command> [args] [flags]

commands:
${lines}

config: ${envFilePath()} (SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_TOKEN, ...)
Run \`snowflake-axi <command> --help\` for flags and examples.
`;
}

export async function main(argv?: string[]): Promise<void> {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  const plugins = await loadPlugins(new Set(Object.keys(CORE_COMMANDS)));
  const specs = { ...CORE_COMMANDS, ...plugins.commands };
  const commands = Object.fromEntries(
    Object.entries(specs).map(([name, spec]) => [name, (args: string[]) => spec.run(args)]),
  );
  await runAxiCli({
    description: DESCRIPTION,
    version: pkg.version,
    argv,
    topLevelHelp: topLevelHelp(specs),
    getCommandHelp: (command) => specs[command]?.help,
    home: () => homeView(plugins.homeHelp),
    commands,
  });
}

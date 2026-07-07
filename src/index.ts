import { readFileSync } from "node:fs";
import { runAxiCli } from "axi-sdk-js";
import type { CommandSpec } from "./command.js";
import { dbtCommand } from "./commands/dbt.js";
import { homeView } from "./commands/home.js";
import { modelCommand } from "./commands/model.js";
import { queryCommand } from "./commands/query.js";
import { sampleCommand } from "./commands/sample.js";
import { schemaCommand } from "./commands/schema.js";
import { stageCommand } from "./commands/stage.js";
import { tablesCommand } from "./commands/tables.js";
import { warehousesCommand } from "./commands/warehouses.js";
import { envFilePath } from "./config.js";
import { loadPlugins } from "./plugins.js";
import { closeConnection } from "./snowflake.js";

const DESCRIPTION = "Read-only Snowflake explorer for agents; TOON output, SELECT-only";

export const CORE_COMMANDS: Record<string, CommandSpec> = {
  tables: tablesCommand,
  schema: schemaCommand,
  sample: sampleCommand,
  query: queryCommand,
  warehouses: warehousesCommand,
  model: modelCommand,
  dbt: dbtCommand,
  stage: stageCommand,
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

export async function main(): Promise<void> {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  const plugins = await loadPlugins(new Set(Object.keys(CORE_COMMANDS)));
  const specs = { ...CORE_COMMANDS, ...plugins.commands };
  const commands = Object.fromEntries(
    Object.entries(specs).map(([name, spec]) => [name, (args: string[]) => spec.run(args)]),
  );
  try {
    await runAxiCli({
      description: DESCRIPTION,
      version: pkg.version,
      topLevelHelp: topLevelHelp(specs),
      getCommandHelp: (command) => specs[command]?.help,
      home: () => homeView(plugins.homeHelp),
      commands,
    });
  } finally {
    await closeConnection();
  }
}

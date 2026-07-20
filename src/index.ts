import { readFileSync } from "node:fs";
import { encode } from "@toon-format/toon";
import { runAxiCli } from "axi-sdk-js";
import { type CommandSpec, nearestVerb } from "./command.js";
import { allowCommand } from "./commands/allow.js";
import { authCommand } from "./commands/auth.js";
import { contextCommand } from "./commands/context.js";
import { dbtCommand } from "./commands/dbt.js";
import { doctorCommand } from "./commands/doctor.js";
import { findCommand } from "./commands/find.js";
import { gitCommand } from "./commands/git.js";
import { homeView } from "./commands/home.js";
import { hooksCommand } from "./commands/hooks.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { modelCommand } from "./commands/model.js";
import { pgCommand } from "./commands/pg.js";
import { queryCommand } from "./commands/query.js";
import { resultCommand } from "./commands/result.js";
import { roleCommand } from "./commands/role.js";
import { sampleCommand } from "./commands/sample.js";
import { schemaCommand } from "./commands/schema.js";
import { semanticsCommand } from "./commands/semantics.js";
import { stageCommand } from "./commands/stage.js";
import { tablesCommand } from "./commands/tables.js";
import { warehousesCommand } from "./commands/warehouses.js";
import { envFilePath } from "./config.js";
import { loadPlugins } from "./plugins.js";

const DESCRIPTION = "Snowflake explorer for agents; TOON output, reads free, writes by consent";

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
  logout: logoutCommand,
  auth: authCommand,
  role: roleCommand,
  allow: allowCommand,
  doctor: doctorCommand,
  context: contextCommand,
  hooks: hooksCommand,
};

/**
 * The SDK default suggests a bare `Run \`--help\``, which is not a runnable
 * command; make the error self-correcting in one turn instead - a did-you-mean
 * for near misses plus the valid command names inline.
 */
function renderUnknownCommand(command: string, specs: Record<string, CommandSpec>): string {
  const near = nearestVerb(command, Object.keys(specs));
  return `${encode({
    error: `Unknown command: ${command}`,
    code: "VALIDATION_ERROR",
    help: [
      ...(near === undefined ? [] : [`Did you mean \`snowflake-axi ${near}\`?`]),
      `Commands: ${Object.keys(specs).join(", ")}`,
      "Run `snowflake-axi --help` for a summary of each",
    ],
  })}\n`;
}

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
    // Compiled specs answer --help inside run() (scoped to the requested
    // subcommand); the SDK intercept only serves hand-written plugin specs.
    getCommandHelp: (command) => {
      const spec = specs[command];
      return spec !== undefined && spec.handlesHelp !== true ? spec.help : undefined;
    },
    home: () => homeView(plugins.homeHelp),
    renderUnknownCommand: (command) => renderUnknownCommand(command, specs),
    commands,
  });
}

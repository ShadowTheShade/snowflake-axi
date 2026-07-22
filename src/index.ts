import { readFileSync } from "node:fs";
import { encode } from "@toon-format/toon";
import { AxiError, exitCodeForError, runAxiCli } from "axi-sdk-js";
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
function unknownCommandOutput(command: string, specs: Record<string, CommandSpec>): Record<string, unknown> {
  const near = nearestVerb(command, Object.keys(specs));
  return {
    error: `Unknown command: ${command}`,
    code: "VALIDATION_ERROR",
    help: [
      ...(near === undefined ? [] : [`Did you mean \`snowflake-axi ${near}\`?`]),
      `Commands: ${Object.keys(specs).join(", ")}`,
      "Run `snowflake-axi --help` for a summary of each",
    ],
  };
}

// The global --json switch renders every result and error as JSON instead of
// TOON, so an agent can pipe output into a parser rather than grep a listing.
// It is stripped from argv before command parsing, so no command sees it.
const JSON_FLAG = "--json";

/** Shapes an error as the {error, code, help} object both renderers share. */
function errorObject(error: unknown): Record<string, unknown> {
  const axi = error instanceof AxiError ? error : undefined;
  const message = axi?.message ?? (error instanceof Error ? error.message : String(error));
  const suggestions = axi?.suggestions ?? [];
  return {
    error: message,
    code: axi?.code ?? "UNKNOWN",
    ...(suggestions.length > 0 ? { help: suggestions } : {}),
  };
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
Global: append \`--json\` to any command to render its result (and errors) as JSON instead of TOON.
`;
}

export async function main(argv?: string[]): Promise<void> {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  const rawArgv = argv ?? process.argv.slice(2);
  const json = rawArgv.includes(JSON_FLAG);
  const cliArgv = json ? rawArgv.filter((arg) => arg !== JSON_FLAG) : rawArgv;

  const plugins = await loadPlugins(new Set(Object.keys(CORE_COMMANDS)));
  const specs = { ...CORE_COMMANDS, ...plugins.commands };
  // In JSON mode a command's structured result is stringified; a string result
  // (help text, the home header) passes through untouched, since renderOutput
  // returns strings verbatim.
  const commands = Object.fromEntries(
    Object.entries(specs).map(([name, spec]) => [
      name,
      async (args: string[]) => {
        const output = await spec.run(args);
        return json && typeof output !== "string" ? JSON.stringify(output, null, 2) : output;
      },
    ]),
  );
  await runAxiCli({
    description: DESCRIPTION,
    version: pkg.version,
    argv: cliArgv,
    topLevelHelp: topLevelHelp(specs),
    // Compiled specs answer --help inside run() (scoped to the requested
    // subcommand); the SDK intercept only serves hand-written plugin specs.
    getCommandHelp: (command) => {
      const spec = specs[command];
      return spec !== undefined && spec.handlesHelp !== true ? spec.help : undefined;
    },
    home: () => homeView(plugins.homeHelp),
    renderUnknownCommand: (command) => {
      const output = unknownCommandOutput(command, specs);
      return `${json ? JSON.stringify(output, null, 2) : encode(output)}\n`;
    },
    ...(json
      ? {
          formatError: (error: unknown) => ({
            output: `${JSON.stringify(errorObject(error), null, 2)}\n`,
            exitCode: exitCodeForError(error),
          }),
        }
      : {}),
    commands,
  });
}

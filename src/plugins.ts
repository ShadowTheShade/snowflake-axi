import { AxiError } from "axi-sdk-js";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { configDir, loadConfig } from "./config.js";
import { addMonthsEnd, lastCompletedMonthEnd, monthEnd } from "./dates.js";
import { intFlag, parseFlags } from "./flags.js";
import { money, pct, shapeRows } from "./format.js";
import { runQuery } from "./snowflake.js";
import type { CommandSpec } from "./command.js";

export interface PluginApi {
  sql: typeof runQuery;
  config: typeof loadConfig;
  AxiError: typeof AxiError;
  helpers: {
    parseFlags: typeof parseFlags;
    intFlag: typeof intFlag;
    monthEnd: typeof monthEnd;
    addMonthsEnd: typeof addMonthsEnd;
    lastCompletedMonthEnd: typeof lastCompletedMonthEnd;
    money: typeof money;
    pct: typeof pct;
    shapeRows: typeof shapeRows;
  };
}

export interface PluginModule {
  commands?: Record<string, CommandSpec>;
  homeHelp?: string[];
}

export interface LoadedPlugins {
  commands: Record<string, CommandSpec>;
  homeHelp: string[];
}

const api: PluginApi = {
  sql: runQuery,
  config: loadConfig,
  AxiError,
  helpers: { parseFlags, intFlag, monthEnd, addMonthsEnd, lastCompletedMonthEnd, money, pct, shapeRows },
};

export async function loadPlugins(coreCommands: Set<string>): Promise<LoadedPlugins> {
  const dir = join(configDir(), "plugins");
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".mjs"))
      .sort();
  } catch {
    return { commands: {}, homeHelp: [] };
  }

  const commands: Record<string, CommandSpec> = {};
  const homeHelp: string[] = [];
  for (const file of files) {
    const path = join(dir, file);
    try {
      const module = await import(pathToFileURL(path).href);
      const plugin: PluginModule = await module.default(api);
      for (const [name, spec] of Object.entries(plugin.commands ?? {})) {
        if (coreCommands.has(name) || commands[name]) {
          process.stderr.write(`snowflake-axi: plugin ${file} skipped duplicate command '${name}'\n`);
          continue;
        }
        commands[name] = spec;
      }
      homeHelp.push(...(plugin.homeHelp ?? []));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`snowflake-axi: failed to load plugin ${file}: ${message}\n`);
    }
  }
  return { commands, homeHelp };
}

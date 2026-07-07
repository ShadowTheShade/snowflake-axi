import { AxiError } from "axi-sdk-js";
import { type FlagSpec, intFlag, parseFlags } from "./flags.js";

export type CommandOutput = string | Record<string, unknown>;

/**
 * The runtime shape the CLI (and plugins) work with. Core commands never
 * hand-write it; they declare a CommandDef and defineCommand compiles it,
 * so flags, help text, and validation cannot drift apart.
 */
export interface CommandSpec {
  summary: string;
  help: string;
  run: (args: string[]) => Promise<CommandOutput> | CommandOutput;
}

export type FlagDef =
  | { type: "boolean"; description: string }
  | { type: "string"; placeholder: string; description: string }
  | { type: "int"; placeholder: string; description: string; default: number; min: number; max: number };

export interface PositionalsDef {
  usage: string;
  min: number;
  max: number;
}

/** Parsed, validated arguments handed to an action's run. */
export interface CommandArgs {
  positionals: string[];
  str(name: string): string | undefined;
  int(name: string): number;
  bool(name: string): boolean;
}

export interface ActionDef {
  description: string;
  /** Omitted means the action takes no positional arguments. */
  positionals?: PositionalsDef;
  flags?: Record<string, FlagDef>;
  notes?: string[];
  examples?: string[];
  run(args: CommandArgs): Promise<CommandOutput> | CommandOutput;
}

export interface CommandDef {
  summary: string;
  /** Group description; defaults to the single action's description, then the summary. */
  description?: string;
  action?: ActionDef;
  subcommands?: Record<string, ActionDef>;
  /** Subcommand used when the first argument is not a subcommand name. */
  defaultSubcommand?: string;
}

function flagUsage(name: string, def: FlagDef): string {
  return def.type === "boolean" ? name : `${name} ${def.placeholder}`;
}

function flagLine(name: string, def: FlagDef): string {
  const suffix = def.type === "int" ? ` (default ${def.default}, max ${def.max})` : "";
  return `${flagUsage(name, def)}: ${def.description}${suffix}`;
}

function usageLine(displayName: string, action: ActionDef): string {
  const parts = [`snowflake-axi ${displayName}`];
  if (action.positionals) parts.push(action.positionals.usage);
  if (action.flags && Object.keys(action.flags).length > 0) parts.push("[flags]");
  return parts.join(" ");
}

function checkArity(displayName: string, action: ActionDef, count: number): void {
  const bounds = action.positionals ?? { usage: "", min: 0, max: 0 };
  if (count >= bounds.min && count <= bounds.max) return;
  const message =
    bounds.max === 0
      ? `${displayName} takes no arguments`
      : bounds.min === bounds.max
        ? `${displayName} takes exactly ${bounds.min === 1 ? "one argument" : `${bounds.min} arguments`}: ${bounds.usage}`
        : count < bounds.min
          ? `${displayName} takes at least ${bounds.min} argument(s): ${bounds.usage}`
          : `${displayName} takes at most ${bounds.max} argument(s): ${bounds.usage}`;
  throw new AxiError(message, "VALIDATION_ERROR", [`Run \`${usageLine(displayName, action)}\``]);
}

function parseActionArgs(displayName: string, action: ActionDef, argv: string[]): CommandArgs {
  const defs = action.flags ?? {};
  const known: Record<string, FlagSpec> = {};
  for (const [name, def] of Object.entries(defs)) {
    known[name] = { takesValue: def.type !== "boolean", help: flagLine(name, def) };
  }
  const { positionals, flags } = parseFlags(displayName, argv, known);
  checkArity(displayName, action, positionals.length);
  return {
    positionals,
    str: (name) => {
      const value = flags[name];
      return typeof value === "string" ? value : undefined;
    },
    bool: (name) => flags[name] === true,
    int: (name) => {
      const def = defs[name];
      if (def?.type !== "int") throw new Error(`${displayName} declares no int flag ${name}`);
      return intFlag(flags, name, { fallback: def.default, min: def.min, max: def.max });
    },
  };
}

interface ResolvedAction {
  displayName: string;
  action: ActionDef;
  rest: string[];
}

function resolveAction(name: string, def: CommandDef, argv: string[]): ResolvedAction {
  if (def.action) return { displayName: name, action: def.action, rest: argv };
  const subs = def.subcommands ?? {};
  const verb = argv[0];
  if (verb !== undefined && Object.hasOwn(subs, verb)) {
    return { displayName: `${name} ${verb}`, action: subs[verb], rest: argv.slice(1) };
  }
  const fallback = def.defaultSubcommand === undefined ? undefined : subs[def.defaultSubcommand];
  if (!fallback) {
    throw new AxiError(`Unknown ${name} subcommand '${verb ?? ""}'`, "VALIDATION_ERROR", [
      `Valid subcommands: ${Object.keys(subs).join(", ")}`,
    ]);
  }
  return { displayName: name, action: fallback, rest: argv };
}

function orderedActions(name: string, def: CommandDef): Array<{ displayName: string; action: ActionDef }> {
  if (def.action) return [{ displayName: name, action: def.action }];
  const subs = def.subcommands ?? {};
  const verbs = Object.keys(subs).sort((a, b) =>
    a === def.defaultSubcommand ? -1 : b === def.defaultSubcommand ? 1 : 0,
  );
  return verbs.map((verb) => ({
    displayName: verb === def.defaultSubcommand ? name : `${name} ${verb}`,
    action: subs[verb],
  }));
}

function renderHelp(name: string, def: CommandDef): string {
  const actions = orderedActions(name, def);
  const lines = [`command: ${name}`, `description: ${def.description ?? def.action?.description ?? def.summary}`];
  if (actions.length === 1) {
    lines.push(`usage: ${usageLine(actions[0].displayName, actions[0].action)}`);
  } else {
    lines.push("usage:");
    for (const { displayName, action } of actions) lines.push(`  ${usageLine(displayName, action)}`);
  }
  for (const { displayName, action } of actions) {
    const flags = Object.entries(action.flags ?? {});
    if (flags.length === 0) continue;
    lines.push(actions.length === 1 ? "flags:" : `flags (${displayName}):`);
    for (const [flagName, flagDef] of flags) lines.push(`  ${flagLine(flagName, flagDef)}`);
  }
  const notes = actions.flatMap(({ action }) => action.notes ?? []);
  if (notes.length > 0) {
    lines.push("notes:");
    for (const note of notes) lines.push(`  ${note}`);
  }
  const examples = actions.flatMap(({ action }) => action.examples ?? []);
  if (examples.length > 0) {
    lines.push("examples:");
    for (const example of examples) lines.push(`  ${example}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Compiles a declarative command definition into the runtime CommandSpec. */
export function defineCommand(name: string, def: CommandDef): CommandSpec {
  const hasAction = def.action !== undefined;
  const hasSubcommands = def.subcommands !== undefined && Object.keys(def.subcommands).length > 0;
  if (hasAction === hasSubcommands) {
    throw new Error(`command ${name} must define exactly one of action or subcommands`);
  }
  if (def.defaultSubcommand !== undefined && !Object.hasOwn(def.subcommands ?? {}, def.defaultSubcommand)) {
    throw new Error(`command ${name}: defaultSubcommand '${def.defaultSubcommand}' is not a subcommand`);
  }
  return {
    summary: def.summary,
    help: renderHelp(name, def),
    run: async (argv) => {
      const { displayName, action, rest } = resolveAction(name, def, argv);
      return action.run(parseActionArgs(displayName, action, rest));
    },
  };
}

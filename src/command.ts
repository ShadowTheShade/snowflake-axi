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
  /** Scoped help per subcommand verb; present on grouped commands. */
  subcommandHelp?: Record<string, string>;
  /**
   * True when run() itself answers `--help`. The SDK's help intercept only
   * knows the top-level command name, so grouped commands opt out of it to
   * serve help scoped to the requested subcommand instead of the whole group.
   */
  handlesHelp?: boolean;
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
  /**
   * Known-but-unsupported verbs and their redirects. Matching first arguments
   * fail loud with the given suggestions instead of falling through to the
   * default subcommand, where they would be misread as positionals.
   */
  verbHints?: Record<string, string[]>;
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
  // Stray positionals are usually flag values gone astray (an unquoted value
  // with spaces, a missing flag name), so inline the flag reference to make
  // the error self-correcting in one turn, like unknown-flag errors.
  const flagLines = Object.entries(action.flags ?? {}).map(([flagName, def]) => flagLine(flagName, def));
  throw new AxiError(message, "VALIDATION_ERROR", [`Run \`${usageLine(displayName, action)}\``, ...flagLines]);
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

/** Edit distance where an adjacent transposition counts as one edit, the most common typo. */
function editDistance(a: string, b: string): number {
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        rows[i - 1][j] + 1,
        current[j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        current[j] = Math.min(current[j], rows[i - 2][j - 2] + 1);
      }
    }
    rows.push(current);
  }
  return rows[a.length][b.length];
}

/**
 * A first argument within an edit or two of a real verb is far more likely a
 * typo'd subcommand than a positional; without this check it would fall
 * through to the default subcommand and return a plausible-looking result for
 * the wrong thing (e.g. `pg tabels` listing an empty "tabels" schema).
 */
export function nearestVerb(verb: string, names: string[]): string | undefined {
  const lower = verb.toLowerCase();
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const name of names) {
    const distance = editDistance(lower, name);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = name;
    }
  }
  return bestDistance <= (lower.length >= 5 ? 2 : 1) ? best : undefined;
}

function resolveAction(name: string, def: CommandDef, argv: string[]): ResolvedAction {
  if (def.action) return { displayName: name, action: def.action, rest: argv };
  const subs = def.subcommands ?? {};
  const verb = argv[0];
  if (verb !== undefined && Object.hasOwn(subs, verb)) {
    return { displayName: `${name} ${verb}`, action: subs[verb], rest: argv.slice(1) };
  }
  if (verb !== undefined && def.verbHints && Object.hasOwn(def.verbHints, verb)) {
    throw new AxiError(`'${verb}' is not a ${name} subcommand`, "VALIDATION_ERROR", [
      ...def.verbHints[verb],
      `Valid subcommands: ${Object.keys(subs).join(", ")}`,
    ]);
  }
  const fallback = def.defaultSubcommand === undefined ? undefined : subs[def.defaultSubcommand];
  if (!fallback) {
    throw new AxiError(`Unknown ${name} subcommand '${verb ?? ""}'`, "VALIDATION_ERROR", [
      `Valid subcommands: ${Object.keys(subs).join(", ")}`,
    ]);
  }
  if (verb !== undefined && !verb.startsWith("-")) {
    const near = nearestVerb(verb, Object.keys(subs));
    if (near !== undefined) {
      throw new AxiError(`'${verb}' is not a ${name} subcommand`, "VALIDATION_ERROR", [
        `Did you mean \`snowflake-axi ${name} ${near}\`?`,
        ...(fallback.positionals
          ? [
              `For '${verb}' as the ${fallback.positionals.usage} argument, run \`snowflake-axi ${name} ${def.defaultSubcommand} ${verb}\``,
            ]
          : []),
        `Valid subcommands: ${Object.keys(subs).join(", ")}`,
      ]);
    }
  }
  return { displayName: name, action: fallback, rest: argv };
}

function renderActionHelp(displayName: string, action: ActionDef, description?: string): string {
  const lines = [
    `command: ${displayName}`,
    `description: ${description ?? action.description}`,
    `usage: ${usageLine(displayName, action)}`,
  ];
  const flags = Object.entries(action.flags ?? {});
  if (flags.length > 0) {
    lines.push("flags:");
    for (const [flagName, flagDef] of flags) lines.push(`  ${flagLine(flagName, flagDef)}`);
  }
  if (action.notes && action.notes.length > 0) {
    lines.push("notes:");
    for (const note of action.notes) lines.push(`  ${note}`);
  }
  if (action.examples && action.examples.length > 0) {
    lines.push("examples:");
    for (const example of action.examples) lines.push(`  ${example}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The group's own help is an index - one usage-plus-description line per
 * subcommand - not the concatenation of every subcommand's manual; each verb's
 * flags, notes, and examples live in its scoped `<group> <verb> --help`.
 */
function renderGroupIndex(name: string, def: CommandDef): string {
  const lines = [
    `command: ${name}`,
    `description: ${def.description ?? def.summary}`,
    `usage: snowflake-axi ${name} [subcommand] [args] [flags]`,
    "subcommands:",
  ];
  for (const [verb, action] of Object.entries(def.subcommands ?? {})) {
    const usage = [verb, action.positionals?.usage, Object.keys(action.flags ?? {}).length > 0 ? "[flags]" : undefined]
      .filter(Boolean)
      .join(" ");
    const marker = verb === def.defaultSubcommand ? " (default)" : "";
    lines.push(`  ${usage}: ${action.description}${marker}`);
  }
  lines.push(`help: Run \`snowflake-axi ${name} <subcommand> --help\` for its flags, notes, and examples`);
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
  const help = def.action
    ? renderActionHelp(name, def.action, def.description ?? def.action.description)
    : renderGroupIndex(name, def);
  const subcommandHelp = def.action
    ? undefined
    : Object.fromEntries(
        Object.entries(def.subcommands ?? {}).map(([verb, action]) => [
          verb,
          renderActionHelp(`${name} ${verb}`, action),
        ]),
      );
  return {
    summary: def.summary,
    help,
    subcommandHelp,
    handlesHelp: true,
    run: async (argv) => {
      // `--help` always passes, before any validation: an explicit subcommand
      // gets its scoped manual, anything else the group index (or, for a
      // single-action command, its full help).
      if (argv.includes("--help")) {
        const verb = argv[0];
        if (subcommandHelp && verb !== undefined && Object.hasOwn(subcommandHelp, verb)) return subcommandHelp[verb];
        return help;
      }
      const { displayName, action, rest } = resolveAction(name, def, argv);
      return action.run(parseActionArgs(displayName, action, rest));
    },
  };
}

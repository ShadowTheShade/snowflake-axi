import { AxiError } from "axi-sdk-js";

export interface FlagSpec {
  takesValue: boolean;
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
}

export function parseFlags(command: string, args: string[], known: Record<string, FlagSpec>): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  const valid = () => `Valid flags for \`${command}\`: ${Object.keys(known).join(", ") || "(none)"}`;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--help") continue;
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const spec = known[name];
    if (!spec) {
      throw new AxiError(`Unknown flag ${name} for \`${command}\``, "VALIDATION_ERROR", [valid()]);
    }
    if (!spec.takesValue) {
      if (eq !== -1) {
        throw new AxiError(`Flag ${name} does not take a value`, "VALIDATION_ERROR", [valid()]);
      }
      flags[name] = true;
      continue;
    }
    const value = eq !== -1 ? arg.slice(eq + 1) : args[++i];
    if (value === undefined || (eq === -1 && value.startsWith("--"))) {
      throw new AxiError(`Flag ${name} requires a value`, "VALIDATION_ERROR", [valid()]);
    }
    flags[name] = value;
  }
  return { positionals, flags };
}

export function intFlag(
  flags: Record<string, string | true>,
  name: string,
  options: { fallback: number; min: number; max: number },
): number {
  const raw = flags[name];
  if (raw === undefined) return options.fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < options.min || value > options.max) {
    throw new AxiError(`Flag ${name} must be an integer between ${options.min} and ${options.max}`, "VALIDATION_ERROR");
  }
  return value;
}

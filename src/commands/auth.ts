import { AxiError } from "axi-sdk-js";
import { type CommandArgs, defineCommand } from "../command.js";
import {
  type AuthMode,
  loadConfig,
  oauthRingKeys,
  patConfigured,
  readAuthMode,
  readOAuthRing,
  writeAuthMode,
} from "../config.js";

function ringLogins(): string[] {
  const ring = readOAuthRing();
  return ring ? oauthRingKeys(ring) : [];
}

/** What a fresh invocation would resolve with no persisted mode and no env override. */
function defaultMode(): string {
  if (patConfigured()) return "pat";
  return ringLogins().length > 0 ? "oauth" : "(unconfigured)";
}

function show(): Record<string, unknown> {
  const envOverride = process.env.SNOWFLAKE_AUTH || undefined;
  const logins = ringLogins();
  let active: string;
  try {
    active = loadConfig().auth;
  } catch {
    active = "(unconfigured)";
  }
  return {
    active,
    ...(envOverride !== undefined
      ? { override: `SNOWFLAKE_AUTH=${envOverride} (process env, wins for this session)` }
      : {}),
    persisted: readAuthMode() ?? "(none; PAT is the default when a PAT is configured)",
    pat: patConfigured() ? "configured" : "not configured",
    oauth: logins.length > 0 ? `logins: ${logins.join(", ")}` : "no logins",
    help: [
      "Switch with `snowflake-axi auth pat` or `snowflake-axi auth oauth`; `auth default` clears the persisted choice",
      "SNOWFLAKE_AUTH=<mode> in the process env overrides the persisted mode for one session",
    ],
  };
}

function set(name: string): Record<string, unknown> {
  const target = name.toLowerCase();
  if (target === "default") {
    writeAuthMode(undefined);
    return {
      status: "auth mode -> default (PAT when a PAT is configured, else the OAuth ring)",
      active: defaultMode(),
    };
  }
  if (target !== "pat" && target !== "oauth") {
    throw new AxiError(`Unknown auth mode '${name}'`, "VALIDATION_ERROR", ["Valid modes: pat, oauth, default"]);
  }
  if (target === "pat" && !patConfigured()) {
    throw new AxiError("No PAT is configured, so PAT mode would fail on every command", "CONFIG_ERROR", [
      "Add SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_TOKEN to the env file first",
    ]);
  }
  if (target === "oauth" && ringLogins().length === 0) {
    throw new AxiError("No OAuth login exists, so OAuth mode would fail on every command", "CONFIG_ERROR", [
      "Run `snowflake-axi login` once, then switch",
    ]);
  }
  writeAuthMode(target as AuthMode);
  return {
    status: `auth mode -> ${target}`,
    active: target,
    note: "Every command uses this mode until changed; SNOWFLAKE_AUTH=<mode> overrides it per shell.",
  };
}

async function run(args: CommandArgs): Promise<Record<string, unknown>> {
  const name = args.positionals[0];
  return name === undefined ? show() : set(name);
}

export const authCommand = defineCommand("auth", {
  summary: "Show or switch the persisted auth mode; PAT is the default when configured",
  action: {
    description:
      "Show which auth mode commands run under (PAT or OAuth) and what each has available, or switch it: `auth pat`, `auth oauth`, and `auth default` to clear the persisted choice. Without a choice, PAT is the default whenever a PAT is configured; the OAuth ring only activates by itself when no PAT exists.",
    positionals: { usage: "[pat|oauth|default]", min: 0, max: 1 },
    notes: [
      "The persisted mode lives in the config dir and applies to every command; SNOWFLAKE_AUTH=<mode> in the process env overrides it for one session.",
      "Logging in with `snowflake-axi login` never switches the mode by itself when a PAT is configured.",
      "Switching validates the target has credentials (a PAT, or at least one OAuth login) so a bad mode cannot be pinned.",
    ],
    examples: ["snowflake-axi auth", "snowflake-axi auth oauth", "snowflake-axi auth default"],
    run,
  },
});

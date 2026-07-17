import { AxiError } from "axi-sdk-js";
import { type CommandArgs, defineCommand } from "../command.js";
import {
  DEFAULT_ROLE_KEY,
  IDENTIFIER,
  loadConfig,
  oauthRoleKey,
  processEnvRole,
  readActiveRole,
  readOAuthRing,
  ringLogins,
  writeActiveRole,
} from "../config.js";
import { runQuery } from "../snowflake.js";

/** The active role for display: an explicit name, or "default" for the unscoped login. */
function activeLabel(): string {
  return readActiveRole() ?? DEFAULT_ROLE_KEY;
}

function show(oauth: boolean): Record<string, unknown> {
  const envRole = processEnvRole();
  return {
    active: activeLabel(),
    ...(envRole !== undefined
      ? { override: `SNOWFLAKE_ROLE=${envRole} (process env; outranks the active role for this session)` }
      : {}),
    ...(oauth ? { logins: ringLogins() } : { auth: "PAT" }),
    help: [
      "Switch with `snowflake-axi role <name>`; `snowflake-axi role default` reverts to the default role",
      oauth
        ? "Only roles with a login are switchable; add one with `snowflake-axi login --role <name>`"
        : "Any role granted to the user works; Snowflake enforces the grant at query time",
      "List every role granted to the user with `snowflake-axi role --grants`",
    ],
  };
}

function setRole(name: string, oauth: boolean): Record<string, unknown> {
  const isDefault = name.toLowerCase() === DEFAULT_ROLE_KEY;
  const role = isDefault ? undefined : name.toUpperCase();
  if (role !== undefined && !IDENTIFIER.test(role)) {
    throw new AxiError(`Invalid role name '${name}'`, "VALIDATION_ERROR", [
      "Role names are unquoted identifiers (letters, digits, _ and $)",
    ]);
  }
  // In OAuth mode a role is only reachable through its own login, so refuse to
  // pin one the ring cannot serve rather than let every later command fail.
  if (oauth && readOAuthRing()?.entries[oauthRoleKey(role)] === undefined) {
    throw new AxiError(
      isDefault ? "No default (unscoped) OAuth login exists to switch to" : `No OAuth login for role ${role}`,
      "NOT_FOUND",
      [
        `Run \`snowflake-axi login${role ? ` --role ${role}` : ""}\` once to add it; each role keeps its own login`,
        `Current logins: ${ringLogins().join(", ") || "(none)"}`,
      ],
    );
  }
  writeActiveRole(role);
  return {
    status: role ? `active role -> ${role}` : "active role -> default (unscoped login)",
    active: role ?? DEFAULT_ROLE_KEY,
    ...(oauth ? { logins: ringLogins() } : {}),
    note: "Every command runs as this role until changed; pass --role on a command to override it once.",
  };
}

async function grants(oauth: boolean): Promise<Record<string, unknown>> {
  const config = loadConfig();
  const { rows } = await runQuery(`SHOW GRANTS TO USER ${config.user}`);
  const roles = [...new Set(rows.map((row) => String(row.role ?? "")).filter(Boolean))].sort();
  const logins = new Set(ringLogins());
  const active = activeLabel().toUpperCase();
  return {
    user: config.user,
    active: activeLabel(),
    granted: roles.map((role) => ({
      role,
      ...(oauth ? { login: logins.has(role) ? "yes" : `no (\`login --role ${role}\`)` } : {}),
      ...(role.toUpperCase() === active ? { active: true } : {}),
    })),
    ...(oauth ? { note: "Only roles with a login are switchable now; `login --role <name>` adds one." } : {}),
  };
}

async function run(args: CommandArgs): Promise<Record<string, unknown>> {
  const oauth = loadConfig().auth === "oauth";
  const name = args.positionals[0];
  if (args.bool("--grants")) {
    if (name !== undefined) {
      throw new AxiError("`role --grants` lists roles and takes no role argument", "VALIDATION_ERROR", [
        "Switch the active role with `snowflake-axi role <name>` (drop --grants)",
      ]);
    }
    return grants(oauth);
  }
  return name === undefined ? show(oauth) : setRole(name, oauth);
}

export const roleCommand = defineCommand("role", {
  summary: "Show or switch the active role every command runs as",
  action: {
    description:
      "Show the active role and the roles you can switch to, switch it (`role <name>`, or `role default` to revert), or list every role granted to the user (`--grants`, live). The active role is the default primary role for every command until changed, so reads like `schema` and `tables` run as it without a per-command --role.",
    positionals: { usage: "[<name>|default]", min: 0, max: 1 },
    flags: {
      "--grants": {
        type: "boolean",
        description: "run SHOW GRANTS TO USER to list every role the user could log in as (live query)",
      },
    },
    notes: [
      "The active role is saved in the config dir and applies to reads and writes alike; a Snowflake role stays the hard boundary on what it can do.",
      "In OAuth mode you can only switch to a role that already has a login in the ring; add one with `snowflake-axi login --role <name>`, and `role default` selects the unscoped login.",
      "In PAT mode any role granted to the user works; there is no offline check, so a role the user lacks fails at query time.",
      "`--role` on an individual command still overrides the active role for that one run.",
      "Precedence per statement: --role, then SNOWFLAKE_ROLE in the process env (pins one session; the active role is shared machine state), then the active role, then the env-file SNOWFLAKE_ROLE.",
    ],
    examples: [
      "snowflake-axi role",
      "snowflake-axi role REPORTER",
      "snowflake-axi role default",
      "snowflake-axi role --grants",
    ],
    run,
  },
});

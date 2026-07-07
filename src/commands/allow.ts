import { AxiError } from "axi-sdk-js";
import { type CommandArgs, defineCommand } from "../command.js";
import { grantsFilePath, readGrants, WRITE_CAPABILITIES, writeGrants } from "../grants.js";

function listCapabilities(): Record<string, unknown> {
  const grants = readGrants();
  return {
    capabilities: Object.entries(WRITE_CAPABILITIES).map(([capability, meta]) => ({
      capability,
      granted: grants.has(capability),
      description: meta.description,
    })),
    file: grantsFilePath(),
    help: [
      "Run `snowflake-axi allow <capability>` in an interactive terminal to grant one",
      "Run `snowflake-axi allow <capability> --revoke` to withdraw it",
    ],
  };
}

async function run(args: CommandArgs): Promise<Record<string, unknown>> {
  const capability = args.positionals[0];
  if (capability === undefined) return listCapabilities();
  const meta = WRITE_CAPABILITIES[capability];
  if (!meta) {
    throw new AxiError(`Unknown write capability '${capability}'`, "VALIDATION_ERROR", [
      `Valid capabilities: ${Object.keys(WRITE_CAPABILITIES).join(", ")}`,
    ]);
  }

  const grants = readGrants();
  if (args.bool("--revoke")) {
    if (!grants.has(capability)) return { capability, granted: false, note: "was not granted (no-op)" };
    grants.delete(capability);
    writeGrants(grants);
    return { capability, granted: false };
  }

  if (!process.stdin.isTTY) {
    throw new AxiError("Granting a write capability requires a human at an interactive terminal", "HUMAN_REQUIRED", [
      `The user must run \`snowflake-axi allow ${capability}\` in their own shell`,
      "Do not grant write capabilities on the user's behalf",
    ]);
  }
  if (grants.has(capability)) return { capability, granted: true, note: "already granted (no-op)" };
  grants.add(capability);
  writeGrants(grants);
  return { capability, granted: true, help: [`Unlocked: ${meta.unlocks}`] };
}

export const allowCommand = defineCommand("allow", {
  summary: "Grant or revoke write capabilities (human, interactive terminal only)",
  action: {
    description:
      "List write capabilities, or grant one. Granting requires an interactive terminal so only a human can do it; revoking works anywhere.",
    positionals: { usage: "[capability]", min: 0, max: 1 },
    flags: {
      "--revoke": { type: "boolean", description: "withdraw the capability instead of granting it" },
    },
    notes: [
      "Grants persist in the config directory and gate every write command.",
      "The Snowflake role remains the hard boundary; grants only express user consent.",
    ],
    examples: ["snowflake-axi allow", "snowflake-axi allow dbt.execute", "snowflake-axi allow dbt.execute --revoke"],
    run,
  },
});

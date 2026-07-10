import { defineCommand } from "../command.js";
import { loadConfig } from "../config.js";

export const contextCommand = defineCommand("context", {
  summary: "Compact config-derived context line for session-start hooks",
  action: {
    description: "Print a compact orientation line for session-start hooks: config-derived only, no connection is made",
    run: () => {
      let config: ReturnType<typeof loadConfig>;
      try {
        config = loadConfig();
      } catch {
        // Ambient surface: an unconfigured machine stays silent rather than
        // nagging every session with a setup error.
        return "";
      }
      return {
        tool: "snowflake-axi: read-only Snowflake explorer on PATH",
        account: config.account,
        user: config.user,
        help: ["Run `snowflake-axi` for live connection context and readable databases"],
      };
    },
    notes: [
      "This is what the SessionStart hook registered by `snowflake-axi hooks install` prints.",
      "Unconfigured machines print nothing (exit 0), so the hook never nags sessions that cannot use it.",
    ],
    examples: ["snowflake-axi context"],
  },
});

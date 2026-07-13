import { defineCommand } from "../command.js";
import { loadConfig, loadPgConfig, oauthRingKeys, readOAuthRing } from "../config.js";
import { readGrants } from "../grants.js";

function pgLine(): string | undefined {
  try {
    const pg = loadPgConfig();
    const mode = readGrants().has("pg.write") ? "read-write" : "read-only";
    return `${pg.database} @ ${pg.host} (${mode}; \`snowflake-axi pg\`)`;
  } catch {
    return undefined;
  }
}

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
      const pg = pgLine();
      const ring = config.auth === "oauth" ? readOAuthRing() : undefined;
      const entries = ring ? oauthRingKeys(ring).map((key) => ring.entries[key]) : [];
      // The earliest refresh expiry is the first login that will demand a browser.
      const refreshExpires =
        entries.length > 0 ? Math.min(...entries.map((entry) => entry.refreshTokenExpiresAt)) : undefined;
      const roles = ring ? oauthRingKeys(ring) : [];
      const auth =
        config.auth === "oauth"
          ? `OAuth, logged in as ${config.user}${roles.length > 1 ? ` (${roles.join(", ")})` : ""}${
              refreshExpires !== undefined ? `, expires ${new Date(refreshExpires).toISOString().slice(0, 10)}` : ""
            }`
          : "PAT";
      return {
        tool: "snowflake-axi: read-only Snowflake explorer on PATH",
        account: config.account,
        user: config.user,
        auth,
        ...(pg !== undefined ? { pg } : {}),
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

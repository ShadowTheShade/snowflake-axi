import { defineCommand } from "../command.js";
import { oauthRingKeys, oauthTokenPath, patConfigured, readAuthMode, readOAuthRing } from "../config.js";
import { login } from "../oauth.js";

export const loginCommand = defineCommand("login", {
  summary: "Browser SSO login via Snowflake OAuth (alternative to PAT auth)",
  action: {
    description:
      "Open the browser for a Snowflake OAuth login (PKCE, no client secret) and store the tokens; later runs refresh silently until the refresh token expires",
    flags: {
      "--role": {
        type: "string",
        placeholder: "<name>",
        description:
          "pin the login's role via the session:role scope; omitted, the login carries the user's default role",
      },
    },
    run: async (args) => {
      const tokens = await login({ role: args.str("--role") });
      const ring = readOAuthRing();
      return {
        status: "logged in",
        account: tokens.account,
        user: tokens.user,
        ...(tokens.roleScope !== undefined ? { role: `${tokens.roleScope} (pinned by scope)` } : {}),
        refreshTokenExpires: new Date(tokens.refreshTokenExpiresAt).toISOString(),
        logins: ring ? oauthRingKeys(ring) : [],
        tokenFile: oauthTokenPath(),
        ...(patConfigured() && readAuthMode() !== "oauth"
          ? {
              help: [
                "PAT stays the default auth mode; run `snowflake-axi auth oauth` to switch, or SNOWFLAKE_AUTH=oauth for one shell",
              ],
            }
          : {}),
      };
    },
    notes: [
      "Needs SNOWFLAKE_ACCOUNT and SNOWFLAKE_OAUTH_CLIENT_ID in the env file; the README's OAuth setup covers the one-time security integration.",
      "SNOWFLAKE_OAUTH_ROLE_SCOPE in the env file sets a default for --role.",
      "Every OAuth token is pinned to one role, so the token file is a ring of logins: `login --role <name>` once per role, and per-query --role picks the matching login.",
      "Logging in never switches the auth mode by itself when a PAT is configured: run `snowflake-axi auth oauth` to make OAuth active, or SNOWFLAKE_AUTH=oauth per shell; with no PAT the ring activates on its own. `snowflake-axi logout` removes logins.",
      "Snowflake blocks ACCOUNTADMIN and SECURITYADMIN as the primary role over OAuth by default.",
    ],
    examples: ["snowflake-axi login", "snowflake-axi login --role REPORTER"],
  },
});

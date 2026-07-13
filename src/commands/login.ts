import { defineCommand } from "../command.js";
import { oauthTokenPath } from "../config.js";
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
          "pin the session role via the session:role scope; omitted, the token carries the user's default role",
      },
    },
    run: async (args) => {
      const tokens = await login({ role: args.str("--role") });
      return {
        status: "logged in",
        account: tokens.account,
        user: tokens.user,
        ...(tokens.roleScope !== undefined ? { role: `${tokens.roleScope} (pinned by scope)` } : {}),
        refreshTokenExpires: new Date(tokens.refreshTokenExpiresAt).toISOString(),
        tokenFile: oauthTokenPath(),
      };
    },
    notes: [
      "Needs SNOWFLAKE_ACCOUNT and SNOWFLAKE_OAUTH_CLIENT_ID in the env file; the README's OAuth setup covers the one-time security integration.",
      "SNOWFLAKE_OAUTH_ROLE_SCOPE in the env file sets a default for --role.",
      "OAuth sessions are pinned to the token's one role - secondary roles are suppressed and per-query --role fails; switching means logging in again, and role breadth needs PAT auth.",
      "The token file makes OAuth the active auth mode; SNOWFLAKE_AUTH=pat forces PAT again without deleting it.",
      "Snowflake blocks ACCOUNTADMIN and SECURITYADMIN sessions over OAuth by default.",
    ],
    examples: ["snowflake-axi login", "snowflake-axi login --role REPORTER"],
  },
});

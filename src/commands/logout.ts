import { defineCommand } from "../command.js";
import { oauthTokenPath } from "../config.js";
import { logout } from "../oauth.js";

export const logoutCommand = defineCommand("logout", {
  summary: "Remove OAuth logins from the token ring",
  action: {
    description:
      "Delete stored OAuth logins; removing the last one deletes the token file and the tool falls back to PAT auth",
    flags: {
      "--role": {
        type: "string",
        placeholder: "<name>",
        description: "log out one role's login; `default` names the unscoped login",
      },
      "--all": { type: "boolean", description: "log out every login" },
    },
    run: (args) => {
      const result = logout({ role: args.str("--role"), all: args.bool("--all") });
      return {
        status: "logged out",
        removed: result.removed,
        ...(result.remaining.length > 0
          ? { remaining: result.remaining }
          : { tokenFile: `${oauthTokenPath()} removed` }),
      };
    },
    notes: [
      "With a single login, a bare `logout` removes it; with several, choose via --role or --all.",
      "Deletion is local: Snowflake OAuth has no client revocation endpoint, so the refresh token also dies at its server-side expiry.",
    ],
    examples: ["snowflake-axi logout", "snowflake-axi logout --role REPORTER", "snowflake-axi logout --all"],
  },
});

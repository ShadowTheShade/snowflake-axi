import { homedir } from "node:os";
import { defineCommand } from "../command.js";
import { collapseHome } from "../format.js";
import {
  contextExecPath,
  hookStatuses,
  installHooks,
  plannedHookCommand,
  removeHooks,
  type TargetResult,
} from "../hooks.js";

function rows(results: TargetResult[]): Record<string, unknown>[] {
  return results.map((result) => ({ app: result.app, file: collapseHome(result.file), status: result.status }));
}

export const hooksCommand = defineCommand("hooks", {
  summary: "Session-start hook status; install or remove the ambient context hook",
  description:
    "Manage the SessionStart hook that opens agent sessions with a compact snowflake-axi context line (Claude Code, Codex, OpenCode)",
  defaultSubcommand: "status",
  subcommands: {
    status: {
      description: "Show whether the SessionStart hook is installed per app",
      run: () => ({
        targets: rows(hookStatuses(homedir())),
        help: [
          "Run `snowflake-axi hooks install` to register the hook (explicit opt-in)",
          "Run `snowflake-axi hooks remove` to withdraw it",
        ],
      }),
    },
    install: {
      description: "Register the SessionStart context hook (idempotent; repairs a moved binary path)",
      notes: [
        "The hook runs the snowflake-axi-context binary: config-derived, no connection, one-line token cost per session.",
        "Targets Claude Code, Codex (hooks.json plus the [features].hooks toggle), and OpenCode (managed plugin).",
      ],
      examples: ["snowflake-axi hooks install"],
      run: () => {
        const execPath = contextExecPath();
        return {
          command: plannedHookCommand(execPath),
          targets: rows(installHooks(homedir(), execPath)),
          help: ["New agent sessions start with the context line; run `snowflake-axi hooks remove` to withdraw it"],
        };
      },
    },
    remove: {
      description: "Remove the SessionStart context hook (idempotent)",
      examples: ["snowflake-axi hooks remove"],
      run: () => ({
        targets: rows(removeHooks(homedir())),
        note: "Codex [features].hooks stays enabled; other tools may rely on it",
        help: ["Run `snowflake-axi hooks install` to register the hook again"],
      }),
    },
  },
});

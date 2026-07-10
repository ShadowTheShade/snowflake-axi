import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hookStatuses, installHooks, removeHooks } from "../src/hooks.js";

// A plausible built-binary path; the SDK's install policy checks the shape of
// the path (marker, dist entrypoint), not its existence, and with no matching
// PATH entry the hook command falls back to this absolute path.
const EXEC = "/opt/snowflake-axi/dist/bin/snowflake-axi-context.js";
const EXEC2 = "/moved/snowflake-axi/dist/bin/snowflake-axi-context.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "axi-hooks-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const claudeFile = () => join(home, ".claude", "settings.json");
const openCodeFile = () => join(home, ".config", "opencode", "plugins", "axi-snowflake-axi.js");

function claudeSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(claudeFile(), "utf8"));
}

describe("hooks install", () => {
  it("registers the hook for Claude Code, Codex, and OpenCode", () => {
    const results = installHooks(home, EXEC);
    expect(results.map((r) => `${r.app}: ${r.status}`)).toEqual([
      "Claude Code: installed",
      "Codex: installed",
      "Codex: hooks feature enabled",
      "OpenCode: installed",
    ]);
    const settings = claudeSettings() as { hooks: { SessionStart: { hooks: { command: string }[] }[] } };
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(EXEC);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain("hooks = true");
    expect(readFileSync(openCodeFile(), "utf8")).toContain("axi-sdk-js managed opencode plugin: snowflake-axi");
  });

  it("is idempotent: a second install is a no-op everywhere", () => {
    installHooks(home, EXEC);
    const results = installHooks(home, EXEC);
    expect(results.map((r) => r.status)).toEqual([
      "already installed (no-op)",
      "already installed (no-op)",
      "hooks feature already enabled (no-op)",
      "already installed (no-op)",
    ]);
  });

  it("repairs a moved binary path without duplicating hooks", () => {
    installHooks(home, EXEC);
    const results = installHooks(home, EXEC2);
    expect(results.map((r) => r.status)).toEqual([
      "updated",
      "updated",
      "hooks feature already enabled (no-op)",
      "updated",
    ]);
    const settings = claudeSettings() as { hooks: { SessionStart: { hooks: { command: string }[] }[] } };
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(EXEC2);
  });

  it("preserves unrelated settings and reports an unparseable file without clobbering it", () => {
    installHooks(home, EXEC);
    const before = claudeSettings();
    writeFileSync(claudeFile(), JSON.stringify({ ...before, permissions: { allow: ["Bash(git *)"] } }, null, 2));
    const results = installHooks(home, EXEC);
    expect(results[0].status).toBe("already installed (no-op)");
    expect((claudeSettings() as { permissions: unknown }).permissions).toEqual({ allow: ["Bash(git *)"] });

    writeFileSync(claudeFile(), "{ not json");
    const broken = installHooks(home, EXEC);
    expect(broken[0].status).toMatch(/^error:/);
    expect(readFileSync(claudeFile(), "utf8")).toBe("{ not json");
  });
});

describe("hooks remove", () => {
  it("removes the managed hook and plugin while keeping user hooks", () => {
    installHooks(home, EXEC);
    const settings = claudeSettings() as { hooks: { SessionStart: unknown[] } };
    settings.hooks.SessionStart.push({ matcher: "", hooks: [{ type: "command", command: "echo hi" }] });
    writeFileSync(claudeFile(), JSON.stringify(settings, null, 2));

    const results = removeHooks(home);
    expect(results.map((r) => `${r.app}: ${r.status}`)).toEqual([
      "Claude Code: removed",
      "Codex: removed",
      "OpenCode: removed",
    ]);
    const after = claudeSettings() as { hooks: { SessionStart: { hooks: { command: string }[] }[] } };
    expect(after.hooks.SessionStart).toHaveLength(1);
    expect(after.hooks.SessionStart[0].hooks[0].command).toBe("echo hi");
    expect(existsSync(openCodeFile())).toBe(false);
  });

  it("leaves an unmanaged OpenCode plugin in place", () => {
    installHooks(home, EXEC);
    writeFileSync(openCodeFile(), "export const MyPlugin = () => {};");
    const results = removeHooks(home);
    expect(results[2].status).toBe("not managed (left in place)");
    expect(existsSync(openCodeFile())).toBe(true);
  });

  it("is a no-op when nothing is installed", () => {
    const results = removeHooks(home);
    expect(results.map((r) => r.status)).toEqual([
      "not installed (no-op)",
      "not installed (no-op)",
      "not installed (no-op)",
    ]);
  });
});

describe("hooks status", () => {
  it("reports installed commands and definitive absence", () => {
    expect(hookStatuses(home).map((r) => r.status)).toEqual([
      "(not installed)",
      "(not installed)",
      "(not installed)",
    ]);
    installHooks(home, EXEC);
    expect(hookStatuses(home).map((r) => r.status)).toEqual([EXEC, EXEC, EXEC]);
  });
});

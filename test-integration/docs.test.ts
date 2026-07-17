import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WRITE_CAPABILITIES } from "../src/grants.js";
import { CORE_COMMANDS } from "../src/index.js";
import { cli } from "./harness.js";

/**
 * Doc drift guard: the docs are validated against the built CLI itself, no
 * generation step to keep in sync. Every `snowflake-axi ...` example line is
 * run without credentials; flag and command validation happens before any
 * connection, so exit code 2 means exactly one thing - the example uses a
 * command or flag the CLI no longer accepts.
 */

const SKILL = readFileSync(fileURLToPath(new URL("../skill/SKILL.md", import.meta.url)), "utf8");
const README = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");

/** Splits a shell-ish example line into argv, honoring quotes and dropping trailing # comments. */
function splitArgs(line: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | undefined;
  let inToken = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) args.push(current);
      current = "";
      inToken = false;
      continue;
    }
    if (ch === "#" && !inToken) break;
    current += ch;
    inToken = true;
  }
  if (inToken) args.push(current);
  return args;
}

/** Every line-leading `snowflake-axi ...` example, minus templates with <placeholders>. */
function documentedInvocations(doc: string): string[][] {
  const invocations: string[][] = [];
  for (const line of doc.split("\n")) {
    const match = line.match(/^\s*snowflake-axi(\s+.*)?$/);
    if (!match) continue;
    const rest = match[1] ?? "";
    if (/<[^>]+>/.test(rest)) continue;
    invocations.push(splitArgs(rest));
  }
  return invocations;
}

// Credential-free environment: config file, plugins, and snow CLI connections
// resolve to nowhere, and any SNOWFLAKE_* variables from the host shell are
// blanked out.
const offlineEnv: Record<string, string> = {
  XDG_CONFIG_HOME: "/nonexistent-snowflake-axi-docs",
  SNOWFLAKE_HOME: "/nonexistent-snowflake-axi-docs",
};
for (const key of Object.keys(process.env)) {
  if (key.startsWith("SNOWFLAKE_")) offlineEnv[key] = "";
}

const examples = [...documentedInvocations(SKILL), ...documentedInvocations(README)];

describe("documented examples run against the built CLI (drift guard)", () => {
  it("extracts a plausible number of examples", () => {
    expect(examples.length).toBeGreaterThanOrEqual(10);
  });

  for (const args of examples) {
    it(`\`snowflake-axi ${args.join(" ")}\` is not a usage error`, async () => {
      const { stdout, code } = await cli(args, offlineEnv);
      expect(code, stdout).not.toBe(2);
    });
  }
});

describe("doc coverage (drift guard)", () => {
  it("SKILL.md exercises every core command", () => {
    for (const name of Object.keys(CORE_COMMANDS)) {
      expect(SKILL, `SKILL.md lacks an example for '${name}'`).toContain(`snowflake-axi ${name}`);
    }
  });

  it("the skill frontmatter names every gated write capability", () => {
    const frontmatter = SKILL.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    for (const capability of Object.keys(WRITE_CAPABILITIES)) {
      const verb = capability.split(".")[1];
      expect(frontmatter, `skill frontmatter omits the '${capability}' write`).toContain(verb);
    }
  });

  it("every flag the docs mention exists in a command's help", () => {
    const helpText = Object.values(CORE_COMMANDS)
      .flatMap((spec) => [spec.help, ...Object.values(spec.subcommandHelp ?? {})])
      .join("\n");
    const documented = new Set([
      ...(SKILL.match(/--[a-z]+/g) ?? []),
      ...[...README.matchAll(/`[^`]*?(--[a-z]+)[^`]*?`/g)].map((m) => m[1]),
    ]);
    documented.delete("--help");
    for (const flag of documented) {
      expect(helpText, `docs mention ${flag} but no command help documents it`).toContain(flag);
    }
  });
});

import { describe, expect, it } from "vitest";
import { type CommandArgs, defineCommand } from "../src/command.js";

const echo = (args: CommandArgs) => ({
  positionals: args.positionals,
  limit: args.int("--limit"),
  full: args.bool("--full"),
  name: args.str("--name"),
});

const single = defineCommand("demo", {
  summary: "Demo command",
  action: {
    description: "Echoes parsed arguments",
    positionals: { usage: "<a> [b]", min: 1, max: 2 },
    flags: {
      "--limit": { type: "int", placeholder: "<n>", description: "max items", default: 10, min: 1, max: 100 },
      "--full": { type: "boolean", description: "disable truncation" },
      "--name": { type: "string", placeholder: "<name>", description: "a name" },
    },
    notes: ["A note."],
    examples: ["snowflake-axi demo x --limit 3"],
    run: echo,
  },
});

const grouped = defineCommand("group", {
  summary: "Grouped command",
  description: "Group of verbs",
  defaultSubcommand: "list",
  verbHints: { fetch: ["Use `group read <path>` instead"] },
  subcommands: {
    list: {
      description: "List things",
      positionals: { usage: "<path>", min: 1, max: 1 },
      run: (args) => ({ verb: "list", path: args.positionals[0] }),
    },
    read: {
      description: "Read a thing",
      positionals: { usage: "<path>", min: 1, max: 1 },
      flags: { "--full": { type: "boolean", description: "no truncation" } },
      run: (args) => ({ verb: "read", path: args.positionals[0], full: args.bool("--full") }),
    },
  },
});

describe("defineCommand: single action", () => {
  it("parses flags of all three types with defaults", async () => {
    const out = await single.run(["a", "b", "--limit", "3", "--full", "--name", "n"]);
    expect(out).toEqual({ positionals: ["a", "b"], limit: 3, full: true, name: "n" });
    const defaults = await single.run(["a"]);
    expect(defaults).toEqual({ positionals: ["a"], limit: 10, full: false, name: undefined });
  });

  it("rejects wrong arity with the usage line and inlines the flag reference", async () => {
    await expect(single.run([])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(single.run(["a", "b", "c"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("at most 2"),
      suggestions: expect.arrayContaining([expect.stringContaining("--limit <n>: max items")]),
    });
  });

  it("lists full flag reference lines on unknown flags", async () => {
    await expect(single.run(["a", "--bogus"])).rejects.toMatchObject({
      suggestions: expect.arrayContaining([expect.stringContaining("--limit <n>: max items (default 10, max 100)")]),
    });
  });

  it("generates help with usage, flags, notes, and examples", () => {
    expect(single.help).toContain("command: demo");
    expect(single.help).toContain("usage: snowflake-axi demo <a> [b] [flags]");
    expect(single.help).toContain("--limit <n>: max items (default 10, max 100)");
    expect(single.help).toContain("A note.");
    expect(single.help).toContain("snowflake-axi demo x --limit 3");
  });
});

describe("defineCommand: subcommands", () => {
  it("dispatches to a named subcommand", async () => {
    expect(await grouped.run(["read", "x", "--full"])).toEqual({ verb: "read", path: "x", full: true });
  });

  it("falls back to the default subcommand", async () => {
    expect(await grouped.run(["x"])).toEqual({ verb: "list", path: "x" });
  });

  it("redirects hinted verbs instead of misreading them as positionals", async () => {
    await expect(grouped.run(["fetch", "x"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "'fetch' is not a group subcommand",
      suggestions: ["Use `group read <path>` instead", "Valid subcommands: list, read"],
    });
    // The hint wins even when flags of some other subcommand would fail first.
    await expect(grouped.run(["fetch", "--full"])).rejects.toMatchObject({
      message: "'fetch' is not a group subcommand",
    });
  });

  it("validates flags per subcommand", async () => {
    await expect(grouped.run(["x", "--full"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("generates grouped help with per-verb usage", () => {
    expect(grouped.help).toContain("snowflake-axi group <path>");
    expect(grouped.help).toContain("snowflake-axi group read <path> [flags]");
    expect(grouped.help).toContain("flags (group read):");
  });

  it("rejects invalid definitions at define time", () => {
    expect(() => defineCommand("bad", { summary: "s" })).toThrow(/exactly one of/);
    expect(() =>
      defineCommand("bad", {
        summary: "s",
        defaultSubcommand: "nope",
        subcommands: { a: { description: "d", run: () => ({}) } },
      }),
    ).toThrow(/defaultSubcommand/);
  });
});

import { describe, expect, it } from "vitest";
import { cli } from "./harness.js";

/**
 * The global --json switch: every result and error renders as parseable JSON
 * instead of TOON, so an agent can pipe output into a parser. Run offline (no
 * credentials, XDG pointed at nowhere so no plugins load) against the built
 * CLI, exercising only paths that never open a connection.
 */

const offlineEnv: Record<string, string> = {
  XDG_CONFIG_HOME: "/nonexistent-snowflake-axi-json",
  SNOWFLAKE_HOME: "/nonexistent-snowflake-axi-json",
};
for (const key of Object.keys(process.env)) {
  if (key.startsWith("SNOWFLAKE_")) offlineEnv[key] = "";
}

describe("--json output mode", () => {
  it("renders a structured result as JSON (allow, no connection)", async () => {
    const { stdout, code } = await cli(["allow", "--json"], offlineEnv);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { capabilities: { capability: string }[] };
    expect(Array.isArray(parsed.capabilities)).toBe(true);
    expect(parsed.capabilities.some((c) => c.capability === "sql.write")).toBe(true);
  });

  it("renders a write-gate error as JSON with a nonzero exit", async () => {
    const { stdout, code } = await cli(["query", "DELETE FROM T", "--json"], offlineEnv);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout) as { code: string; help: string[] };
    expect(parsed.code).toBe("WRITE_NOT_ALLOWED");
    expect(parsed.help.length).toBeGreaterThan(0);
  });

  it("renders an unknown-command usage error as JSON with exit 2", async () => {
    const { stdout, code } = await cli(["nope", "--json"], offlineEnv);
    expect(code).toBe(2);
    const parsed = JSON.parse(stdout) as { error: string; code: string };
    expect(parsed.code).toBe("VALIDATION_ERROR");
    expect(parsed.error).toContain("Unknown command");
  });

  it("is stripped before command parsing, so its position does not matter", async () => {
    const front = await cli(["--json", "allow"], offlineEnv);
    expect(front.code).toBe(0);
    expect(() => JSON.parse(front.stdout)).not.toThrow();
  });

  it("leaves the default TOON output untouched when absent", async () => {
    const { stdout, code } = await cli(["allow"], offlineEnv);
    expect(code).toBe(0);
    // TOON, not JSON: the capabilities table does not start with a JSON object.
    expect(stdout.trimStart().startsWith("{")).toBe(false);
    expect(stdout).toContain("capabilities");
  });
});

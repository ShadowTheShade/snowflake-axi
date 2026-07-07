import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantsFilePath, readGrants, requireGrant, writeGrants } from "../src/grants.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "axi-grants-"));
  vi.stubEnv("XDG_CONFIG_HOME", dir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("grants", () => {
  it("reads an empty set when no grants file exists", () => {
    expect(readGrants()).toEqual(new Set());
  });

  it("round-trips grants through the file, ignoring comments", () => {
    writeGrants(new Set(["dbt.execute"]));
    expect(readGrants()).toEqual(new Set(["dbt.execute"]));
    expect(readFileSync(grantsFilePath(), "utf8")).toContain("# Write capabilities");
  });

  it("requireGrant throws WRITE_NOT_ALLOWED telling the agent to ask the user", () => {
    expect(() => requireGrant("dbt.execute")).toThrowError(
      expect.objectContaining({
        code: "WRITE_NOT_ALLOWED",
        suggestions: expect.arrayContaining([
          "Ask the user to run `snowflake-axi allow dbt.execute` in their own terminal",
        ]),
      }),
    );
  });

  it("requireGrant passes silently once granted", () => {
    writeGrants(new Set(["dbt.execute"]));
    expect(() => requireGrant("dbt.execute")).not.toThrow();
  });
});

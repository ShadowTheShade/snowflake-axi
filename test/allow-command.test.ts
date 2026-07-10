import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowCommand } from "../src/commands/allow.js";
import { readGrants } from "../src/grants.js";

let dir: string;
const originalTty = process.stdin.isTTY;

function setTty(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "axi-allow-"));
  vi.stubEnv("XDG_CONFIG_HOME", dir);
});

afterEach(() => {
  setTty(originalTty);
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("allow command", () => {
  it("lists capabilities with their granted status", async () => {
    const output = (await allowCommand.run([])) as Record<string, unknown>;
    expect(output.capabilities).toEqual([
      expect.objectContaining({ capability: "dbt.build", granted: false }),
      expect.objectContaining({ capability: "dbt.execute", granted: false }),
      expect.objectContaining({ capability: "dbt.deploy", granted: false }),
      expect.objectContaining({ capability: "dbt.drop", granted: false }),
      expect.objectContaining({ capability: "git.fetch", granted: false }),
    ]);
  });

  it("rejects unknown capabilities listing the valid ones", async () => {
    await expect(allowCommand.run(["dbt.destroy"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      suggestions: ["Valid capabilities: dbt.build, dbt.execute, dbt.deploy, dbt.drop, git.fetch"],
    });
  });

  it("refuses to grant without an interactive terminal or --agent", async () => {
    setTty(undefined);
    await expect(allowCommand.run(["dbt.execute"])).rejects.toMatchObject({ code: "HUMAN_REQUIRED" });
    expect(readGrants()).toEqual(new Set());
  });

  it("grants without a terminal when the agent carries user approval", async () => {
    setTty(undefined);
    const output = (await allowCommand.run(["dbt.execute", "--agent"])) as Record<string, unknown>;
    expect(output).toMatchObject({ capability: "dbt.execute", granted: true });
    expect(readGrants()).toEqual(new Set(["dbt.execute"]));
  });

  it("grants from an interactive terminal and persists", async () => {
    setTty(true);
    const output = (await allowCommand.run(["dbt.execute"])) as Record<string, unknown>;
    expect(output).toMatchObject({ capability: "dbt.execute", granted: true });
    expect(readGrants()).toEqual(new Set(["dbt.execute"]));
  });

  it("re-granting is an explicit no-op", async () => {
    setTty(true);
    await allowCommand.run(["dbt.execute"]);
    const output = (await allowCommand.run(["dbt.execute"])) as Record<string, unknown>;
    expect(output.note).toBe("already granted (no-op)");
  });

  it("revokes without a terminal and treats a missing grant as a no-op", async () => {
    setTty(true);
    await allowCommand.run(["dbt.execute"]);
    setTty(undefined);
    const revoked = (await allowCommand.run(["dbt.execute", "--revoke"])) as Record<string, unknown>;
    expect(revoked.granted).toBe(false);
    expect(readGrants()).toEqual(new Set());
    const again = (await allowCommand.run(["dbt.execute", "--revoke"])) as Record<string, unknown>;
    expect(again.note).toBe("was not granted (no-op)");
  });
});

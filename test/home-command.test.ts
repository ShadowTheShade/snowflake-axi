import { beforeEach, describe, expect, it, vi } from "vitest";

const runQuery = vi.hoisted(() => vi.fn());
vi.mock("../src/snowflake.js", () => ({ runQuery }));
const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("../src/config.js", () => ({ loadConfig }));

import { homeView } from "../src/commands/home.js";

const SESSION = {
  ACCOUNT: "MYACCT",
  USER: "SVC_USER",
  ROLE: "ANALYST",
  WAREHOUSE: "DEV_WH",
  DATABASE: "SCOOPS_DB",
  SCHEMA: "PUBLIC",
};

function stub(databaseCount: number) {
  runQuery.mockImplementation((sql: string) => {
    if (sql.includes("CURRENT_ACCOUNT()")) return Promise.resolve({ rows: [SESSION], total: 1 });
    if (sql === "SHOW DATABASES") {
      const rows = Array.from({ length: databaseCount }, (_, i) => ({ name: `DB_${String(i).padStart(3, "0")}` }));
      return Promise.resolve({ rows, total: rows.length });
    }
    return Promise.reject(new Error(`unexpected statement: ${sql}`));
  });
}

beforeEach(() => {
  runQuery.mockReset();
  loadConfig.mockReturnValue({ account: "fallback-acct", user: "fallback-user" });
});

describe("home view", () => {
  it("shows connection context, all databases, and next-step help", async () => {
    stub(3);
    const output = await homeView([]);
    expect(output.connection).toEqual({
      account: "MYACCT",
      user: "SVC_USER",
      role: "ANALYST",
      warehouse: "DEV_WH",
      default: "SCOOPS_DB.PUBLIC",
    });
    expect(output.count).toBeUndefined();
    expect(output.databases).toHaveLength(3);
    const help = output.help as string[];
    expect(help.some((line) => line.includes("tables"))).toBe(true);
    expect(help.some((line) => line.includes("query"))).toBe(true);
    expect(help.some((line) => line.includes("semantics"))).toBe(true);
    expect(help.some((line) => line.includes("find"))).toBe(true);
  });

  it("caps the database list and reveals the truncation", async () => {
    stub(120);
    const output = await homeView([]);
    expect(output.count).toBe("120 databases, first 100 shown");
    expect(output.databases).toHaveLength(100);
    expect((output.help as string[])[0]).toContain('query "SHOW DATABASES" --limit 120');
  });

  it("appends plugin help lines after the core suggestions", async () => {
    stub(1);
    const output = await homeView(["Run `snowflake-axi mycmd` to do domain things"]);
    const help = output.help as string[];
    expect(help[help.length - 1]).toContain("mycmd");
  });
});

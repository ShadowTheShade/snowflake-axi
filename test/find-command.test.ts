import { beforeEach, describe, expect, it, vi } from "vitest";

const runQuery = vi.hoisted(() => vi.fn());
vi.mock("../src/snowflake.js", () => ({ runQuery }));

import { findCommand } from "../src/commands/find.js";

const SHOW_ROWS = [
  {
    name: "TABLES",
    database_name: "SCOOPS_DB",
    schema_name: "INFORMATION_SCHEMA",
    kind: "VIEW",
    rows: null,
    bytes: null,
  },
  {
    name: "FCT_FLAVOR_SALES",
    database_name: "SCOOPS_DB",
    schema_name: "FACTS",
    kind: "TABLE",
    rows: "5077540",
    bytes: "165750784",
  },
  { name: "V_FLAVOR_RANKS", database_name: "SCOOPS_DB", schema_name: "PUBLIC", kind: "VIEW", rows: null, bytes: null },
  {
    name: "DIM_FLAVORS",
    database_name: "SCOOPS_DB",
    schema_name: "PUBLIC",
    kind: "TABLE",
    rows: "200",
    bytes: "13312",
  },
];

beforeEach(() => {
  runQuery.mockReset();
});

describe("find command", () => {
  it("searches account-wide, largest first, hiding INFORMATION_SCHEMA noise", async () => {
    runQuery.mockResolvedValueOnce({ rows: SHOW_ROWS, total: 4 });
    const output = (await findCommand.run(["flavor"])) as Record<string, unknown>;
    expect(runQuery.mock.calls[0][0]).toBe("SHOW OBJECTS LIKE '%FLAVOR%' IN ACCOUNT");
    expect(output.count).toBe("3 objects match '%FLAVOR%' account-wide, largest first");
    expect(output.objects).toEqual([
      { name: "SCOOPS_DB.FACTS.FCT_FLAVOR_SALES", kind: "TABLE", rows: 5077540, size: "158MB" },
      { name: "SCOOPS_DB.PUBLIC.DIM_FLAVORS", kind: "TABLE", rows: 200, size: "13KB" },
      { name: "SCOOPS_DB.PUBLIC.V_FLAVOR_RANKS", kind: "VIEW", rows: "", size: "" },
    ]);
    expect((output.help as string[])[0]).toContain("schema <db.schema.table>");
  });

  it("passes explicit wildcards through unchanged", async () => {
    runQuery.mockResolvedValueOnce({ rows: [], total: 0 });
    const output = (await findCommand.run(["FCT_%"])) as Record<string, unknown>;
    expect(runQuery.mock.calls[0][0]).toBe("SHOW OBJECTS LIKE 'FCT_%' IN ACCOUNT");
    expect(output.count).toBe("0 tables or views match 'FCT_%' account-wide with this role");
  });

  it("truncates at --limit with a see-all hint", async () => {
    runQuery.mockResolvedValueOnce({ rows: SHOW_ROWS, total: 4 });
    const output = (await findCommand.run(["flavor", "--limit", "1"])) as Record<string, unknown>;
    expect(output.objects).toHaveLength(1);
    expect((output.help as string[])[0]).toBe("Run `snowflake-axi find flavor --limit 3` for all 3");
  });

  it("rejects unsafe patterns before touching the connection", async () => {
    await expect(findCommand.run(["fla'vor"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(findCommand.run(["a b"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("requires exactly one pattern", async () => {
    await expect(findCommand.run([])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runQuery).not.toHaveBeenCalled();
  });
});

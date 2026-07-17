import { beforeEach, describe, expect, it, vi } from "vitest";

const runQuery = vi.hoisted(() => vi.fn());
vi.mock("../src/snowflake.js", () => ({ runQuery }));

import { semanticsCommand } from "../src/commands/semantics.js";

const SHOW_ROWS = [
  { name: "SCOOPS_ANALYTICS_SV", database_name: "SCOOPS_DB", schema_name: "PUBLIC", comment: "Sales metric map" },
  { name: "TOPPINGS_SV", database_name: "SCOOPS_DB", schema_name: "PUBLIC", comment: "" },
];

function descRow(kind: string, name: string, parent: string, property: string, value: string) {
  return { object_kind: kind, object_name: name, parent_entity: parent, property, property_value: value };
}

const DESC_ROWS = [
  descRow("", "", "", "COMMENT", "Sales metric map"),
  descRow("CUSTOM_INSTRUCTION", "", "", "AI_SQL_GENERATION", "NEVER derive growth by shifting PERIOD."),
  descRow("TABLE", "ORDERS", "", "BASE_TABLE_DATABASE_NAME", "SCOOPS_DB"),
  descRow("TABLE", "ORDERS", "", "BASE_TABLE_SCHEMA_NAME", "PUBLIC"),
  descRow("TABLE", "ORDERS", "", "BASE_TABLE_NAME", "FCT_ORDERS"),
  descRow("TABLE", "ORDERS", "", "COMMENT", "One row per scoop sold"),
  descRow("DIMENSION", "FLAVOR", "ORDERS", "EXPRESSION", "FLAVOR_NAME"),
  descRow("DIMENSION", "FLAVOR", "ORDERS", "SYNONYMS", '["flavour","variety"]'),
  descRow("METRIC", "TOTAL_REVENUE", "ORDERS", "EXPRESSION", "SUM(ORDER_TOTAL)"),
  descRow("METRIC", "TOTAL_REVENUE", "ORDERS", "COMMENT", "Gross revenue in USD"),
  descRow("AI_VERIFIED_QUERY", "TOP_FLAVORS_BY_MONTH", "", "QUESTION", "Which flavors sold best each month?"),
  descRow("AI_VERIFIED_QUERY", "TOP_FLAVORS_BY_MONTH", "", "VERIFIED_BY", "ALICE"),
  descRow("AI_VERIFIED_QUERY", "TOP_FLAVORS_BY_MONTH", "", "SQL", "SELECT flavor, month, SUM(qty) FROM ..."),
];

function stubQueries() {
  runQuery.mockImplementation(async (sql: string) => {
    if (sql === "SHOW SEMANTIC VIEWS IN ACCOUNT") return { rows: SHOW_ROWS, total: SHOW_ROWS.length };
    if (sql.startsWith("DESC SEMANTIC VIEW")) return { rows: DESC_ROWS, total: DESC_ROWS.length };
    throw new Error(`unexpected statement: ${sql}`);
  });
}

beforeEach(() => {
  runQuery.mockReset();
  stubQueries();
});

describe("semantics list", () => {
  it("lists semantic views account-wide with comments", async () => {
    const output = (await semanticsCommand.run([])) as Record<string, unknown>;
    expect(output.count).toBe("2 semantic views");
    expect(output.views).toEqual([
      { name: "SCOOPS_DB.PUBLIC.SCOOPS_ANALYTICS_SV", comment: "Sales metric map" },
      { name: "SCOOPS_DB.PUBLIC.TOPPINGS_SV" },
    ]);
    expect((output.help as string[])[0]).toContain("semantics <name>");
  });

  it("filters with --like and reports empty definitively", async () => {
    const output = (await semanticsCommand.run(["--like", "toppings"])) as Record<string, unknown>;
    expect(output.views).toEqual([{ name: "SCOOPS_DB.PUBLIC.TOPPINGS_SV" }]);
    const none = (await semanticsCommand.run(["--like", "nope"])) as Record<string, unknown>;
    expect(none.count).toBe("0 semantic views matching '%nope%' visible to this role");
  });
});

describe("semantics describe", () => {
  it("resolves a bare name account-wide and pivots the map", async () => {
    const output = (await semanticsCommand.run(["scoops_analytics_sv"])) as Record<string, unknown>;
    expect(output.view).toBe("SCOOPS_DB.PUBLIC.SCOOPS_ANALYTICS_SV");
    expect(output.comment).toBe("Sales metric map");
    expect(output.instructions).toEqual(["NEVER derive growth by shifting PERIOD."]);
    expect(output.tables).toEqual([
      { alias: "ORDERS", base: "SCOOPS_DB.PUBLIC.FCT_ORDERS", comment: "One row per scoop sold" },
    ]);
    expect(output.dimensions).toEqual([{ name: "FLAVOR", table: "ORDERS", expression: "FLAVOR_NAME" }]);
    expect(output.metrics).toEqual([
      { name: "TOTAL_REVENUE", table: "ORDERS", expression: "SUM(ORDER_TOTAL)", comment: "Gross revenue in USD" },
    ]);
    expect(output.verified_queries).toEqual([
      { name: "TOP_FLAVORS_BY_MONTH", question: "Which flavors sold best each month?" },
    ]);
    expect((output.help as string[])[0]).toContain("SEMANTIC_VIEW(SCOOPS_DB.PUBLIC.SCOOPS_ANALYTICS_SV METRICS");
  });

  it("skips the account search for fully qualified names", async () => {
    await semanticsCommand.run(["SCOOPS_DB.PUBLIC.TOPPINGS_SV"]);
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(runQuery.mock.calls[0][0]).toBe("DESC SEMANTIC VIEW SCOOPS_DB.PUBLIC.TOPPINGS_SV");
  });

  it("reports unknown names definitively", async () => {
    const output = (await semanticsCommand.run(["nope_sv"])) as Record<string, unknown>;
    expect(output.count).toBe("0 semantic views named 'NOPE_SV' in account");
  });

  it("extracts one verified query's SQL untruncated", async () => {
    const output = (await semanticsCommand.run(["scoops_analytics_sv", "--sql", "top_flavors_by_month"])) as Record<
      string,
      unknown
    >;
    expect(output).toEqual({
      view: "SCOOPS_DB.PUBLIC.SCOOPS_ANALYTICS_SV",
      query: "TOP_FLAVORS_BY_MONTH",
      question: "Which flavors sold best each month?",
      verified_by: "ALICE",
      sql: "SELECT flavor, month, SUM(qty) FROM ...",
    });
  });

  it("fails loud on an unknown verified query", async () => {
    await expect(semanticsCommand.run(["scoops_analytics_sv", "--sql", "nope"])).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("semantics flag validation", () => {
  it("filters a view's elements and questions with --like", async () => {
    const output = (await semanticsCommand.run(["scoops_analytics_sv", "--like", "flavor"])) as Record<string, unknown>;
    expect(output.dimensions).toEqual([{ name: "FLAVOR", table: "ORDERS", expression: "FLAVOR_NAME" }]);
    expect(output.metrics).toBeUndefined();
    expect(output.verified_queries).toEqual([
      { name: "TOP_FLAVORS_BY_MONTH", question: "Which flavors sold best each month?" },
    ]);
    const none = (await semanticsCommand.run(["scoops_analytics_sv", "--like", "nope"])) as Record<string, unknown>;
    expect(none.count).toBe("0 elements match 'nope' in SCOOPS_DB.PUBLIC.SCOOPS_ANALYTICS_SV");
  });

  it("rejects --sql without a name before querying", async () => {
    await expect(semanticsCommand.run(["--sql", "x"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("rejects malformed names", async () => {
    await expect(semanticsCommand.run(["a.b"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(semanticsCommand.run(["bad-name"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(runQuery).not.toHaveBeenCalled();
  });
});

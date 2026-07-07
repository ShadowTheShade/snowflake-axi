import { describe, expect, it } from "vitest";

import { resolveTableName } from "../src/names.js";

describe("resolveTableName", () => {
  it("keeps names as qualified as given, leaving the rest to the session", () => {
    expect(resolveTableName("fct_orders")).toEqual({
      database: undefined,
      schema: undefined,
      table: "FCT_ORDERS",
      fqn: "FCT_ORDERS",
    });
    expect(resolveTableName("sales.fct_daily")).toEqual({
      database: undefined,
      schema: "SALES",
      table: "FCT_DAILY",
      fqn: "SALES.FCT_DAILY",
    });
    expect(resolveTableName("OTHER_DB.S.T")).toEqual({
      database: "OTHER_DB",
      schema: "S",
      table: "T",
      fqn: "OTHER_DB.S.T",
    });
  });

  it("rejects malformed names", () => {
    expect(() => resolveTableName("a.b.c.d")).toThrow(/Invalid table name/);
    expect(() => resolveTableName("bad-name")).toThrow(/Invalid table name/);
    expect(() => resolveTableName("t; DROP")).toThrow(/Invalid table name/);
  });
});

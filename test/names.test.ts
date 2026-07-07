import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  loadConfig,
  envFilePath: () => "/tmp/env",
}));

import { resolveTableName } from "../src/names.js";

beforeEach(() => {
  loadConfig.mockReset();
  loadConfig.mockReturnValue({ database: "ANALYTICS_DB", schema: "PUBLIC", modelDirs: [] });
});

describe("resolveTableName", () => {
  it("resolves bare, schema-qualified, and fully qualified names", () => {
    expect(resolveTableName("fct_orders").fqn).toBe("ANALYTICS_DB.PUBLIC.FCT_ORDERS");
    expect(resolveTableName("sales.fct_daily").fqn).toBe("ANALYTICS_DB.SALES.FCT_DAILY");
    expect(resolveTableName("OTHER_DB.S.T").fqn).toBe("OTHER_DB.S.T");
  });

  it("rejects malformed names", () => {
    expect(() => resolveTableName("a.b.c.d")).toThrow(/Invalid table name/);
    expect(() => resolveTableName("bad-name")).toThrow(/Invalid table name/);
    expect(() => resolveTableName("t; DROP")).toThrow(/Invalid table name/);
  });

  it("requires defaults for unqualified names", () => {
    loadConfig.mockReturnValue({ modelDirs: [] });
    expect(() => resolveTableName("fct_orders")).toThrow(/without a default database/);
    expect(resolveTableName("DB.S.T").fqn).toBe("DB.S.T");
  });
});

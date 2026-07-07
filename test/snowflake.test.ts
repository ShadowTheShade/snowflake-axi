import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadConfig: () => ({
    account: "MY_ORG-MY_ACCOUNT",
    user: "SVC",
    token: "the-pat",
    role: "READER",
    database: "DB",
    schema: "PUBLIC",
    modelDirs: [],
  }),
}));

import { fetchStatementResult, runQuery } from "../src/snowflake.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function okResult(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse(200, {
    statementHandle: "h1",
    resultSetMetaData: {
      numRows: 2,
      partitionInfo: [{ rowCount: 2 }],
      rowType: [
        { name: "A", type: "fixed" },
        { name: "B", type: "text" },
      ],
    },
    data: [
      ["1", "x"],
      ["2", null],
    ],
    ...overrides,
  });
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("runQuery over the SQL API", () => {
  it("posts one statement with full context and returns decoded rows", async () => {
    fetchMock.mockResolvedValueOnce(okResult());
    const { rows, total, numericColumns } = await runQuery("SELECT 1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^https:\/\/MY-ORG-MY-ACCOUNT\.snowflakecomputing\.com\/api\/v2\/statements\?requestId=/);
    expect(init.headers.authorization).toBe("Bearer the-pat");
    expect(init.headers["x-snowflake-authorization-token-type"]).toBe("PROGRAMMATIC_ACCESS_TOKEN");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ statement: "SELECT 1", role: "READER", database: "DB" });
    expect(rows).toEqual([
      { A: "1", B: "x" },
      { A: "2", B: null },
    ]);
    expect(total).toBe(2);
    expect(numericColumns).toEqual(new Set(["A"]));
  });

  it("maps binds and timeout into the request body", async () => {
    fetchMock.mockResolvedValueOnce(okResult());
    await runQuery("SELECT ?", { binds: ["PUBLIC", 5], timeoutSeconds: 30 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.timeout).toBe(30);
    expect(body.bindings).toEqual({
      "1": { type: "TEXT", value: "PUBLIC" },
      "2": { type: "FIXED", value: "5" },
    });
  });

  it("omits unset context so Snowflake user defaults apply", async () => {
    fetchMock.mockResolvedValueOnce(okResult());
    await runQuery("SELECT 1");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect("timeout" in body).toBe(false);
    expect("bindings" in body).toBe(false);
    expect("warehouse" in body).toBe(false);
    expect(body.role).toBe("READER");
  });

  it("passes a one-off warehouse switch through to the request", async () => {
    fetchMock.mockResolvedValueOnce(okResult());
    await runQuery("SELECT 1", { warehouse: "BIG_WH" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).warehouse).toBe("BIG_WH");
  });

  it("prefers a one-off role switch over the configured role", async () => {
    fetchMock.mockResolvedValueOnce(okResult());
    await runQuery("SELECT 1", { role: "OTHER_ROLE" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).role).toBe("OTHER_ROLE");
  });

  it("fetches only the partitions maxRows needs while reporting the full total", async () => {
    fetchMock
      .mockResolvedValueOnce(
        okResult({
          resultSetMetaData: {
            numRows: 6,
            partitionInfo: [{ rowCount: 2 }, { rowCount: 2 }, { rowCount: 2 }],
            rowType: [{ name: "N", type: "fixed" }],
          },
          data: [["1"], ["2"]],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { data: [["3"], ["4"]] }));
    const { rows, total } = await runQuery("SELECT N", { maxRows: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain("/api/v2/statements/h1?partition=1");
    expect(rows).toEqual([{ N: "1" }, { N: "2" }, { N: "3" }]);
    expect(total).toBe(6);
  });

  it("decodes jsonv2 temporal wire formats to readable text", async () => {
    fetchMock.mockResolvedValueOnce(
      okResult({
        resultSetMetaData: {
          numRows: 1,
          partitionInfo: [{ rowCount: 1 }],
          rowType: [
            { name: "D", type: "date" },
            { name: "T", type: "time" },
            { name: "NTZ", type: "timestamp_ntz" },
            { name: "LTZ", type: "timestamp_ltz" },
            { name: "TZ", type: "timestamp_tz" },
          ],
        },
        data: [
          ["20641", "34245.500000000", "1783416600.123000000", "1783431000.000000000", "1783434600.000000000 1140"],
        ],
      }),
    );
    const { rows } = await runQuery("SELECT ...");
    expect(rows[0]).toEqual({
      D: "2026-07-07",
      T: "09:30:45.5",
      NTZ: "2026-07-07 09:30:00.123",
      LTZ: "2026-07-07 13:30:00Z",
      TZ: "2026-07-07 09:30:00-05:00",
    });
  });

  it("translates SQL errors with a schema-lookup suggestion", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, { code: "000904", message: "SQL compilation error:\ninvalid identifier 'NOPE'" }),
    );
    await expect(runQuery("SELECT NOPE")).rejects.toMatchObject({
      code: "SNOWFLAKE_ERROR",
      suggestions: ["Run `snowflake-axi schema <table>` to check the column names"],
    });
  });

  it("suggests DEFAULT_NAMESPACE when the session has no current database", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, {
        code: "090105",
        message:
          "Unable to run the SELECT command. You must specify the database to use by either setting the database field in the body of the request or by setting the DEFAULT_NAMESPACE property for the current user.",
      }),
    );
    await expect(runQuery("SELECT 1")).rejects.toMatchObject({
      code: "SNOWFLAKE_ERROR",
      message: "The session has no default database/schema, so unqualified names cannot resolve",
      suggestions: [
        "Qualify the name as db.schema.table",
        "Or give the user a durable default: ALTER USER <user> SET DEFAULT_NAMESPACE = '<db>.<schema>'",
      ],
    });
  });

  it("translates auth failures by status", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { message: "Invalid token" }));
    await expect(runQuery("SELECT 1")).rejects.toMatchObject({ code: "AUTH_ERROR" });
  });

  it("translates a role refused for the token with the ROLE_RESTRICTION hint", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, {
        code: "390189",
        message:
          "Role 'ANALYTICS_ROLE' specified in the connect string is not granted to this user, or is not permitted for the credentials being used. Contact your local system administrator, or attempt to login with another role, e.g. PUBLIC.",
      }),
    );
    await expect(runQuery("SELECT 1", { role: "ANALYTICS_ROLE" })).rejects.toMatchObject({
      code: "SNOWFLAKE_ERROR",
      message: "Snowflake refused the requested role for this token",
      suggestions: [
        "The role must be granted to the service user: SHOW GRANTS TO USER <user>",
        "A token minted with ROLE_RESTRICTION is pinned to that role; role switching needs a PAT minted without it",
      ],
    });
  });

  it("translates timeouts with a --timeout hint", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(408, {
        code: "000630",
        message: "Statement reached its statement or warehouse timeout of 1 second(s) and was canceled.",
      }),
    );
    await expect(runQuery("SELECT 1", { timeoutSeconds: 1 })).rejects.toMatchObject({
      code: "TIMEOUT",
      suggestions: ["Rerun with a higher --timeout <seconds> or narrow the query"],
    });
  });

  it("retries a transient failure once, idempotently", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, {})).mockResolvedValueOnce(okResult());
    const { total } = await runQuery("SELECT 1");
    expect(total).toBe(2);
    expect(fetchMock.mock.calls[1][0]).toContain("&retry=true");
    const [first, second] = fetchMock.mock.calls.map(([url]) => new URL(url).searchParams.get("requestId"));
    expect(second).toBe(first);
  });

  it("reports unreachable hosts as CONNECTION_ERROR after the retry", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(runQuery("SELECT 1")).rejects.toMatchObject({ code: "CONNECTION_ERROR" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("polls a 202 until the statement completes", async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(202, { statementStatusUrl: "/api/v2/statements/h1?requestId=r" }))
        .mockResolvedValueOnce(jsonResponse(202, { statementStatusUrl: "/api/v2/statements/h1?requestId=r" }))
        .mockResolvedValueOnce(okResult());
      const promise = runQuery("SELECT SLOW()");
      await vi.advanceTimersByTimeAsync(1100);
      const { total } = await promise;
      expect(total).toBe(2);
      expect(fetchMock.mock.calls[1][0]).toBe(
        "https://MY-ORG-MY-ACCOUNT.snowflakecomputing.com/api/v2/statements/h1?requestId=r",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits a recovery handle to stderr once polling runs long", async () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      fetchMock.mockImplementation(async () =>
        jsonResponse(202, { statementHandle: "h9", statementStatusUrl: "/api/v2/statements/h9?requestId=r" }),
      );
      const promise = runQuery("SELECT SLOW()");
      await vi.advanceTimersByTimeAsync(10_600);
      expect(stderr).toHaveBeenCalledOnce();
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("snowflake-axi result h9"));
      fetchMock.mockImplementation(async () => okResult());
      await vi.advanceTimersByTimeAsync(600);
      const { total } = await promise;
      expect(total).toBe(2);
      expect(stderr).toHaveBeenCalledOnce();
    } finally {
      stderr.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("fetchStatementResult", () => {
  it("fetches a completed statement by handle without resubmitting", async () => {
    fetchMock.mockResolvedValueOnce(okResult());
    const result = await fetchStatementResult("h1", { maxRows: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://MY-ORG-MY-ACCOUNT.snowflakecomputing.com/api/v2/statements/h1");
    expect(init.method).toBeUndefined();
    expect("rows" in result && result.rows).toEqual([{ A: "1", B: "x" }]);
    expect("total" in result && result.total).toBe(2);
  });

  it("reports a still-executing statement as running", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(202, { statementStatusUrl: "/api/v2/statements/h1?requestId=r" }));
    await expect(fetchStatementResult("h1")).resolves.toEqual({ running: true, handle: "h1" });
  });

  it("translates an expired handle with a rerun suggestion", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(422, { message: "Statement 01b66701 not found" }));
    await expect(fetchStatementResult("01b66701")).rejects.toMatchObject({
      code: "SNOWFLAKE_ERROR",
      suggestions: [expect.stringContaining("24 hours")],
    });
  });
});

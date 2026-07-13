import { AxiError } from "axi-sdk-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadConfig: () => ({
    account: "MY_ORG-MY_ACCOUNT",
    user: "ALICE",
    auth: "oauth",
    modelDirs: [],
  }),
}));

const currentAccessToken = vi.hoisted(() => vi.fn());
const refreshedAccessToken = vi.hoisted(() => vi.fn());
vi.mock("../src/oauth.js", () => ({ currentAccessToken, refreshedAccessToken, hasLogin: vi.fn() }));

import { runQuery } from "../src/snowflake.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function okResult(): Response {
  return jsonResponse(200, {
    statementHandle: "h1",
    resultSetMetaData: {
      numRows: 1,
      partitionInfo: [{ rowCount: 1 }],
      rowType: [{ name: "A", type: "text" }],
    },
    data: [["x"]],
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  currentAccessToken.mockReset();
  refreshedAccessToken.mockReset();
});

describe("runQuery in OAuth mode", () => {
  it("sends the access token with the OAUTH token type", async () => {
    currentAccessToken.mockResolvedValue("access-1");
    fetchMock.mockResolvedValueOnce(okResult());
    const { rows } = await runQuery("SELECT 1");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.authorization).toBe("Bearer access-1");
    expect(init.headers["x-snowflake-authorization-token-type"]).toBe("OAUTH");
    expect(rows).toEqual([{ A: "x" }]);
  });

  it("refreshes once after a 401 and retries with the new token", async () => {
    currentAccessToken.mockResolvedValueOnce("stale").mockResolvedValueOnce("fresh");
    refreshedAccessToken.mockResolvedValue("fresh");
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { message: "Invalid token" })).mockResolvedValueOnce(okResult());
    const { rows } = await runQuery("SELECT 1");
    expect(refreshedAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBe("Bearer fresh");
    expect(rows).toEqual([{ A: "x" }]);
  });

  it("surfaces the re-login error when the forced refresh fails", async () => {
    currentAccessToken.mockResolvedValue("stale");
    refreshedAccessToken.mockRejectedValue(
      new AxiError("The OAuth session has expired or was revoked", "AUTH_ERROR", [
        "Run `snowflake-axi login` to sign in again",
      ]),
    );
    fetchMock.mockResolvedValue(jsonResponse(401, { message: "Invalid token" }));
    await expect(runQuery("SELECT 1")).rejects.toMatchObject({
      code: "AUTH_ERROR",
      message: "The OAuth session has expired or was revoked",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("selects the requested role's login from the token ring", async () => {
    currentAccessToken.mockResolvedValue("reporter-access");
    fetchMock.mockResolvedValueOnce(okResult());
    await runQuery("SELECT 1", { role: "REPORTER" });
    expect(currentAccessToken).toHaveBeenCalledWith("REPORTER");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.role).toBe("REPORTER");
  });

  it("retries a 401 with a refresh of the requested role's login", async () => {
    currentAccessToken.mockResolvedValue("stale");
    refreshedAccessToken.mockResolvedValue("fresh");
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { message: "Invalid token" })).mockResolvedValueOnce(okResult());
    await runQuery("SELECT 1", { role: "REPORTER" });
    expect(refreshedAccessToken).toHaveBeenCalledWith("REPORTER");
  });

  it("explains the per-role logins when a role is refused", async () => {
    currentAccessToken.mockResolvedValue("access-1");
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        code: "390189",
        message:
          "Role 'OTHER' specified in the connect string is not granted to this user, or is not permitted for the credentials being used.",
      }),
    );
    await expect(runQuery("SELECT 1", { role: "OTHER" })).rejects.toMatchObject({
      code: "SNOWFLAKE_ERROR",
      suggestions: [
        "Each OAuth login is pinned to one role, and per-query --role uses the login for that role",
        "Run `snowflake-axi login --role <name>` once to add that role's login to the ring",
      ],
    });
  });

  it("does not refresh on non-auth failures", async () => {
    currentAccessToken.mockResolvedValue("access-1");
    fetchMock.mockResolvedValueOnce(jsonResponse(422, { message: "SQL compilation error" }));
    await expect(runQuery("SELECT nope")).rejects.toMatchObject({ code: "SNOWFLAKE_ERROR" });
    expect(refreshedAccessToken).not.toHaveBeenCalled();
  });
});

import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

interface TokenFileOverrides {
  accessTokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
}

function tokenFile(overrides: TokenFileOverrides = {}) {
  return {
    account: "MY_ORG-MY_ACCOUNT",
    clientId: "client-id",
    user: "ALICE",
    accessToken: "live-access",
    accessTokenExpiresAt: Date.now() + 600_000,
    refreshToken: "the-refresh",
    refreshTokenExpiresAt: Date.now() + 86_400_000,
    ...overrides,
  };
}

let configHome: string;

function writeTokens(overrides: TokenFileOverrides = {}): string {
  const path = join(configHome, "snowflake-axi", "oauth-tokens.json");
  writeFileSync(path, JSON.stringify(tokenFile(overrides)));
  return path;
}

async function freshOAuth() {
  vi.resetModules();
  return import("../src/oauth.js");
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), "axi-oauth-"));
  mkdirSync(join(configHome, "snowflake-axi"));
  vi.stubEnv("XDG_CONFIG_HOME", configHome);
  vi.stubEnv("SNOWFLAKE_HOME", "/nonexistent");
  fetchMock.mockReset();
  spawnMock.mockReset();
  spawnMock.mockReturnValue({ on: vi.fn(), unref: vi.fn() });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("currentAccessToken", () => {
  it("returns the stored token without any request while it is fresh", async () => {
    writeTokens();
    const { currentAccessToken } = await freshOAuth();
    await expect(currentAccessToken()).resolves.toBe("live-access");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes silently inside the expiry margin and persists the new token", async () => {
    const path = writeTokens({ accessTokenExpiresAt: Date.now() + 30_000 });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { access_token: "fresh-access", expires_in: 600 }));
    const { currentAccessToken } = await freshOAuth();
    await expect(currentAccessToken()).resolves.toBe("fresh-access");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://MY-ORG-MY-ACCOUNT.snowflakecomputing.com/oauth/token-request");
    const form = new URLSearchParams(init.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("the-refresh");
    expect(form.get("client_id")).toBe("client-id");

    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.accessToken).toBe("fresh-access");
    expect(saved.refreshToken).toBe("the-refresh");
    expect(saved.user).toBe("ALICE");
  });

  it("serializes concurrent refreshes into one token request", async () => {
    writeTokens({ accessTokenExpiresAt: Date.now() - 1000 });
    fetchMock.mockResolvedValue(jsonResponse(200, { access_token: "fresh-access", expires_in: 600 }));
    const { currentAccessToken } = await freshOAuth();
    const tokens = await Promise.all([currentAccessToken(), currentAccessToken(), currentAccessToken()]);
    expect(tokens).toEqual(["fresh-access", "fresh-access", "fresh-access"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks for a re-login when the refresh token has expired, without a request", async () => {
    writeTokens({ accessTokenExpiresAt: Date.now() - 1000, refreshTokenExpiresAt: Date.now() - 1000 });
    const { currentAccessToken } = await freshOAuth();
    await expect(currentAccessToken()).rejects.toMatchObject({
      code: "AUTH_ERROR",
      suggestions: ["Run `snowflake-axi login` to sign in again"],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks for a re-login when Snowflake rejects the refresh token", async () => {
    writeTokens({ accessTokenExpiresAt: Date.now() - 1000 });
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: "invalid_grant" }));
    const { currentAccessToken } = await freshOAuth();
    await expect(currentAccessToken()).rejects.toMatchObject({
      code: "AUTH_ERROR",
      message: "The OAuth session has expired or was revoked",
    });
  });

  it("asks for a login when no token file exists", async () => {
    const { currentAccessToken } = await freshOAuth();
    await expect(currentAccessToken()).rejects.toMatchObject({
      code: "AUTH_ERROR",
      suggestions: ["Run `snowflake-axi login` to sign in with the browser"],
    });
  });
});

function callback(query: string): Promise<number> {
  return new Promise((resolve, reject) => {
    get(`http://localhost:8976/callback?${query}`, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on("error", reject);
  });
}

async function browserUrl(): Promise<URL> {
  for (let i = 0; i < 200; i++) {
    if (spawnMock.mock.calls.length > 0) return new URL(spawnMock.mock.calls[0][1][0]);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("browser was never opened");
}

describe("login", () => {
  const stderr = () => vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  it("runs the PKCE flow end to end and writes a 0600 token file", async () => {
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "MY_ORG-MY_ACCOUNT");
    vi.stubEnv("SNOWFLAKE_OAUTH_CLIENT_ID", "client-id");
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        access_token: "new-access",
        expires_in: 600,
        refresh_token: "new-refresh",
        refresh_token_expires_in: 7_776_000,
        username: "ALICE",
      }),
    );
    const quiet = stderr();
    try {
      const { login } = await freshOAuth();
      const pending = login({ role: "REPORTER" });
      const url = await browserUrl();

      expect(url.origin).toBe("https://my-org-my-account.snowflakecomputing.com");
      expect(url.pathname).toBe("/oauth/authorize");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("client_id")).toBe("client-id");
      expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8976/callback");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("code_challenge")).toBeTruthy();
      expect(url.searchParams.get("scope")).toBe("session:role:REPORTER");
      const state = url.searchParams.get("state") ?? "";

      await expect(callback(`code=the-code&state=${encodeURIComponent(state)}`)).resolves.toBe(200);
      const tokens = await pending;

      const form = new URLSearchParams(fetchMock.mock.calls[0][1].body);
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("code")).toBe("the-code");
      expect(form.get("redirect_uri")).toBe("http://localhost:8976/callback");
      expect(form.get("client_id")).toBe("client-id");
      expect(form.get("code_verifier")).toBeTruthy();

      expect(tokens).toMatchObject({
        account: "MY_ORG-MY_ACCOUNT",
        user: "ALICE",
        accessToken: "new-access",
        refreshToken: "new-refresh",
        roleScope: "REPORTER",
      });
      const path = join(configHome, "snowflake-axi", "oauth-tokens.json");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, "utf8")).refreshToken).toBe("new-refresh");
    } finally {
      quiet.mockRestore();
    }
  });

  it("rejects a callback whose state does not match", async () => {
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "ACC");
    vi.stubEnv("SNOWFLAKE_OAUTH_CLIENT_ID", "client-id");
    const quiet = stderr();
    try {
      const { login } = await freshOAuth();
      const pending = login();
      const url = await browserUrl();
      expect(url.searchParams.get("scope")).toBeNull();
      const failure = expect(pending).rejects.toMatchObject({
        code: "AUTH_ERROR",
        message: "OAuth callback state mismatch",
      });
      await expect(callback("code=the-code&state=forged")).resolves.toBe(400);
      await failure;
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      quiet.mockRestore();
    }
  });

  it("surfaces an IdP denial from the callback", async () => {
    vi.stubEnv("SNOWFLAKE_ACCOUNT", "ACC");
    vi.stubEnv("SNOWFLAKE_OAUTH_CLIENT_ID", "client-id");
    const quiet = stderr();
    try {
      const { login } = await freshOAuth();
      const pending = login();
      await browserUrl();
      const failure = expect(pending).rejects.toMatchObject({
        code: "AUTH_ERROR",
        message: "Snowflake refused the login: User refused",
      });
      await expect(callback("error=access_denied&error_description=User+refused")).resolves.toBe(400);
      await failure;
    } finally {
      quiet.mockRestore();
    }
  });

  it("fails fast when the login settings are missing", async () => {
    const { login } = await freshOAuth();
    await expect(login()).rejects.toMatchObject({
      code: "CONFIG_ERROR",
      message: expect.stringContaining("SNOWFLAKE_OAUTH_CLIENT_ID"),
    });
  });
});

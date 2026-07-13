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

function tokenPath(): string {
  return join(configHome, "snowflake-axi", "oauth-tokens.json");
}

/** Pre-ring single-login shape, so these flows also prove the migration. */
function writeTokens(overrides: TokenFileOverrides = {}): string {
  writeFileSync(tokenPath(), JSON.stringify(tokenFile(overrides)));
  return tokenPath();
}

function writeRing(entries: Record<string, ReturnType<typeof tokenFile> & { roleScope?: string }>): string {
  writeFileSync(tokenPath(), JSON.stringify({ version: 2, entries }));
  return tokenPath();
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
    expect(saved.entries.default.accessToken).toBe("fresh-access");
    expect(saved.entries.default.refreshToken).toBe("the-refresh");
    expect(saved.entries.default.user).toBe("ALICE");
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

describe("token ring", () => {
  const ring = () => ({
    default: tokenFile(),
    REPORTER: { ...tokenFile(), accessToken: "reporter-access", roleScope: "REPORTER" },
  });

  it("selects the login for a requested role, case-insensitively", async () => {
    writeRing(ring());
    const { currentAccessToken } = await freshOAuth();
    await expect(currentAccessToken("reporter")).resolves.toBe("reporter-access");
    await expect(currentAccessToken()).resolves.toBe("live-access");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("points a missing role at login --role and lists the current logins", async () => {
    writeRing(ring());
    const { currentAccessToken } = await freshOAuth();
    await expect(currentAccessToken("OTHER")).rejects.toMatchObject({
      code: "AUTH_ERROR",
      message: "No OAuth login for role OTHER",
      suggestions: [
        "Run `snowflake-axi login --role OTHER` once to add it; each role keeps its own login",
        "Current logins: default, REPORTER",
      ],
    });
  });

  it("falls back to a sole role-pinned login when no role is asked for", async () => {
    writeRing({ REPORTER: { ...tokenFile(), accessToken: "reporter-access", roleScope: "REPORTER" } });
    const { currentAccessToken } = await freshOAuth();
    await expect(currentAccessToken()).resolves.toBe("reporter-access");
  });

  it("demands a role when several pinned logins exist and none is the default", async () => {
    writeRing({
      REPORTER: { ...tokenFile(), roleScope: "REPORTER" },
      BUILDER: { ...tokenFile(), roleScope: "BUILDER" },
    });
    const { currentAccessToken } = await freshOAuth();
    await expect(currentAccessToken()).rejects.toMatchObject({
      code: "AUTH_ERROR",
      suggestions: [
        "Pass --role with one of the logins: BUILDER, REPORTER",
        "Or run `snowflake-axi login` (no --role) to add a default-role login",
      ],
    });
  });

  it("refreshes each role's login independently and persists both", async () => {
    const stale = { accessTokenExpiresAt: Date.now() - 1000 };
    writeRing({
      default: { ...tokenFile(stale) },
      REPORTER: { ...tokenFile(stale), refreshToken: "reporter-refresh", roleScope: "REPORTER" },
    });
    fetchMock.mockImplementation(async (_url, init: RequestInit) => {
      const refresh = new URLSearchParams(String(init.body)).get("refresh_token");
      return jsonResponse(200, { access_token: `fresh-for-${refresh}`, expires_in: 600 });
    });
    const { currentAccessToken } = await freshOAuth();
    const [byDefault, byRole] = await Promise.all([currentAccessToken(), currentAccessToken("REPORTER")]);
    expect(byDefault).toBe("fresh-for-the-refresh");
    expect(byRole).toBe("fresh-for-reporter-refresh");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const saved = JSON.parse(readFileSync(tokenPath(), "utf8"));
    expect(saved.entries.default.accessToken).toBe("fresh-for-the-refresh");
    expect(saved.entries.REPORTER.accessToken).toBe("fresh-for-reporter-refresh");
    expect(saved.entries.REPORTER.roleScope).toBe("REPORTER");
  });

  it("names the pinned role in the re-login error for an expired role login", async () => {
    writeRing({
      REPORTER: {
        ...tokenFile({ accessTokenExpiresAt: Date.now() - 1000, refreshTokenExpiresAt: Date.now() - 1000 }),
        roleScope: "REPORTER",
      },
    });
    const { currentAccessToken } = await freshOAuth();
    await expect(currentAccessToken("REPORTER")).rejects.toMatchObject({
      code: "AUTH_ERROR",
      suggestions: ["Run `snowflake-axi login --role REPORTER` to sign in again"],
    });
  });

  it("reports login presence per role via hasLogin", async () => {
    writeRing(ring());
    const { hasLogin } = await freshOAuth();
    expect(hasLogin()).toBe(true);
    expect(hasLogin("reporter")).toBe(true);
    expect(hasLogin("OTHER")).toBe(false);
  });
});

describe("logout", () => {
  it("removes the token file outright when a single login exists", async () => {
    writeTokens();
    const { logout } = await freshOAuth();
    expect(logout()).toEqual({ removed: ["default"], remaining: [] });
    expect(() => statSync(tokenPath())).toThrow();
  });

  it("demands a choice when several logins exist", async () => {
    writeRing({ default: tokenFile(), REPORTER: { ...tokenFile(), roleScope: "REPORTER" } });
    const { logout } = await freshOAuth();
    expect(() => logout()).toThrow(
      expect.objectContaining({ code: "VALIDATION_ERROR", message: expect.stringContaining("Several logins") }),
    );
  });

  it("removes one role's login and keeps the rest", async () => {
    writeRing({ default: tokenFile(), REPORTER: { ...tokenFile(), roleScope: "REPORTER" } });
    const { logout } = await freshOAuth();
    expect(logout({ role: "reporter" })).toEqual({ removed: ["REPORTER"], remaining: ["default"] });
    const saved = JSON.parse(readFileSync(tokenPath(), "utf8"));
    expect(Object.keys(saved.entries)).toEqual(["default"]);
  });

  it("accepts `default` for the unscoped login and deletes an emptied file", async () => {
    writeRing({ default: tokenFile() });
    const { logout } = await freshOAuth();
    expect(logout({ role: "default" })).toEqual({ removed: ["default"], remaining: [] });
    expect(() => statSync(tokenPath())).toThrow();
  });

  it("removes everything with --all and fails definitively on unknown roles", async () => {
    writeRing({ default: tokenFile(), REPORTER: { ...tokenFile(), roleScope: "REPORTER" } });
    const { logout } = await freshOAuth();
    expect(() => logout({ role: "NOPE" })).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(logout({ all: true })).toEqual({ removed: ["default", "REPORTER"], remaining: [] });
    expect(() => statSync(tokenPath())).toThrow();
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

  it("runs the PKCE flow end to end, merging into a 0600 token ring", async () => {
    writeTokens();
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
      expect(statSync(tokenPath()).mode & 0o777).toBe(0o600);
      const saved = JSON.parse(readFileSync(tokenPath(), "utf8"));
      expect(saved.entries.REPORTER.refreshToken).toBe("new-refresh");
      // The pre-existing default login survives the role login.
      expect(saved.entries.default.refreshToken).toBe("the-refresh");
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

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { AxiError } from "axi-sdk-js";
import {
  accountUrl,
  type OAuthLoginSettings,
  type OAuthTokens,
  oauthLoginSettings,
  readOAuthTokens,
  writeOAuthTokens,
} from "./config.js";

// The redirect URI must byte-match the security integration's registered
// value, so the port is fixed rather than random.
const CALLBACK_PORT = 8976;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const LOGIN_TIMEOUT_MS = 300_000;
// Snowflake access tokens live ~600s; refreshing inside this margin keeps a
// token from expiring between the check and the statement it authorizes.
const REFRESH_MARGIN_MS = 60_000;
const DEFAULT_ACCESS_TTL_S = 600;

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  username?: string;
  error?: string;
  message?: string;
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function sessionExpired(): AxiError {
  return new AxiError("The OAuth session has expired or was revoked", "AUTH_ERROR", [
    "Run `snowflake-axi login` to sign in again",
  ]);
}

function notLoggedIn(): AxiError {
  return new AxiError("No OAuth login was found", "AUTH_ERROR", [
    "Run `snowflake-axi login` to sign in with the browser",
  ]);
}

async function tokenRequest(account: string, form: Record<string, string>): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetch(`${accountUrl(account)}/oauth/token-request`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "snowflake-axi" },
      body: new URLSearchParams(form).toString(),
    });
  } catch (err) {
    throw new AxiError(
      `Could not reach Snowflake for the OAuth token request: ${err instanceof Error ? err.message : String(err)}`,
      "CONNECTION_ERROR",
      ["Check the network connection and that SNOWFLAKE_ACCOUNT is the right account identifier"],
    );
  }
  let payload: TokenResponse = {};
  try {
    payload = (await response.json()) as TokenResponse;
  } catch {
    // Non-JSON error body; the status code carries the failure below.
  }
  if (!response.ok || !payload.access_token) {
    const detail = payload.message ?? payload.error ?? `HTTP ${response.status}`;
    throw new AxiError(`Snowflake refused the OAuth token request: ${detail}`, "AUTH_ERROR");
  }
  return payload;
}

// Best effort only: on failure the URL already printed to stderr covers
// headless machines and WSL without a registered browser handler.
function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    if (process.platform !== "linux") return;
    const fallback = spawn("wslview", [url], { stdio: "ignore", detached: true });
    fallback.on("error", () => {});
    fallback.unref();
  });
  child.unref();
}

function authorizationCode(authorizeUrl: string, state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const settle = (status: number, text: string, outcome: () => void) => {
        res.writeHead(status, { "content-type": "text/html", connection: "close" });
        res.end(`<html><body><p>${text}</p></body></html>`);
        clearTimeout(timer);
        server.close();
        // Keep-alive sockets would otherwise hold the port past close().
        server.closeAllConnections();
        outcome();
      };
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error) {
        const detail = url.searchParams.get("error_description") ?? error;
        settle(400, "Login failed; return to the terminal.", () =>
          reject(new AxiError(`Snowflake refused the login: ${detail}`, "AUTH_ERROR")),
        );
      } else if (url.searchParams.get("state") !== state || !code) {
        settle(400, "Login failed; return to the terminal.", () =>
          reject(new AxiError("OAuth callback state mismatch", "AUTH_ERROR", ["Retry `snowflake-axi login`"])),
        );
      } else {
        settle(200, "Login complete. You can close this tab.", () => resolve(code));
      }
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        err.code === "EADDRINUSE"
          ? new AxiError(`Port ${CALLBACK_PORT} is busy, so the login callback cannot listen`, "AUTH_ERROR", [
              `Stop whatever holds port ${CALLBACK_PORT} (another login in progress?) and retry`,
            ])
          : new AxiError(`Login callback listener failed: ${err.message}`, "AUTH_ERROR"),
      );
    });
    server.listen(CALLBACK_PORT, () => {
      timer = setTimeout(() => {
        server.close();
        reject(new AxiError("Timed out waiting for the browser login", "AUTH_ERROR", ["Retry `snowflake-axi login`"]));
      }, LOGIN_TIMEOUT_MS);
      process.stderr.write(`Opening the browser for Snowflake login; if nothing opens, visit:\n${authorizeUrl}\n`);
      openBrowser(authorizeUrl);
    });
  });
}

function toTokens(
  settings: OAuthLoginSettings,
  roleScope: string | undefined,
  payload: TokenResponse,
  previous?: OAuthTokens,
): OAuthTokens {
  const now = Date.now();
  const refreshToken = payload.refresh_token ?? previous?.refreshToken;
  if (!refreshToken) {
    throw new AxiError("Snowflake issued no refresh token", "AUTH_ERROR", [
      "Set OAUTH_ISSUE_REFRESH_TOKENS = TRUE on the security integration and log in again",
    ]);
  }
  return {
    account: settings.account,
    clientId: settings.clientId,
    user: payload.username ?? previous?.user ?? "(unknown)",
    accessToken: payload.access_token ?? "",
    accessTokenExpiresAt: now + (payload.expires_in ?? DEFAULT_ACCESS_TTL_S) * 1000,
    refreshToken,
    refreshTokenExpiresAt:
      payload.refresh_token_expires_in !== undefined
        ? now + payload.refresh_token_expires_in * 1000
        : (previous?.refreshTokenExpiresAt ?? now),
    ...(roleScope !== undefined ? { roleScope } : {}),
  };
}

/**
 * Browser authorization-code flow with PKCE: no client secret ships in the
 * tool, and the state nonce ties the callback to this process. Writes the
 * token file on success.
 */
export async function login(options: { role?: string } = {}): Promise<OAuthTokens> {
  const settings = oauthLoginSettings();
  const roleScope = options.role ?? settings.roleScope;
  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(16));

  const authorize = new URL(`${accountUrl(settings.account)}/oauth/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", settings.clientId);
  authorize.searchParams.set("redirect_uri", REDIRECT_URI);
  authorize.searchParams.set("code_challenge", base64url(createHash("sha256").update(verifier).digest()));
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", state);
  // session:role:<name> is the only session scope Snowflake OAuth accepts
  // (role-any is External OAuth only); unscoped tokens carry the default role.
  if (roleScope) authorize.searchParams.set("scope", `session:role:${roleScope}`);

  const code = await authorizationCode(authorize.toString(), state);
  const payload = await tokenRequest(settings.account, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    client_id: settings.clientId,
  });
  const tokens = toTokens(settings, roleScope, payload);
  writeOAuthTokens(tokens);
  return tokens;
}

let inflightRefresh: Promise<OAuthTokens> | undefined;

// Concurrent callers share one refresh so parallel statements cannot race
// the token file or spend the refresh grant twice.
function refreshTokens(tokens: OAuthTokens): Promise<OAuthTokens> {
  inflightRefresh ??= doRefresh(tokens).finally(() => {
    inflightRefresh = undefined;
  });
  return inflightRefresh;
}

async function doRefresh(tokens: OAuthTokens): Promise<OAuthTokens> {
  if (Date.now() >= tokens.refreshTokenExpiresAt) throw sessionExpired();
  let payload: TokenResponse;
  try {
    payload = await tokenRequest(tokens.account, {
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: tokens.clientId,
    });
  } catch (error) {
    if (error instanceof AxiError && error.code === "AUTH_ERROR") throw sessionExpired();
    throw error;
  }
  const updated = toTokens(tokens, tokens.roleScope, payload, tokens);
  writeOAuthTokens(updated);
  return updated;
}

/** A live access token, refreshed silently when within the expiry margin. */
export async function currentAccessToken(): Promise<string> {
  const tokens = readOAuthTokens();
  if (!tokens) throw notLoggedIn();
  if (Date.now() < tokens.accessTokenExpiresAt - REFRESH_MARGIN_MS) return tokens.accessToken;
  return (await refreshTokens(tokens)).accessToken;
}

/** Unconditional refresh, for the one retry after a 401. */
export async function refreshedAccessToken(): Promise<string> {
  const tokens = readOAuthTokens();
  if (!tokens) throw notLoggedIn();
  return (await refreshTokens(tokens)).accessToken;
}

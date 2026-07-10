import { describe, expect, it } from "vitest";
import { translatePgError } from "../src/pg.js";

function pgError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  const err = new Error(message) as Error & Record<string, unknown>;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

describe("translatePgError", () => {
  it("maps authentication failures without echoing credentials", () => {
    const out = translatePgError(pgError("28P01", 'password authentication failed for user "svc"'));
    expect(out.code).toBe("AUTH_ERROR");
    expect(out.suggestions[0]).toContain("SNOWFLAKE_AXI_PG_USER");
  });

  it("maps a missing database to CONFIG_ERROR", () => {
    expect(translatePgError(pgError("3D000", 'database "nope" does not exist')).code).toBe("CONFIG_ERROR");
  });

  it("suggests a table search for undefined tables", () => {
    const out = translatePgError(pgError("42P01", 'relation "nope" does not exist'));
    expect(out.code).toBe("PG_ERROR");
    expect(out.suggestions[0]).toContain("pg tables --like");
  });

  it("suggests pg schema for undefined columns", () => {
    const out = translatePgError(pgError("42703", 'column "nope" does not exist'));
    expect(out.suggestions[0]).toContain("pg schema");
  });

  it("maps read-only violations to READ_ONLY", () => {
    const out = translatePgError(pgError("25006", "cannot execute UPDATE in a read-only transaction"));
    expect(out.code).toBe("READ_ONLY");
  });

  it("maps statement timeouts to TIMEOUT with a --timeout hint", () => {
    const out = translatePgError(pgError("57014", "canceling statement due to statement timeout"));
    expect(out.code).toBe("TIMEOUT");
    expect(out.suggestions[0]).toContain("--timeout");
  });

  it("maps multi-statement rejections to VALIDATION_ERROR", () => {
    const out = translatePgError(pgError("42601", "cannot insert multiple commands into a prepared statement"));
    expect(out.code).toBe("VALIDATION_ERROR");
  });

  it("includes the position on syntax errors", () => {
    const out = translatePgError(pgError("42601", 'syntax error at or near "FRM"', { position: "10" }));
    expect(out.message).toContain("position 10");
  });

  it("maps connection failures to CONNECTION_ERROR", () => {
    const out = translatePgError(pgError("ECONNREFUSED", "connect ECONNREFUSED 1.2.3.4:5432"));
    expect(out.code).toBe("CONNECTION_ERROR");
    expect(out.suggestions[0]).toContain("SNOWFLAKE_AXI_PG_HOST");
  });

  it("maps TLS failures to CONNECTION_ERROR with an sslmode hint", () => {
    const out = translatePgError(pgError("", "self-signed certificate in certificate chain"));
    expect(out.code).toBe("CONNECTION_ERROR");
    expect(out.suggestions[0]).toContain("SNOWFLAKE_AXI_PG_SSLMODE");
  });

  it("passes server hints through on uncategorized errors", () => {
    const out = translatePgError(pgError("0A000", "feature not supported", { hint: "try something else" }));
    expect(out.code).toBe("PG_ERROR");
    expect(out.suggestions).toEqual(["try something else"]);
  });
});

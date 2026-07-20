import { AxiError } from "axi-sdk-js";
import { defineCommand } from "../command.js";
import { envFilePath, loadConfig, loadPgConfig, processEnvRole, readActiveRole, ringLogins } from "../config.js";
import { runPgQuery } from "../pg.js";
import { runQuery } from "../snowflake.js";

type Status = "ok" | "warn" | "fail" | "skip";

interface Check {
  check: string;
  status: Status;
  detail: string;
}

/** Pulls a message plus any fix hints off a thrown error, AxiError or not. */
function explain(err: unknown): { detail: string; hints: string[] } {
  if (err instanceof AxiError) {
    const suggestions = (err as { suggestions?: string[] }).suggestions;
    return { detail: err.message, hints: Array.isArray(suggestions) ? suggestions : [] };
  }
  return { detail: err instanceof Error ? err.message : String(err), hints: [] };
}

/** CURRENT_AVAILABLE_ROLES() is a JSON array string; count its entries. */
function availableRoleCount(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs the connection end to end and reports each part so a first-time setup
 * fails informatively instead of on a raw Snowflake error. Every check is
 * caught: the report is the deliverable, so a broken part becomes a `fail` row
 * with its fix, never an aborted run. Read-only; changes no configuration.
 */
export async function runDoctor(): Promise<Record<string, unknown>> {
  const checks: Check[] = [];
  const hints: string[] = [];
  const addHints = (more: string[]) => {
    for (const hint of more) if (!hints.includes(hint)) hints.push(hint);
  };

  let auth: string | undefined;
  try {
    const config = loadConfig();
    auth = config.auth;
    checks.push({
      check: "config",
      status: "ok",
      detail: `${config.auth} auth; account ${config.account}, user ${config.user}`,
    });
  } catch (err) {
    const { detail, hints: found } = explain(err);
    checks.push({ check: "config", status: "fail", detail });
    addHints(found);
  }

  if (auth !== undefined) {
    try {
      const { rows } = await runQuery(
        "SELECT CURRENT_ROLE() AS ROLE, CURRENT_WAREHOUSE() AS WAREHOUSE, CURRENT_DATABASE() AS DATABASE, CURRENT_SCHEMA() AS SCHEMA, CURRENT_AVAILABLE_ROLES() AS ROLES",
      );
      const row = rows[0] ?? {};
      checks.push({ check: "connection", status: "ok", detail: `reached Snowflake as ${row.ROLE ?? "?"}` });

      checks.push(
        row.WAREHOUSE
          ? { check: "warehouse", status: "ok", detail: String(row.WAREHOUSE) }
          : { check: "warehouse", status: "warn", detail: "no current warehouse; queries that need compute will fail" },
      );
      if (!row.WAREHOUSE) {
        addHints([
          "Set a durable warehouse: ALTER USER <user> SET DEFAULT_WAREHOUSE = <wh>, or pass `query --warehouse <wh>`",
        ]);
      }

      const namespace = [row.DATABASE, row.SCHEMA].filter(Boolean).join(".");
      checks.push(
        namespace
          ? { check: "namespace", status: "ok", detail: namespace }
          : { check: "namespace", status: "warn", detail: "no default namespace; unqualified names cannot resolve" },
      );
      if (!namespace) {
        addHints([
          "Set a default namespace: ALTER USER <user> SET DEFAULT_NAMESPACE = '<db>.<schema>', or fully qualify names",
        ]);
      }

      const roleCount = availableRoleCount(row.ROLES);
      const pinned = processEnvRole() ?? readActiveRole();
      const active = pinned ? `; active role ${pinned}` : "";
      if (auth === "oauth") {
        const logins = ringLogins();
        checks.push({
          check: "roles",
          status: "ok",
          detail: `${logins.length} OAuth login(s): ${logins.join(", ") || "none"}${active}`,
        });
      } else if (roleCount !== undefined && roleCount <= 1) {
        checks.push({ check: "roles", status: "warn", detail: `only ${roleCount} role reachable${active}` });
        addHints([
          "If you expected more roles, the PAT may be role-restricted (mint it without ROLE_RESTRICTION) or the user lacks grants; `snowflake-axi role --grants` lists them",
        ]);
      } else {
        checks.push({ check: "roles", status: "ok", detail: `${roleCount ?? "?"} roles reachable${active}` });
      }
    } catch (err) {
      const { detail, hints: found } = explain(err);
      checks.push({ check: "connection", status: "fail", detail });
      addHints(found);
    }
  }

  // Snowflake Postgres is an independent surface, so probe it even if the SQL
  // API side is down. loadPgConfig throws when the SNOWFLAKE_AXI_PG_* keys are
  // absent, which is the optional-and-unset case, not a failure.
  try {
    loadPgConfig();
    try {
      await runPgQuery("SELECT 1", { maxRows: 1 });
      checks.push({ check: "postgres", status: "ok", detail: "reachable (read-only session)" });
    } catch (err) {
      const { detail, hints: found } = explain(err);
      checks.push({ check: "postgres", status: "fail", detail });
      addHints(found);
    }
  } catch {
    checks.push({
      check: "postgres",
      status: "skip",
      detail: "not configured (optional; set SNOWFLAKE_AXI_PG_* to enable `pg`)",
    });
  }

  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const summary =
    failed > 0 ? `${failed} check(s) failed` : warned > 0 ? `reachable, ${warned} warning(s)` : "all checks passed";

  return {
    doctor: `connection diagnostics: ${summary}`,
    config: envFilePath(),
    checks,
    help: [...hints, "Full configuration reference: env.template and the README"],
  };
}

export const doctorCommand = defineCommand("doctor", {
  summary:
    "Diagnose connection setup: credentials, Snowflake reachability, warehouse/namespace defaults, roles, and Postgres",
  action: {
    description:
      "Run the connection end to end and report every part - credentials, Snowflake reachability, warehouse and namespace defaults, role reach, and Snowflake Postgres - with a fix for anything wrong. Read-only; changes no configuration.",
    notes: [
      "Each check is ok, warn, fail, or skip; the report is the output, so a failing check never aborts the run.",
      "Makes no writes and changes nothing; safe to run whenever setup is in doubt.",
    ],
    examples: ["snowflake-axi doctor"],
    run: () => runDoctor(),
  },
});

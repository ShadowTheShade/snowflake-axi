import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { AxiError } from "axi-sdk-js";

/**
 * Adapter-agnostic mechanics shared by every local dbt runner (Snowflake in
 * dbt-local.ts, Postgres in pg-dbt.ts): spawning the CLI, streaming its log,
 * and shaping run_results.json. What differs between adapters - which binary,
 * how credentials are injected, which verbs write - stays in the callers.
 */

export interface DbtExit {
  code: number;
  tail: string[];
  /** Full stdout, kept apart from stderr so verbs like `ls` can parse it (the human log goes to stderr). */
  stdout: string;
}

export interface NodeRow {
  node: string;
  type: string;
  status: string;
  time: string;
  detail: string;
}

export const FAILURE_STATUSES = new Set(["error", "fail", "runtime error"]);

/** AxiError raised when the dbt executable is missing; callers supply adapter-specific install guidance. */
export type MissingDbt = () => AxiError;

/**
 * Spawns a dbt executable, mirroring its output to our stderr so the human
 * sees the live log while stdout is kept whole for verbs whose payload is what
 * dbt prints (like `ls`). Rejects with a TIMEOUT AxiError past timeoutSeconds
 * and with onMissing()'s error when the binary is absent.
 */
export function spawnDbt(
  bin: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
  timeoutSeconds: number,
  onMissing: MissingDbt,
): Promise<DbtExit> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(bin, argv, { env, stdio: ["ignore", "pipe", "pipe"] });
    let buffered = "";
    let stdout = "";
    const onStdout = (chunk: Buffer) => {
      process.stderr.write(chunk);
      const text = chunk.toString();
      buffered = (buffered + text).slice(-16384);
      stdout = (stdout + text).slice(-1_000_000);
    };
    const onStderr = (chunk: Buffer) => {
      process.stderr.write(chunk);
      buffered = (buffered + chunk.toString()).slice(-16384);
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutSeconds * 1000);
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        reject(onMissing());
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new AxiError(`dbt did not finish within ${timeoutSeconds}s`, "TIMEOUT", [
            "Raise --timeout, or narrow the run with --select",
          ]),
        );
        return;
      }
      resolveExit({ code: code ?? 1, tail: buffered.split("\n"), stdout });
    });
  });
}

function shapeResult(raw: unknown): NodeRow {
  const rec = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const uniqueId = typeof rec.unique_id === "string" ? rec.unique_id : "";
  const [type, , ...rest] = uniqueId.split(".");
  const message = typeof rec.message === "string" ? rec.message : "";
  const seconds = typeof rec.execution_time === "number" ? rec.execution_time : 0;
  return {
    node: rest.join(".") || uniqueId,
    type: type || "node",
    status: String(rec.status ?? ""),
    time: `${seconds.toFixed(1)}s`,
    detail: message.replace(/\s+/g, " ").slice(0, 140),
  };
}

/**
 * Reads run_results.json written by the run just finished. The mtime guard
 * rejects a stale file from a prior run when the current invocation produced
 * none (e.g. it failed before executing any node).
 */
export function readRunResults(file: string, startedMs: number): NodeRow[] | undefined {
  try {
    if (statSync(file).mtimeMs < startedMs - 2000) return undefined;
  } catch {
    return undefined;
  }
  let parsed: { results?: unknown };
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as { results?: unknown };
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed.results)) return undefined;
  return parsed.results.map(shapeResult);
}

export function statusCounts(rows: NodeRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  return [...counts.entries()].map(([status, n]) => `${n} ${status}`).join(", ");
}

/** Distils a dbt log tail to the lines that explain a failure, newest last. */
export function errorLines(tail: string[]): string[] {
  const cleaned = tail.map((line) => line.replace(/^\d{2}:\d{2}:\d{2}\s+/, "").trim()).filter(Boolean);
  const errors = cleaned.filter((line) => /error|fail/i.test(line));
  const picked = (errors.length > 0 ? errors : cleaned).slice(-8);
  return picked.length > 0 ? picked : ["dbt produced no output; run dbt manually in the project to inspect"];
}

/** Guards a directory reference (e.g. a manifest home) before dbt spawns, so a bad path fails loud here. */
export function assertDir(path: string, label: string, hints: string[]): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new AxiError(`${label} is not a directory: ${path}`, "NOT_FOUND", hints);
  }
}

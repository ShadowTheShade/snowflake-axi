import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const BIN = fileURLToPath(new URL("../dist/bin/snowflake-axi.js", import.meta.url));
const exec = promisify(execFile);

export interface CliResult {
  stdout: string;
  code: number;
}

/** Runs the built CLI as a subprocess, the way an agent does. */
export async function cli(
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 60000,
): Promise<CliResult> {
  try {
    const { stdout } = await exec(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env },
      timeout: timeoutMs,
    });
    return { stdout, code: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: `${failed.stdout ?? ""}${failed.stderr ?? ""}`, code: failed.code ?? 1 };
  }
}

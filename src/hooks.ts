import { existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AxiError,
  computeCodexConfigUpdate,
  type HookSettings,
  installSessionStartHooks,
  resolvePortableHookCommand,
} from "axi-sdk-js";

/**
 * Opt-in SessionStart integration (AXI section 7). The hook payload must be an
 * argument-less executable - the SDK's OpenCode plugin spawns it without a
 * shell - so the `context` command ships as its own bin, snowflake-axi-context
 * (config-derived, no connection). With that, the SDK's one-shot installer
 * covers Claude Code, Codex, and OpenCode; this module drives it and adds the
 * status and remove sides the SDK does not provide.
 */
export const HOOK_MARKER = "snowflake-axi";
export const CONTEXT_BINARY = "snowflake-axi-context";
const HOOK_TIMEOUT_SECONDS = 10;
const OPENCODE_MANAGED_MARKER = `axi-sdk-js managed opencode plugin: ${HOOK_MARKER}`;

export interface HookTarget {
  app: string;
  file: string;
}

export interface TargetResult extends HookTarget {
  status: string;
}

function jsonTargets(home: string): HookTarget[] {
  return [
    { app: "Claude Code", file: join(home, ".claude", "settings.json") },
    { app: "Codex", file: join(home, ".codex", "hooks.json") },
  ];
}

function codexConfigFile(home: string): string {
  return join(home, ".codex", "config.toml");
}

function openCodePluginFile(home: string): string {
  return join(home, ".config", "opencode", "plugins", `axi-${HOOK_MARKER}.js`);
}

/** Absolute path of the built context binary next to this module. */
export function contextExecPath(): string {
  const path = fileURLToPath(new URL(`./bin/${CONTEXT_BINARY}.js`, import.meta.url));
  if (!existsSync(path)) {
    throw new AxiError("The built context binary was not found next to this CLI", "VALIDATION_ERROR", [
      "Run `npm run build && npm link` and retry with the installed binary",
    ]);
  }
  return path;
}

function portableContext() {
  const rawPath = process.env.PATH ?? "";
  return {
    pathEntries: rawPath.split(delimiter).filter(Boolean),
    pathExtensions:
      process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""],
    resolveRealPath: (path: string) => {
      try {
        if (!statSync(path).isFile()) return undefined;
        return realpathSync(path);
      } catch {
        return undefined;
      }
    },
  };
}

/** The command the hook will run: the PATH-verified binary name when it resolves to execPath, else the absolute path. */
export function plannedHookCommand(execPath: string): string {
  return resolvePortableHookCommand(resolve(execPath), [CONTEXT_BINARY], HOOK_MARKER, portableContext());
}

function readJson(file: string): HookSettings {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  return JSON.parse(text) as HookSettings;
}

export function managedHookCommand(settings: HookSettings): string | undefined {
  const groups = settings.hooks?.SessionStart;
  if (!Array.isArray(groups)) return undefined;
  for (const group of groups) {
    for (const hook of group.hooks ?? []) {
      if (typeof hook.command === "string" && hook.command.includes(HOOK_MARKER)) return hook.command;
    }
  }
  return undefined;
}

function openCodeCommand(home: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(openCodePluginFile(home), "utf8");
  } catch {
    return undefined;
  }
  if (!text.includes(OPENCODE_MANAGED_MARKER)) return undefined;
  const literal = text.match(/^const command = ("(?:[^"\\]|\\.)*");$/m)?.[1];
  try {
    return literal ? (JSON.parse(literal) as string) : "(installed)";
  } catch {
    return "(installed)";
  }
}

function codexFeatureEnabled(home: string): boolean {
  const file = codexConfigFile(home);
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  return !computeCodexConfigUpdate(current)[1];
}

function errorStatus(error: unknown): string {
  return `error: ${error instanceof Error ? error.message : String(error)}`;
}

interface Snapshot {
  json: (string | undefined)[];
  openCode: string | undefined;
  codexFeature: boolean;
}

function snapshot(home: string): Snapshot {
  return {
    json: jsonTargets(home).map((target) => {
      try {
        return managedHookCommand(readJson(target.file));
      } catch {
        return undefined;
      }
    }),
    openCode: openCodeCommand(home),
    codexFeature: codexFeatureEnabled(home),
  };
}

function transition(before: string | undefined, after: string | undefined, error: string | undefined): string {
  if (error !== undefined) return `error: ${error}`;
  if (after === undefined) return before === undefined ? "error: not installed" : "error: removed unexpectedly";
  if (before === undefined) return "installed";
  return before === after ? "already installed (no-op)" : "updated";
}

export function hookStatuses(home: string): TargetResult[] {
  const rows: TargetResult[] = jsonTargets(home).map((target) => {
    try {
      return { ...target, status: managedHookCommand(readJson(target.file)) ?? "(not installed)" };
    } catch (error) {
      return { ...target, status: errorStatus(error) };
    }
  });
  rows.push({
    app: "OpenCode",
    file: openCodePluginFile(home),
    status: openCodeCommand(home) ?? "(not installed)",
  });
  return rows;
}

export function installHooks(home: string, execPath: string): TargetResult[] {
  const before = snapshot(home);
  const errors: string[] = [];
  installSessionStartHooks({
    execPath,
    marker: HOOK_MARKER,
    binaryNames: [CONTEXT_BINARY],
    distEntrypoints: [`dist/bin/${CONTEXT_BINARY}.js`],
    homeDir: home,
    timeoutSeconds: HOOK_TIMEOUT_SECONDS,
    onError: (message) => errors.push(message),
  });
  const after = snapshot(home);
  const errorFor = (file: string) =>
    errors.find((message) => message.startsWith(`${file}: `))?.slice(file.length + 2);

  const results = jsonTargets(home).map((target, i) => ({
    ...target,
    status: transition(before.json[i], after.json[i], errorFor(target.file)),
  }));
  results.push({
    app: "Codex",
    file: codexConfigFile(home),
    status: errorFor(codexConfigFile(home))
      ? `error: ${errorFor(codexConfigFile(home))}`
      : before.codexFeature
        ? "hooks feature already enabled (no-op)"
        : "hooks feature enabled",
  });
  results.push({
    app: "OpenCode",
    file: openCodePluginFile(home),
    status: transition(before.openCode, after.openCode, errorFor(openCodePluginFile(home))),
  });
  return results;
}

export function removeHooks(home: string): TargetResult[] {
  const results = jsonTargets(home).map((target) => {
    try {
      if (!existsSync(target.file)) return { ...target, status: "not installed (no-op)" };
      const settings = readJson(target.file);
      const groups = settings.hooks?.SessionStart;
      if (!Array.isArray(groups)) return { ...target, status: "not installed (no-op)" };
      let removed = 0;
      const kept = groups
        .map((group) => {
          if (!Array.isArray(group.hooks)) return group;
          const hooks = group.hooks.filter((hook) => {
            const managed = typeof hook.command === "string" && hook.command.includes(HOOK_MARKER);
            if (managed) removed++;
            return !managed;
          });
          return { ...group, hooks };
        })
        .filter((group) => !Array.isArray(group.hooks) || group.hooks.length > 0);
      if (removed === 0) return { ...target, status: "not installed (no-op)" };
      if (kept.length === 0 && settings.hooks) delete settings.hooks.SessionStart;
      else if (settings.hooks) settings.hooks.SessionStart = kept;
      writeFileSync(target.file, `${JSON.stringify(settings, null, 2)}\n`);
      return { ...target, status: "removed" };
    } catch (error) {
      return { ...target, status: errorStatus(error) };
    }
  });

  const pluginFile = openCodePluginFile(home);
  try {
    if (!existsSync(pluginFile)) {
      results.push({ app: "OpenCode", file: pluginFile, status: "not installed (no-op)" });
    } else if (!readFileSync(pluginFile, "utf8").includes(OPENCODE_MANAGED_MARKER)) {
      results.push({ app: "OpenCode", file: pluginFile, status: "not managed (left in place)" });
    } else {
      rmSync(pluginFile);
      results.push({ app: "OpenCode", file: pluginFile, status: "removed" });
    }
  } catch (error) {
    results.push({ app: "OpenCode", file: pluginFile, status: errorStatus(error) });
  }
  return results;
}

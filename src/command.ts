export type CommandOutput = string | Record<string, unknown>;

export interface CommandSpec {
  summary: string;
  help: string;
  run: (args: string[]) => Promise<CommandOutput> | CommandOutput;
}

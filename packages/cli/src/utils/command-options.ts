import type { Command } from "commander";

const JSON_OPTION_DESCRIPTION = "Output in JSON format";
const DAEMON_HOST_OPTION_DESCRIPTION =
  "Daemon host target: host:port or tcp://host:port?ssl=true&password=secret (default: local socket/pipe, then localhost:6767)";

export function collectMultiple(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

export function addJsonOption<T extends Command>(command: T): T {
  command.option("--json", JSON_OPTION_DESCRIPTION);
  return command;
}

export function addDaemonHostOption<T extends Command>(command: T): T {
  command.option("--host <host>", DAEMON_HOST_OPTION_DESCRIPTION);
  return command;
}

export function addJsonAndDaemonHostOptions<T extends Command>(command: T): T {
  return addDaemonHostOption(addJsonOption(command));
}

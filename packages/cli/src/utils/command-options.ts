import type { Command } from "commander";

const JSON_OPTION_DESCRIPTION = "Output in JSON format";
const DAEMON_HOST_OPTION_DESCRIPTION =
  "Daemon host target: host:port, tcp://host:port, or ssh://user@host (default: local socket/pipe, then localhost:6767)";

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

export function withGlobalOptions<Args extends unknown[], Result>(
  handler: (...args: Args) => Result,
): (...args: Args) => Result {
  return (...args) => {
    const command = args.at(-1) as Command;
    const mergedArgs = [...args];
    mergedArgs[mergedArgs.length - 2] = command.optsWithGlobals();
    return handler(...(mergedArgs as Args));
  };
}

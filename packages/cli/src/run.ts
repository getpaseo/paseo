import { renderError, toCommandError, defaultOutputOptions } from "./output/render.js";
import { createCli } from "./cli.js";
import { classifyInvocation } from "./classify.js";
import { openDesktopWithProject } from "./commands/open.js";

export interface RunCliOptions {
  cwd?: string;
  nodeArgv?: [string, string];
}

export function createCliParseArgv(input: {
  argv: string[];
  cwd: string;
  nodeArgv?: [string, string];
}): string[] | { kind: "open-project"; resolvedPath: string } {
  const program = createCli();
  const knownCommands = new Set(program.commands.map((command) => command.name()));
  const invocation = classifyInvocation({
    argv: input.argv,
    knownCommands,
    cwd: input.cwd,
  });

  if (invocation.kind === "open-project") {
    return invocation;
  }

  const nodeArgv = input.nodeArgv ?? ["paseo", "paseo"];
  const isOnboardRootFlag = invocation.argv[0] === "--relay" || invocation.argv[0] === "--no-relay";
  let cliArgv = invocation.argv;
  if (invocation.argv.length === 0) {
    cliArgv = ["onboard"];
  } else if (isOnboardRootFlag) {
    cliArgv = ["onboard", ...invocation.argv];
  }
  return [...nodeArgv, ...cliArgv];
}

// The program that started the CLI can close its end of stdout before the output
// is written, as `paseo ls | head -1` or a launcher that discards output does.
// Drop the output nobody reads and let the command finish, instead of surfacing
// the failed write as an uncaught error.
function ignoreClosedStdout(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE") {
    throw error;
  }
}

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  if (!process.stdout.listeners("error").includes(ignoreClosedStdout)) {
    process.stdout.on("error", ignoreClosedStdout);
  }

  const parseArgv = createCliParseArgv({
    argv,
    cwd: options.cwd ?? process.cwd(),
    nodeArgv: options.nodeArgv,
  });

  if (!Array.isArray(parseArgv)) {
    await openDesktopWithProject(parseArgv.resolvedPath);
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  }

  const program = createCli();
  try {
    await program.parseAsync(parseArgv, { from: "node" });
  } catch (error) {
    process.stderr.write(
      renderError(toCommandError(error), {
        ...defaultOutputOptions,
        format: argv.includes("--json") ? "json" : "table",
      }) + "\n",
    );
    return 1;
  }
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

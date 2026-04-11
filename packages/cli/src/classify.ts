import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type CliInvocation =
  | { kind: "cli"; argv: string[] }
  | { kind: "open-project"; resolvedPath: string };

export function isPathLikeArg(arg: string): boolean {
  return (
    arg === "." ||
    arg === ".." ||
    arg.startsWith("./") ||
    arg.startsWith("../") ||
    arg.startsWith("/") ||
    arg === "~" ||
    arg.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(arg) ||
    arg.startsWith("\\\\")
  );
}

export function expandUserPath(inputPath: string): string {
  if (inputPath === "~") {
    return homedir();
  }

  if (inputPath.startsWith("~/")) {
    return path.join(homedir(), inputPath.slice(2));
  }

  return inputPath;
}

export function isExistingDirectory(input: { pathArg: string; cwd: string }): boolean {
  const resolvedPath = path.resolve(input.cwd, expandUserPath(input.pathArg));

  if (!existsSync(resolvedPath)) {
    return false;
  }

  return statSync(resolvedPath).isDirectory();
}

export function classifyInvocation(input: {
  argv: string[];
  knownCommands: ReadonlySet<string>;
  cwd: string;
}): CliInvocation {
  const [firstArg] = input.argv;
  if (!firstArg) {
    return { kind: "cli", argv: input.argv };
  }

  if (firstArg.startsWith("-")) {
    return { kind: "cli", argv: input.argv };
  }

  if (input.knownCommands.has(firstArg)) {
    return { kind: "cli", argv: input.argv };
  }

  if (isExistingDirectory({ pathArg: firstArg, cwd: input.cwd })) {
    return {
      kind: "open-project",
      resolvedPath: path.resolve(input.cwd, expandUserPath(firstArg)),
    };
  }

  return { kind: "cli", argv: input.argv };
}

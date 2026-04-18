import { existsSync, statSync } from "node:fs";
import path from "node:path";

const OPEN_PROJECT_FLAG = "--open-project";
const OPEN_PROJECT_IGNORED_ARG_PREFIXES = ["-psn_", "--no-sandbox"];

function isExistingDirectoryAbsolutePath(candidate: string): boolean {
  if (!path.isAbsolute(candidate) || !existsSync(candidate)) {
    return false;
  }

  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

export function parseOpenProjectPathFromArgv(input: {
  argv: string[];
  isDefaultApp: boolean;
}): string | null {
  const effectiveArgs = input.argv
    .slice(input.isDefaultApp ? 2 : 1)
    .filter((arg) => !OPEN_PROJECT_IGNORED_ARG_PREFIXES.some((prefix) => arg.startsWith(prefix)));

  const positionalProjectPath = effectiveArgs.find(
    (arg) => !arg.startsWith("-") && isExistingDirectoryAbsolutePath(arg),
  );
  if (positionalProjectPath) {
    return positionalProjectPath;
  }

  const openProjectIndex = effectiveArgs.indexOf(OPEN_PROJECT_FLAG);
  if (openProjectIndex === -1) {
    return null;
  }

  const flaggedProjectPath = effectiveArgs[openProjectIndex + 1];
  return flaggedProjectPath && isExistingDirectoryAbsolutePath(flaggedProjectPath)
    ? flaggedProjectPath
    : null;
}

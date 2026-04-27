import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";

function expandHomeDir(input: string): string {
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  if (input === "~") {
    return os.homedir();
  }
  return input;
}

export function resolveHubcodeHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.HUBCODE_HOME ?? "~/.hubcode";
  const resolved = path.resolve(expandHomeDir(raw));
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

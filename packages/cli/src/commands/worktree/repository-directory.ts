import { resolve } from "node:path";
import type { DaemonTarget } from "../../utils/daemon-target.js";

export function resolveRepositoryDirectory(options: {
  cwd?: string;
  daemonTarget: DaemonTarget;
}): string {
  const cwd = options.cwd ?? process.cwd();
  if (options.daemonTarget.kind === "instance") {
    return resolve(cwd);
  }
  return cwd;
}

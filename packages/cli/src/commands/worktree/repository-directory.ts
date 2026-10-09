import { resolve } from "node:path";
import type { DaemonTarget } from "../../utils/daemon-target.js";

export function resolveRepositoryDirectory(options: {
  cwd?: string;
  daemonTarget: DaemonTarget;
}): string {
  const cwd = options.cwd ?? process.cwd();
  return options.daemonTarget.kind === "instance" ? resolve(cwd) : cwd;
}

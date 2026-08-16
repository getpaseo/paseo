import type { Readable, Writable } from "node:stream";

import type { WorkspaceFiles } from "./files.js";
import { createClient } from "./client.js";

export interface WorkspaceHelperProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(signal?: NodeJS.Signals): void;
}

export interface WorkspaceFilesOwner {
  files: WorkspaceFiles;
  resolveCommand(command: string): Promise<string | null>;
  verify(): Promise<void>;
  close(reason?: Error): Promise<void>;
}

export function bindWorkspaceHelper(options: {
  command: readonly [string, ...string[]];
  launch(argv: readonly [string, ...string[]]): Promise<WorkspaceHelperProcess>;
}): WorkspaceFilesOwner {
  return createClient(options);
}

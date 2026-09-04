import type { EditorTarget, EditorTargetLaunchInput, RemoteDestination } from "../target.js";
import { encodeRemotePath } from "./remote-path.js";

const COMMANDS = ["zed", "zeditor"] as const;

function location(input: EditorTargetLaunchInput): string {
  if (!input.line) return input.filePath!;
  return input.column
    ? `${input.filePath}:${input.line}:${input.column}`
    : `${input.filePath}:${input.line}`;
}

/** Adding a `RemoteDestinationKind` without a URL form here is a compile error. */
function remoteUrl(destination: RemoteDestination, path: string): string {
  switch (destination.kind) {
    case "ssh":
      return `ssh://${destination.host}${encodeRemotePath(path)}`;
  }
}

/**
 * Zed opens a remote path as a URL rather than through an authority, so it needs no
 * `--remote` equivalent. Its docs give `zed ssh://[<user>@]<host>[:<port>]/<path>` for
 * remote paths and document `<path>:<line>[:<column>]` only for local ones; nothing
 * documents a line suffix on an `ssh://` URL. So remote opens are folder-only here — the
 * active file is dropped rather than appended in a syntax Zed may not parse.
 */
function launchArgs(input: EditorTargetLaunchInput): string[] {
  if (input.remoteDestination) {
    return [remoteUrl(input.remoteDestination, input.workspacePath)];
  }
  if (!input.filePath) return [input.workspacePath];
  return [input.workspacePath, location(input)];
}

export const zedTarget: EditorTarget = {
  id: "zed",
  remoteDestinationKinds: ["ssh"],
  async describe(runtime) {
    return { id: this.id, label: "Zed", kind: "editor", icon: await runtime.loadIcon("zed.png") };
  },
  async isInstalled(runtime) {
    return runtime.resolveCommand(COMMANDS) !== null || runtime.hasMacApplication("Zed");
  },
  async launch(input, runtime) {
    const command = runtime.resolveCommand(COMMANDS);
    if (command) {
      await runtime.spawnDetached({ command, args: launchArgs(input) });
      return;
    }
    if (input.remoteDestination) {
      throw new Error("The Zed command line tool is required to open a remote workspace");
    }
    if (runtime.hasMacApplication("Zed")) {
      await runtime.openMacApplication({
        applicationName: "Zed",
        paths: input.filePath ? [input.workspacePath, input.filePath] : [input.workspacePath],
      });
      return;
    }
    throw new Error("Zed is not installed");
  },
};

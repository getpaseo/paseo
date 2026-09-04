import type { EditorTargetLaunchInput, RemoteDestination } from "../target.js";
import { encodeRemotePath } from "./remote-path.js";

/** Adding a `RemoteDestinationKind` without an authority form here is a compile error. */
function remoteAuthority(destination: RemoteDestination): string {
  switch (destination.kind) {
    case "ssh":
      return `ssh-remote+${destination.host}`;
  }
}

function remoteUri(destination: RemoteDestination, path: string): string {
  return `vscode-remote://${remoteAuthority(destination)}${encodeRemotePath(path)}`;
}

function position(input: EditorTargetLaunchInput): string {
  if (!input.line) return "";
  return input.column ? `:${input.line}:${input.column}` : `:${input.line}`;
}

function localArgs(input: EditorTargetLaunchInput): string[] {
  if (!input.filePath) return [input.workspacePath];
  if (!input.line) return [input.workspacePath, input.filePath];
  return [input.workspacePath, "--goto", `${input.filePath}${position(input)}`];
}

/**
 * `--goto <path>:<line>` classifies positional paths with `stat()`, and the client cannot
 * stat a remote filesystem: every path lands in `fileURIs` and the folder never opens.
 * Explicit `--folder-uri` / `--file-uri` carry the authority inside the URI instead, so
 * `--remote` is unnecessary and the line number rides inside the file URI path.
 */
function remoteArgs(input: EditorTargetLaunchInput, destination: RemoteDestination): string[] {
  const folderArgs = ["--folder-uri", remoteUri(destination, input.workspacePath)];
  if (!input.filePath) return folderArgs;
  const fileUri = `${remoteUri(destination, input.filePath)}${position(input)}`;
  if (!input.line) return [...folderArgs, "--file-uri", fileUri];
  return [...folderArgs, "--goto", "--file-uri", fileUri];
}

export function vscodeLaunchArgs(input: EditorTargetLaunchInput): string[] {
  return input.remoteDestination ? remoteArgs(input, input.remoteDestination) : localArgs(input);
}

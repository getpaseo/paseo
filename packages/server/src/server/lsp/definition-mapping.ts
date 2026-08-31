import { isAbsolute, relative, resolve } from "node:path";
import type { CodeDefinitionResponse, CodeDefinitionTarget } from "@getpaseo/protocol/messages";
import { URI } from "vscode-uri";
import type { DefinitionOutcome } from "./host.js";

type DefinitionResult = CodeDefinitionResponse["payload"]["result"];

export class PathOutsideWorkspaceError extends Error {
  constructor(public readonly requestedPath: string) {
    super(`Path escapes the workspace: ${requestedPath}`);
    this.name = "PathOutsideWorkspaceError";
  }
}

/**
 * Resolve a workspace-relative path, refusing anything that escapes the root. The client
 * supplies this path, so traversal has to be rejected here rather than trusted.
 */
export function resolvePathWithinRoot(root: string, relativePath: string): string {
  const resolved = resolve(root, relativePath);
  const offset = relative(root, resolved);
  if (offset.startsWith("..") || isAbsolute(offset)) {
    throw new PathOutsideWorkspaceError(relativePath);
  }
  return resolved;
}

/**
 * Map the host's outcome onto the wire result. Targets outside the workspace are dropped:
 * a declaration in `node_modules` above the root, or in another checkout, is not a file the
 * client can open, and sending it would leak a path from outside the workspace.
 */
export function toDefinitionResult(root: string, outcome: DefinitionOutcome): DefinitionResult {
  if (outcome.status === "unsupported-language") {
    return { status: "unsupported_language" };
  }
  if (outcome.status === "server-not-installed") {
    return {
      status: "server_not_installed",
      serverId: outcome.serverId,
      command: outcome.command,
    };
  }

  const targets: CodeDefinitionTarget[] = [];
  for (const link of outcome.links) {
    const targetPath = URI.parse(link.targetUri).fsPath;
    const offset = relative(root, targetPath);
    if (offset.startsWith("..") || isAbsolute(offset)) {
      continue;
    }
    targets.push({
      path: offset,
      range: link.targetRange,
      selectionRange: link.targetSelectionRange,
      ...(link.originSelectionRange ? { originRange: link.originSelectionRange } : {}),
    });
  }
  return { status: "ok", targets };
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { isAbsolute, relative, resolve } from "node:path";
import type {
  CodeDefinitionResponse,
  CodeDefinitionTarget,
  CodePosition,
  CodeRange,
} from "@getpaseo/protocol/messages";
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

function containsPosition(range: CodeRange, position: CodePosition): boolean {
  if (position.line < range.start.line || position.line > range.end.line) {
    return false;
  }
  if (position.line === range.start.line && position.character < range.start.character) {
    return false;
  }
  return !(position.line === range.end.line && position.character > range.end.character);
}

export interface DefinitionOrigin {
  /** Workspace-relative path of the file the request came from. */
  path: string;
  position: CodePosition;
}

/**
 * Map the host's outcome onto the wire result.
 *
 * Two kinds of target are dropped. One outside the workspace — a declaration in a parent
 * `node_modules` or another checkout — is not a file the client can open, and its path would
 * leak a location from outside the workspace. One that encloses the request position is where
 * the user already is: tsserver answers a click on `return` or `export` with the surrounding
 * function, and underlining every keyword is noise.
 */
export function toDefinitionResult(
  root: string,
  outcome: DefinitionOutcome,
  origin: DefinitionOrigin,
): DefinitionResult {
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
    if (offset === origin.path && containsPosition(link.targetRange, origin.position)) {
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

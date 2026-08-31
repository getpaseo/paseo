import type {
  CodeDefinitionResponse,
  CodeDefinitionTarget,
  CodePosition,
  CodeRange,
} from "@getpaseo/protocol/messages";
import { sep } from "node:path";
import { URI } from "vscode-uri";
import { getRealpathAwareRelativePath } from "../../utils/path.js";
import type { DefinitionOutcome } from "./host.js";

type DefinitionResult = CodeDefinitionResponse["payload"]["result"];

function containsPosition(range: CodeRange, position: CodePosition): boolean {
  if (position.line < range.start.line || position.line > range.end.line) {
    return false;
  }
  if (position.line === range.start.line && position.character < range.start.character) {
    return false;
  }
  return !(position.line === range.end.line && position.character > range.end.character);
}

/** Paths cross the wire with `/` separators, matching every other path the daemon sends. */
function toWirePath(relativePath: string): string {
  return relativePath.split(sep).join("/");
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
 *
 * Containment goes through the daemon's realpath-aware comparison. Plain `path.relative` reads
 * a symlinked workspace root (`/tmp` on macOS, any symlinked checkout) as outside itself, which
 * would silently drop every target.
 */
export function toDefinitionResult(input: {
  root: string;
  outcome: DefinitionOutcome;
  origin: DefinitionOrigin;
}): DefinitionResult {
  const { root, outcome, origin } = input;
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
    const relativePath = getRealpathAwareRelativePath(root, URI.parse(link.targetUri).fsPath);
    if (relativePath === null) {
      continue;
    }
    const wirePath = toWirePath(relativePath);
    if (wirePath === origin.path && containsPosition(link.targetRange, origin.position)) {
      continue;
    }
    targets.push({
      path: wirePath,
      range: link.targetRange,
      selectionRange: link.targetSelectionRange,
      ...(link.originSelectionRange ? { originRange: link.originSelectionRange } : {}),
    });
  }
  return { status: "ok", targets };
}

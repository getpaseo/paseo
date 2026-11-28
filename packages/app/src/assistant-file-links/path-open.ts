import { normalizeInlinePathTarget, type InlinePathTarget } from "./parse";
import {
  normalizeWorkspaceFileLocation,
  type WorkspaceFileLocation,
  type OpenFileDisposition,
} from "@/workspace/file-open";
import { isAbsolutePath } from "@/utils/path";
import { resolveMissingNestedRelativeFile, type GetDirectorySuggestions } from "./resolver";

interface PathOpenInput {
  file?: string;
  directory: string;
  lineStart?: number;
  workspaceRoot: string;
  client: { listDirectory(root: string, path: string): Promise<unknown> } | null;
}

type PathOpenTarget =
  | { kind: "file" }
  | { kind: "directory"; directoryPath: string }
  | { kind: "outsideDirectory"; directoryPath: string };

// Workspace paths arrive relative to the root; anything still absolute or
// home-relative lives outside it, where the Files panel cannot list it.
function isOutsideWorkspacePath(pathValue: string): boolean {
  return isAbsolutePath(pathValue) || pathValue === "~" || pathValue.startsWith("~/");
}

/** Resolve workspace folders from filesystem facts, including names that contain dots. */
export async function resolveInlinePathOpen(input: PathOpenInput): Promise<PathOpenTarget> {
  if (!input.file) {
    return isOutsideWorkspacePath(input.directory)
      ? { kind: "outsideDirectory", directoryPath: input.directory }
      : { kind: "directory", directoryPath: input.directory };
  }
  if (
    input.lineStart !== undefined ||
    isAbsolutePath(input.file) ||
    !input.workspaceRoot.trim() ||
    !input.client
  ) {
    return { kind: "file" };
  }
  try {
    await input.client.listDirectory(input.workspaceRoot, input.file);
  } catch {
    return { kind: "file" };
  }
  return { kind: "directory", directoryPath: input.file };
}

export type InlinePathDestination =
  | { kind: "file"; location: WorkspaceFileLocation }
  | { kind: "directory"; path: string }
  | { kind: "outsideDirectory"; path: string };

/** What a path reference points at, as opening it would find it. */
export async function resolveInlinePathDestination(input: {
  target: InlinePathTarget;
  workspaceRoot: string;
  client: {
    listDirectory(root: string, path: string): Promise<unknown>;
    getDirectorySuggestions: GetDirectorySuggestions;
  } | null;
  resolveRelativeFiles?: boolean;
}): Promise<InlinePathDestination | null> {
  const { target, workspaceRoot, client } = input;
  const normalized = normalizeInlinePathTarget(target.path, workspaceRoot);
  if (!normalized) return null;
  const destination = await resolveInlinePathOpen({
    ...normalized,
    lineStart: target.lineStart,
    workspaceRoot,
    client,
  });
  if (destination.kind !== "file") {
    return { kind: destination.kind, path: destination.directoryPath };
  }
  if (!normalized.file) return null;
  const resolvedTarget =
    input.resolveRelativeFiles && client
      ? await resolveMissingNestedRelativeFile({
          target,
          workspaceRoot,
          getDirectorySuggestions: client.getDirectorySuggestions.bind(client),
        })
      : target;
  const resolved = normalizeInlinePathTarget(resolvedTarget.path, workspaceRoot);
  if (!resolved?.file) return null;
  const location = normalizeWorkspaceFileLocation({
    path: resolved.file,
    lineStart: resolvedTarget.lineStart,
    lineEnd: resolvedTarget.lineEnd,
  });
  return location ? { kind: "file", location } : null;
}

export function createInlinePathOpener(input: {
  workspaceRoot: string;
  client: {
    listDirectory(root: string, path: string): Promise<unknown>;
    getDirectorySuggestions: GetDirectorySuggestions;
  } | null;
  resolveRelativeFiles?: boolean;
  openFile: (location: WorkspaceFileLocation, disposition: OpenFileDisposition) => void;
  openDirectory: (path: string) => void;
  openOutsideDirectory: (path: string) => void;
}) {
  let generation = 0;
  return {
    async open(target: InlinePathTarget, disposition: OpenFileDisposition) {
      const ownGeneration = ++generation;
      const destination = await resolveInlinePathDestination({
        target,
        workspaceRoot: input.workspaceRoot,
        client: input.client,
        resolveRelativeFiles: input.resolveRelativeFiles,
      });
      if (!destination || ownGeneration !== generation) return;
      if (destination.kind === "directory") {
        input.openDirectory(destination.path);
      } else if (destination.kind === "outsideDirectory") {
        input.openOutsideDirectory(destination.path);
      } else {
        input.openFile(destination.location, disposition);
      }
    },
    cancel() {
      generation += 1;
    },
  };
}

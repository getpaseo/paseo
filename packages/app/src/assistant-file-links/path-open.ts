import { normalizeInlinePathTarget, type InlinePathTarget } from "./parse";
import {
  normalizeWorkspaceFileLocation,
  type WorkspaceFileLocation,
  type OpenFileDisposition,
} from "@/workspace/file-open";
import { isAbsolutePath } from "@/utils/path";

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

export function createInlinePathOpener(input: {
  workspaceRoot: string;
  client: PathOpenInput["client"];
  openFile: (location: WorkspaceFileLocation, disposition: OpenFileDisposition) => void;
  openDirectory: (path: string) => void;
  openOutsideDirectory: (path: string) => void;
}) {
  let generation = 0;
  return {
    async open(target: InlinePathTarget, disposition: OpenFileDisposition) {
      const ownGeneration = ++generation;
      const normalized = normalizeInlinePathTarget(target.path, input.workspaceRoot);
      if (!normalized) return;
      const destination = await resolveInlinePathOpen({
        ...normalized,
        lineStart: target.lineStart,
        workspaceRoot: input.workspaceRoot,
        client: input.client,
      });
      if (ownGeneration !== generation) return;
      if (destination.kind === "directory") {
        input.openDirectory(destination.directoryPath);
      } else if (destination.kind === "outsideDirectory") {
        input.openOutsideDirectory(destination.directoryPath);
      } else if (normalized.file) {
        const location = normalizeWorkspaceFileLocation({
          path: normalized.file,
          lineStart: target.lineStart,
          lineEnd: target.lineEnd,
        });
        if (location) input.openFile(location, disposition);
      }
    },
    cancel() {
      generation += 1;
    },
  };
}

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

type PathOpenTarget = { kind: "file" } | { kind: "directory"; directoryPath: string };

/** Resolve workspace folders from filesystem facts, including names that contain dots. */
export async function resolveInlinePathOpen(input: PathOpenInput): Promise<PathOpenTarget> {
  if (!input.file) {
    return { kind: "directory", directoryPath: input.directory };
  }
  if (
    input.lineStart !== undefined ||
    isAbsolutePath(input.file) ||
    !input.workspaceRoot.trim() ||
    !input.client
  ) {
    return { kind: "file" };
  }
  let listing: unknown;
  try {
    listing = await input.client.listDirectory(input.workspaceRoot, input.file);
  } catch {
    return { kind: "file" };
  }
  // The daemon reports the workspace-relative path, which also covers `~/` paths it expanded.
  return { kind: "directory", directoryPath: getListedDirectoryPath(listing) ?? input.file };
}

function getListedDirectoryPath(listing: unknown): string | null {
  if (typeof listing !== "object" || listing === null || !("path" in listing)) return null;
  return typeof listing.path === "string" && listing.path ? listing.path : null;
}

export function createInlinePathOpener(input: {
  workspaceRoot: string;
  client: PathOpenInput["client"];
  openFile: (location: WorkspaceFileLocation, disposition: OpenFileDisposition) => void;
  openDirectory: (path: string) => void;
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

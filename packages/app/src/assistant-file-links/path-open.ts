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
  try {
    await input.client.listDirectory(input.workspaceRoot, input.file);
  } catch {
    return { kind: "file" };
  }
  return { kind: "directory", directoryPath: input.file };
}

import { isAbsolutePath } from "@/utils/path";

export type InlinePathOpenPlan =
  | { kind: "file" }
  | { kind: "directory"; directoryPath: string }
  | { kind: "probe"; directoryPath: string };

/**
 * Decides how an inline path press opens. Extension-less workspace-relative paths without a
 * line number cannot be told apart from folders lexically ("moys-asr-workflow" is a folder,
 * "Makefile" is a file), so they come back as "probe" and the caller asks the daemon which
 * one it is before opening a file tab that would fail with "Requested path is not a file".
 */
export function planInlinePathOpen(input: {
  file?: string;
  lineStart?: number;
  workspaceRoot: string;
}): InlinePathOpenPlan {
  const { file, lineStart, workspaceRoot } = input;
  if (!file) {
    // Lexical directory: a trailing slash, ".", or the workspace root itself.
    return { kind: "directory", directoryPath: "." };
  }
  if (lineStart !== undefined || hasFileExtension(file)) {
    return { kind: "file" };
  }
  if (isAbsolutePath(file) || !workspaceRoot.trim()) {
    return { kind: "file" };
  }
  return { kind: "probe", directoryPath: file };
}

function hasFileExtension(value: string): boolean {
  const lastSegment = value.split("/").pop() ?? "";
  return /\.[A-Za-z0-9]+$/.test(lastSegment);
}

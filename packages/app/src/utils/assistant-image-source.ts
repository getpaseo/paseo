import { fileUriToPath } from "@/attachments/utils";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";

export type AssistantImageSourceResolution =
  | { kind: "direct"; uri: string }
  | { kind: "file_rpc"; cwd: string; path: string };

export function resolveAssistantImageSource(input: {
  source: string;
  workspaceRoot?: string;
}): AssistantImageSourceResolution | null {
  const source = input.source.trim();
  if (!source) {
    return null;
  }

  if (/^(https?:|data:|blob:)/i.test(source)) {
    return { kind: "direct", uri: source };
  }

  const sourcePath = source.startsWith("file://") ? fileUriToPath(source) : source;
  if (!sourcePath) {
    return null;
  }

  const readTarget = resolveFilePreviewReadTarget({
    path: sourcePath,
    workspaceRoot: input.workspaceRoot,
  });
  if (!readTarget) {
    return null;
  }

  return {
    kind: "file_rpc",
    cwd: readTarget.cwd,
    path: readTarget.path,
  };
}

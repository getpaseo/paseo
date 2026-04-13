import { fileUriToPath } from "@/attachments/utils";
import { isAbsolutePath } from "@/utils/path";

export type AssistantImageSourceResolution =
  | { kind: "direct"; uri: string }
  | { kind: "file_rpc"; cwd: string; path: string };

function trimTrailingSeparators(value: string): string {
  if (value === "/" || /^[A-Za-z]:[\\/]?$/.test(value)) {
    return value.replace(/\\/g, "/");
  }
  return value.replace(/[\\/]+$/, "");
}

function normalizeForPathComparison(value: string): string {
  const normalized = trimTrailingSeparators(value.replace(/\\/g, "/"));
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`;
  }
  return normalized;
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const candidate = normalizeForPathComparison(candidatePath);
  const root = normalizeForPathComparison(rootPath);
  if (!candidate || !root) {
    return false;
  }
  if (root === "/") {
    return candidate.startsWith("/");
  }
  if (candidate === root) {
    return true;
  }
  return candidate.startsWith(`${root}/`);
}

function deriveFallbackRootFromAbsolutePath(value: string): string | null {
  if (value.startsWith("/")) {
    return "/";
  }

  const driveMatch = /^([A-Za-z]:)[\\/]/.exec(value);
  if (driveMatch?.[1]) {
    return `${driveMatch[1]}/`;
  }

  const uncMatch = /^(\\\\[^\\]+\\[^\\]+)/.exec(value);
  if (uncMatch?.[1]) {
    return uncMatch[1];
  }

  return null;
}

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

  if (!isAbsolutePath(sourcePath)) {
    const workspaceRoot = input.workspaceRoot?.trim();
    if (!workspaceRoot || !isAbsolutePath(workspaceRoot)) {
      return null;
    }
    return {
      kind: "file_rpc",
      cwd: workspaceRoot,
      path: sourcePath,
    };
  }

  const workspaceRoot = input.workspaceRoot?.trim();
  if (
    workspaceRoot &&
    isAbsolutePath(workspaceRoot) &&
    isPathWithinRoot(sourcePath, workspaceRoot)
  ) {
    return {
      kind: "file_rpc",
      cwd: workspaceRoot,
      path: sourcePath,
    };
  }

  const fallbackRoot = deriveFallbackRootFromAbsolutePath(sourcePath);
  if (!fallbackRoot) {
    return null;
  }

  return {
    kind: "file_rpc",
    cwd: fallbackRoot,
    path: sourcePath,
  };
}

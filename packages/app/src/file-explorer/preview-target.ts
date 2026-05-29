import { isAbsolutePath } from "@/utils/path";

export interface FilePreviewReadTarget {
  cwd: string;
  path: string;
}

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

function deriveFilesystemRootFromAbsolutePath(value: string): string | null {
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

function isHomeRelativePath(value: string): boolean {
  return value === "~" || value.startsWith("~/") || value.startsWith("~\\");
}

export function resolveFilePreviewReadTarget(input: {
  path: string;
  workspaceRoot?: string;
}): FilePreviewReadTarget | null {
  const previewPath = input.path.trim();
  if (!previewPath) {
    return null;
  }

  if (isHomeRelativePath(previewPath)) {
    return {
      cwd: "~",
      path: previewPath,
    };
  }

  const workspaceRoot = input.workspaceRoot?.trim();
  if (!isAbsolutePath(previewPath)) {
    if (!workspaceRoot || !isAbsolutePath(workspaceRoot)) {
      return null;
    }
    return {
      cwd: workspaceRoot,
      path: previewPath,
    };
  }

  if (
    workspaceRoot &&
    isAbsolutePath(workspaceRoot) &&
    isPathWithinRoot(previewPath, workspaceRoot)
  ) {
    return {
      cwd: workspaceRoot,
      path: previewPath,
    };
  }

  const filesystemRoot = deriveFilesystemRootFromAbsolutePath(previewPath);
  if (!filesystemRoot) {
    return null;
  }

  return {
    cwd: filesystemRoot,
    path: previewPath,
  };
}

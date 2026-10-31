import {
  collapsePathSegments,
  isAbsolutePath,
  isHomeRelativePath,
  isPathWithinRoot,
} from "@/utils/path";

export interface FilePreviewReadTarget {
  cwd: string;
  path: string;
}

/**
 * File reads are scoped to `cwd`. Home-relative paths that still contain `..` after collapse
 * resolve outside `$HOME`, so the read root has to be the directory that contains the file.
 */
function homePreviewCwd(normalized: string): string {
  const collapsed = collapsePathSegments(normalized);
  const browsed = collapsed.replace(/\/+$/, "");
  if (browsed !== "~/.." && !browsed.startsWith("~/../")) {
    return "~";
  }
  const separator = browsed.lastIndexOf("/");
  const parent = separator > 0 ? browsed.slice(0, separator) : browsed;
  return parent === "~" ? browsed : parent;
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
      cwd: homePreviewCwd(previewPath.replace(/\\/g, "/")),
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

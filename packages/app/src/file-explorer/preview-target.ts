import { isAbsolutePath, isHomeRelativePath, isPathWithinRoot } from "@/utils/path";

export interface FilePreviewReadTarget {
  cwd: string;
  path: string;
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

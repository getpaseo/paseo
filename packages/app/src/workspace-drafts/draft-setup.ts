import type { WorkspaceDraftTabSetup } from "@/stores/workspace-tabs-store";

function trimPath(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function normalizePathForComparison(value: string): string {
  const normalized = trimPath(value).replace(/\\/g, "/");
  if (normalized === "/") {
    return normalized;
  }
  return normalized.replace(/\/+$/, "");
}

function getRelativePathWithinSource(input: {
  sourceDirectory: string | null | undefined;
  cwd: string;
}): string | null {
  const sourceDirectory = normalizePathForComparison(input.sourceDirectory ?? "");
  const cwd = normalizePathForComparison(input.cwd);
  if (!sourceDirectory || !cwd) {
    return null;
  }
  if (cwd === sourceDirectory) {
    return "";
  }
  const prefix = sourceDirectory.endsWith("/") ? sourceDirectory : `${sourceDirectory}/`;
  return cwd.startsWith(prefix) ? cwd.slice(prefix.length) : null;
}

function getOutputSeparator(workspaceDirectory: string): "/" | "\\" {
  return workspaceDirectory.includes("\\") && !workspaceDirectory.includes("/") ? "\\" : "/";
}

function joinWorkspaceRelativePath(input: {
  workspaceDirectory: string;
  relativePath: string;
}): string {
  const workspaceDirectory = trimPath(input.workspaceDirectory).replace(/[\\/]+$/, "");
  if (!input.relativePath) {
    return workspaceDirectory;
  }
  const separator = getOutputSeparator(input.workspaceDirectory);
  const relativeParts = input.relativePath.split("/").filter(Boolean);
  return [workspaceDirectory, ...relativeParts].join(separator);
}

export function remapWorkspaceDraftSetupForWorkspace(input: {
  setup: WorkspaceDraftTabSetup;
  sourceDirectory?: string | null;
  workspaceDirectory: string;
}): WorkspaceDraftTabSetup {
  const relativePath = getRelativePathWithinSource({
    sourceDirectory: input.sourceDirectory,
    cwd: input.setup.cwd,
  });
  const workspaceDirectory = trimPath(input.workspaceDirectory);
  const cwd =
    relativePath === null
      ? workspaceDirectory
      : joinWorkspaceRelativePath({ workspaceDirectory, relativePath });
  return {
    ...input.setup,
    cwd,
  };
}

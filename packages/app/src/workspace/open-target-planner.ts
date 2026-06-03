import { buildGitHubBlobUrl, buildGitHubBranchTreeUrl } from "@/git/github-url";
import type { DesktopOpenTarget, OpenDesktopTargetInput } from "@/workspace/desktop-open-targets";
import { resolveWorkspaceFilePaths, type WorkspaceFileLocation } from "@/workspace/file-open";

interface CheckoutStatusForOpenTarget {
  isGit: boolean;
  remoteUrl?: string | null;
  currentBranch?: string | null;
}

export interface PlannedDesktopOpenTarget {
  source: "desktop";
  id: string;
  label: string;
  editorId: string;
  openInput: OpenDesktopTargetInput;
}

export interface PlannedGitHubOpenTarget {
  source: "github";
  id: "github";
  label: "GitHub";
  url: string;
}

export type PlannedWorkspaceOpenTarget = PlannedDesktopOpenTarget | PlannedGitHubOpenTarget;

export interface PlanWorkspaceOpenTargetsInput {
  workspaceDirectory: string;
  activeFile?: WorkspaceFileLocation | null;
  desktopTargets: readonly DesktopOpenTarget[];
  canUseDesktopBridge: boolean;
  isLocalExecution: boolean;
  checkoutStatus?: CheckoutStatusForOpenTarget | null;
}

function planDesktopOpenTargets(input: {
  workspaceDirectory: string;
  activeFile?: WorkspaceFileLocation | null;
  desktopTargets: readonly DesktopOpenTarget[];
  canUseDesktopBridge: boolean;
  isLocalExecution: boolean;
}): PlannedDesktopOpenTarget[] {
  if (!input.canUseDesktopBridge || !input.isLocalExecution) {
    return [];
  }
  const resolvedFile = input.activeFile
    ? resolveWorkspaceFilePaths({
        path: input.activeFile.path,
        workspaceRoot: input.workspaceDirectory,
      })
    : null;

  return input.desktopTargets.map((target) => {
    if (!resolvedFile) {
      return {
        source: "desktop",
        id: target.id,
        label: target.label,
        editorId: target.id,
        openInput: { editorId: target.id, path: input.workspaceDirectory },
      };
    }
    if (target.kind === "editor") {
      return {
        source: "desktop",
        id: target.id,
        label: target.label,
        editorId: target.id,
        openInput: {
          editorId: target.id,
          path: resolvedFile.absolutePath,
          cwd: input.workspaceDirectory,
        },
      };
    }
    return {
      source: "desktop",
      id: target.id,
      label: target.label,
      editorId: target.id,
      openInput: {
        editorId: target.id,
        path: resolvedFile.absolutePath,
        mode: "reveal",
      },
    };
  });
}

function planGitHubOpenTarget(input: {
  workspaceDirectory: string;
  activeFile?: WorkspaceFileLocation | null;
  checkoutStatus?: CheckoutStatusForOpenTarget | null;
}): PlannedGitHubOpenTarget | null {
  if (!input.checkoutStatus?.isGit) {
    return null;
  }
  const resolvedFile = input.activeFile
    ? resolveWorkspaceFilePaths({
        path: input.activeFile.path,
        workspaceRoot: input.workspaceDirectory,
      })
    : null;
  const url = resolvedFile?.relativePath
    ? buildGitHubBlobUrl({
        remoteUrl: input.checkoutStatus.remoteUrl,
        branch: input.checkoutStatus.currentBranch,
        path: resolvedFile.relativePath,
        lineStart: input.activeFile?.lineStart,
        lineEnd: input.activeFile?.lineEnd,
      })
    : buildGitHubBranchTreeUrl({
        remoteUrl: input.checkoutStatus.remoteUrl,
        branch: input.checkoutStatus.currentBranch,
      });

  if (!url) {
    return null;
  }
  return {
    source: "github",
    id: "github",
    label: "GitHub",
    url,
  };
}

export function planWorkspaceOpenTargets(
  input: PlanWorkspaceOpenTargetsInput,
): PlannedWorkspaceOpenTarget[] {
  const desktopTargets = planDesktopOpenTargets(input);
  const githubTarget = planGitHubOpenTarget(input);
  return githubTarget ? [...desktopTargets, githubTarget] : desktopTargets;
}

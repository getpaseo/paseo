import { buildGitHubBlobUrl, buildGitHubBranchTreeUrl } from "@/git/github-url";
import type { DesktopOpenTarget, OpenDesktopTargetInput } from "@/workspace/desktop-open-targets";
import {
  type ResolvedWorkspaceFilePaths,
  resolveWorkspaceFilePaths,
  type WorkspaceFileLocation,
} from "@/workspace/file-open";

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
  resolvedActiveFile?: ResolvedWorkspaceFilePaths | null;
  desktopTargets: readonly DesktopOpenTarget[];
  canUseDesktopBridge: boolean;
  isLocalExecution: boolean;
  checkoutStatus?: CheckoutStatusForOpenTarget | null;
}

function resolveActiveFileForOpenTargets(
  input: Pick<
    PlanWorkspaceOpenTargetsInput,
    "activeFile" | "resolvedActiveFile" | "workspaceDirectory"
  >,
): ResolvedWorkspaceFilePaths | null {
  if (input.resolvedActiveFile !== undefined) {
    return input.resolvedActiveFile;
  }
  return input.activeFile
    ? resolveWorkspaceFilePaths({
        path: input.activeFile.path,
        workspaceRoot: input.workspaceDirectory,
      })
    : null;
}

function planDesktopOpenTargets(input: {
  workspaceDirectory: string;
  resolvedFile: ResolvedWorkspaceFilePaths | null;
  desktopTargets: readonly DesktopOpenTarget[];
  canUseDesktopBridge: boolean;
  isLocalExecution: boolean;
}): PlannedDesktopOpenTarget[] {
  if (!input.canUseDesktopBridge || !input.isLocalExecution) {
    return [];
  }

  return input.desktopTargets.map((target) => {
    if (!input.resolvedFile) {
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
          path: input.resolvedFile.absolutePath,
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
        path: input.resolvedFile.absolutePath,
        mode: "reveal",
      },
    };
  });
}

function planGitHubOpenTarget(input: {
  activeFile?: WorkspaceFileLocation | null;
  resolvedFile: ResolvedWorkspaceFilePaths | null;
  checkoutStatus?: CheckoutStatusForOpenTarget | null;
}): PlannedGitHubOpenTarget | null {
  if (!input.checkoutStatus?.isGit) {
    return null;
  }
  const url = input.resolvedFile?.relativePath
    ? buildGitHubBlobUrl({
        remoteUrl: input.checkoutStatus.remoteUrl,
        branch: input.checkoutStatus.currentBranch,
        path: input.resolvedFile.relativePath,
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
  const resolvedFile = resolveActiveFileForOpenTargets(input);
  const desktopTargets = planDesktopOpenTargets({ ...input, resolvedFile });
  const githubTarget = planGitHubOpenTarget({ ...input, resolvedFile });
  return githubTarget ? [...desktopTargets, githubTarget] : desktopTargets;
}

import { type Forge, forgeFromRemoteUrl, getForgePresentation } from "@/git/forge";
import type {
  DesktopOpenExecution,
  DesktopOpenTarget,
  OpenDesktopTargetInput,
} from "@/workspace/desktop-open-targets";
import {
  type ResolvedWorkspaceFilePaths,
  resolveWorkspaceFilePaths,
  type WorkspaceFileLocation,
} from "@/workspace/file-open";

export const DESKTOP_SETUP_TARGET_ID = "open-in-editor-setup";

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
  icon: DesktopOpenTarget["icon"];
  openInput: OpenDesktopTargetInput;
}

/**
 * Offered when the daemon runs elsewhere and no remote authority is configured yet. It is
 * the only way to find the feature without already knowing it exists, so it carries the
 * icon of an installed remote-capable editor and routes to host settings instead of
 * launching anything.
 */
export interface PlannedDesktopSetupTarget {
  source: "desktop-setup";
  id: typeof DESKTOP_SETUP_TARGET_ID;
  icon: DesktopOpenTarget["icon"];
}

export interface PlannedForgeOpenTarget {
  source: "forge";
  forge: Forge;
  id: Forge;
  label: string;
  url: string;
}

export type PlannedWorkspaceOpenTarget =
  | PlannedDesktopOpenTarget
  | PlannedDesktopSetupTarget
  | PlannedForgeOpenTarget;

export interface PlanWorkspaceOpenTargetsInput {
  workspaceDirectory: string;
  directoryPath?: string | null;
  activeFile?: WorkspaceFileLocation | null;
  resolvedActiveFile?: ResolvedWorkspaceFilePaths | null;
  desktopTargets: readonly DesktopOpenTarget[];
  canUseDesktopBridge: boolean;
  execution: DesktopOpenExecution | null;
  checkoutStatus?: CheckoutStatusForOpenTarget | null;
  forge?: Forge | null;
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
  directoryPath?: string | null;
  activeFile?: WorkspaceFileLocation | null;
  resolvedFile: ResolvedWorkspaceFilePaths | null;
  desktopTargets: readonly DesktopOpenTarget[];
  execution: Exclude<DesktopOpenExecution, { kind: "remote-unconfigured" }>;
}): PlannedDesktopOpenTarget[] {
  const remote =
    input.execution.kind === "remote" ? { remoteDestination: input.execution.destination } : {};

  const resolvedDirectory =
    input.directoryPath === undefined || input.directoryPath === null
      ? null
      : resolveWorkspaceFilePaths({
          path: input.directoryPath,
          workspaceRoot: input.workspaceDirectory,
        });
  if (input.directoryPath !== undefined && input.directoryPath !== null) {
    if (!resolvedDirectory?.relativePath) {
      return [];
    }
  }
  const workspacePath = resolvedDirectory?.absolutePath ?? input.workspaceDirectory;

  return input.desktopTargets.map((target) => {
    if (!input.resolvedFile) {
      return {
        source: "desktop",
        id: target.id,
        label: target.label,
        editorId: target.id,
        icon: target.icon,
        openInput: { editorId: target.id, workspacePath, ...remote },
      };
    }
    return {
      source: "desktop",
      id: target.id,
      label: target.label,
      editorId: target.id,
      icon: target.icon,
      openInput: {
        editorId: target.id,
        workspacePath,
        filePath: input.resolvedFile.absolutePath,
        ...(input.activeFile?.lineStart ? { line: input.activeFile.lineStart } : {}),
        ...remote,
      },
    };
  });
}

function buildForgeWebUrl(
  forge: Forge,
  input: {
    remoteUrl: string | null | undefined;
    branch: string | null | undefined;
    path: string | null;
    lineStart?: number;
    lineEnd?: number;
  },
): string | null {
  const presentation = getForgePresentation(forge);
  if (input.path) {
    return (
      presentation.buildBlobUrl?.({
        remoteUrl: input.remoteUrl,
        branch: input.branch,
        path: input.path,
        lineStart: input.lineStart,
        lineEnd: input.lineEnd,
      }) ?? null
    );
  }
  return (
    presentation.buildBranchTreeUrl?.({
      remoteUrl: input.remoteUrl,
      branch: input.branch,
    }) ?? null
  );
}

function planForgeOpenTarget(input: {
  activeFile?: WorkspaceFileLocation | null;
  resolvedFile: ResolvedWorkspaceFilePaths | null;
  checkoutStatus?: CheckoutStatusForOpenTarget | null;
  forge?: Forge | null;
}): PlannedForgeOpenTarget | null {
  if (!input.checkoutStatus?.isGit) {
    return null;
  }
  const forge = input.forge ?? forgeFromRemoteUrl(input.checkoutStatus.remoteUrl) ?? null;
  if (!forge) {
    return null;
  }
  const url = buildForgeWebUrl(forge, {
    remoteUrl: input.checkoutStatus.remoteUrl,
    branch: input.checkoutStatus.currentBranch,
    path: input.resolvedFile?.relativePath ?? null,
    lineStart: input.activeFile?.lineStart,
    lineEnd: input.activeFile?.lineEnd,
  });
  if (!url) {
    return null;
  }
  return {
    source: "forge",
    forge,
    id: forge,
    label: getForgePresentation(forge).brandLabel,
    url,
  };
}

function planDesktopSetupTarget(
  desktopTargets: readonly DesktopOpenTarget[],
): PlannedDesktopSetupTarget | null {
  const editor = desktopTargets.find(
    (target) => target.kind === "editor" && target.remoteDestinationKinds.length > 0,
  );
  if (!editor) {
    return null;
  }
  return { source: "desktop-setup", id: DESKTOP_SETUP_TARGET_ID, icon: editor.icon };
}

function planDesktopTargets(
  input: PlanWorkspaceOpenTargetsInput & { resolvedFile: ResolvedWorkspaceFilePaths | null },
): (PlannedDesktopOpenTarget | PlannedDesktopSetupTarget)[] {
  if (!input.canUseDesktopBridge || !input.execution) {
    return [];
  }
  if (input.execution.kind === "remote-unconfigured") {
    const setupTarget = planDesktopSetupTarget(input.desktopTargets);
    return setupTarget ? [setupTarget] : [];
  }
  return planDesktopOpenTargets({ ...input, execution: input.execution });
}

export function planWorkspaceOpenTargets(
  input: PlanWorkspaceOpenTargetsInput,
): PlannedWorkspaceOpenTarget[] {
  const resolvedFile = resolveActiveFileForOpenTargets(input);
  const desktopTargets = planDesktopTargets({ ...input, resolvedFile });
  const forgeTarget = planForgeOpenTarget({ ...input, resolvedFile });
  return forgeTarget ? [...desktopTargets, forgeTarget] : desktopTargets;
}

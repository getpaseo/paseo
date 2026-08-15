import type { PaseoConfigRaw } from "@getpaseo/protocol/messages";
import { isPaseoPlatformCommand } from "@getpaseo/protocol/paseo-config-schema";
import { i18n } from "@/i18n/i18next";
import { buildProjectSettingsRoute } from "@/utils/host-routes";

export interface WorktreeSetupWorkspaceInput {
  projectId: string;
  projectKind: string;
  projectRootPath: string;
}

export interface ActiveGitWorkspaceProject {
  serverId: string;
  projectId: string;
  repoRoot: string;
}

interface ReadProjectConfigResult {
  ok: boolean;
  config?: PaseoConfigRaw | null;
}

export interface WorktreeSetupCalloutPolicy {
  id: string;
  dismissalKey: string;
  priority: number;
  title: string;
  description: string;
  actionLabel: string;
  projectSettingsRoute: ReturnType<typeof buildProjectSettingsRoute>;
  testID: string;
}

export function selectActiveGitWorkspaceProject(
  serverId: string,
  workspace: WorktreeSetupWorkspaceInput,
): ActiveGitWorkspaceProject | null {
  if (workspace.projectKind !== "git") {
    return null;
  }

  const projectId = workspace.projectId;
  const repoRoot = workspace.projectRootPath.trim();
  if (!projectId.trim() || !repoRoot) {
    return null;
  }

  return { serverId, projectId, repoRoot };
}

export function shouldShowWorktreeSetupCallout(readResult: ReadProjectConfigResult | undefined) {
  return readResult?.ok === true && !hasSetupCommands(readResult.config ?? {});
}

export function buildWorktreeSetupCalloutPolicy(
  project: ActiveGitWorkspaceProject,
): WorktreeSetupCalloutPolicy {
  const calloutKey = `worktree-setup-missing:${project.serverId}:${project.projectId}`;

  return {
    id: calloutKey,
    dismissalKey: calloutKey,
    priority: 100,
    title: i18n.t("sidebar.worktreeSetup.title"),
    description: i18n.t("sidebar.worktreeSetup.description"),
    actionLabel: i18n.t("sidebar.worktreeSetup.openProjectSettings"),
    projectSettingsRoute: buildProjectSettingsRoute(project.serverId, project.projectId),
    testID: `worktree-setup-callout-${project.projectId}`,
  };
}

function hasSetupCommands(config: PaseoConfigRaw): boolean {
  const setup = config.worktree?.setup;
  if (typeof setup === "string") {
    return setup.trim().length > 0;
  }
  if (Array.isArray(setup)) {
    return setup.some((command) => typeof command === "string" && command.trim().length > 0);
  }
  if (isPaseoPlatformCommand(setup)) {
    return Object.values(setup).some((command) => {
      if (typeof command === "string") return command.trim().length > 0;
      if (!Array.isArray(command)) return false;
      return command.some((entry) => typeof entry === "string" && entry.trim().length > 0);
    });
  }
  return false;
}

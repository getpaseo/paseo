import type { PaseoConfigRaw } from "@getpaseo/protocol/messages";
import { i18n } from "@/i18n/i18next";
import { resolveProjectKey } from "@/projects/project-key";
import { resolveHostProjectSettingsRouteKey } from "@/projects/project-settings-target";
import { buildProjectSettingsRoute } from "@/utils/host-routes";

export interface WorktreeSetupWorkspaceInput {
  projectId: string;
  projectKey?: string | null;
  projectKind: string;
  projectRootPath: string;
}

export interface ActiveGitWorkspaceProject {
  serverId: string;
  projectId: string;
  projectKey: string;
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
  const projectKey = resolveProjectKey({
    serverId,
    projectId,
    projectKey: workspace.projectKey,
  });
  const repoRoot = workspace.projectRootPath.trim();
  if (!projectId.trim() || !repoRoot) {
    return null;
  }

  return { serverId, projectId, projectKey, repoRoot };
}

export function shouldShowWorktreeSetupCallout(readResult: ReadProjectConfigResult | undefined) {
  return readResult?.ok === true && !hasSetupCommands(readResult.config ?? {});
}

export function buildWorktreeSetupCalloutPolicy(
  project: ActiveGitWorkspaceProject,
): WorktreeSetupCalloutPolicy {
  const projectSettingsKey = resolveHostProjectSettingsRouteKey({
    serverId: project.serverId,
    projectId: project.projectId,
  });
  const calloutKey = `worktree-setup-missing:${projectSettingsKey ?? project.projectKey}`;

  return {
    id: calloutKey,
    dismissalKey: calloutKey,
    priority: 100,
    title: i18n.t("sidebar.worktreeSetup.title"),
    description: i18n.t("sidebar.worktreeSetup.description"),
    actionLabel: i18n.t("sidebar.worktreeSetup.openProjectSettings"),
    projectSettingsRoute: buildProjectSettingsRoute(projectSettingsKey ?? project.projectKey),
    testID: `worktree-setup-callout-${project.projectKey}`,
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
  return false;
}

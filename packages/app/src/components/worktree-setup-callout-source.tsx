import { useQuery } from "@tanstack/react-query";
import type { PaseoConfigRaw } from "@server/shared/messages";
import { useRouter } from "expo-router";
import { useEffect } from "react";
import { useSidebarCallouts } from "@/contexts/sidebar-callout-context";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useNavigationActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { buildProjectSettingsRoute } from "@/utils/host-routes";

interface ActiveGitWorkspaceProject {
  serverId: string;
  projectKey: string;
  repoRoot: string;
}

function selectActiveGitWorkspaceProject(
  serverId: string,
  workspace: WorkspaceDescriptor,
): ActiveGitWorkspaceProject | null {
  if (workspace.projectKind !== "git") {
    return null;
  }

  const projectKey = workspace.projectId.trim();
  const repoRoot = (workspace.project?.checkout.mainRepoRoot ?? workspace.projectRootPath).trim();
  if (!projectKey || !repoRoot) {
    return null;
  }

  return { serverId, projectKey, repoRoot };
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

export function WorktreeSetupCalloutSource() {
  const selection = useNavigationActiveWorkspaceSelection();
  const activeProject = useWorkspaceFields(
    selection?.serverId ?? null,
    selection?.workspaceId ?? null,
    (workspace) => selectActiveGitWorkspaceProject(selection?.serverId ?? "", workspace),
  );
  const client = useHostRuntimeClient(activeProject?.serverId ?? "");
  const callouts = useSidebarCallouts();
  const router = useRouter();
  const openProjectSettings = useStableEvent(() => {
    if (!activeProject) {
      return;
    }
    router.navigate(buildProjectSettingsRoute(activeProject.projectKey));
  });

  const readQuery = useQuery({
    queryKey: ["project-config", activeProject?.serverId ?? "", activeProject?.repoRoot ?? ""],
    queryFn: () => {
      if (!client || !activeProject) {
        throw new Error("Project config query requires an active git workspace");
      }
      return client.readProjectConfig(activeProject.repoRoot);
    },
    enabled: Boolean(client && activeProject),
    retry: false,
  });

  const shouldShow =
    activeProject !== null &&
    readQuery.data?.ok === true &&
    !hasSetupCommands(readQuery.data.config ?? {});

  useEffect(() => {
    if (!shouldShow || !activeProject) {
      return;
    }

    return callouts.show({
      id: `worktree-setup-missing:${activeProject.projectKey}`,
      dismissalKey: `worktree-setup-missing:${activeProject.projectKey}`,
      priority: 100,
      title: "Set up worktree scripts",
      description:
        "Add setup commands so new worktrees can install dependencies and prepare themselves automatically.",
      actions: [
        { label: "Open project settings", onPress: openProjectSettings, variant: "primary" },
      ],
      testID: `worktree-setup-callout-${activeProject.projectKey}`,
    });
  }, [activeProject, callouts, openProjectSettings, shouldShow]);

  return null;
}

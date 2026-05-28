import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useEffect, useMemo } from "react";
import { useSidebarCallouts } from "@/contexts/sidebar-callout-context";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import {
  buildWorktreeSetupCalloutPolicy,
  selectActiveGitWorkspaceProject,
  shouldShowWorktreeSetupCallout,
} from "./worktree-setup-callout-policy";

export function WorktreeSetupCalloutSource() {
  const selection = useActiveWorkspaceSelection();
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
    router.navigate(buildWorktreeSetupCalloutPolicy(activeProject).projectSettingsRoute);
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

  const calloutPolicy = useMemo(
    () =>
      activeProject && shouldShowWorktreeSetupCallout(readQuery.data)
        ? buildWorktreeSetupCalloutPolicy(activeProject)
        : null,
    [activeProject, readQuery.data],
  );

  useEffect(() => {
    if (!calloutPolicy) {
      return;
    }

    return callouts.show({
      id: calloutPolicy.id,
      dismissalKey: calloutPolicy.dismissalKey,
      priority: calloutPolicy.priority,
      title: calloutPolicy.title,
      description: calloutPolicy.description,
      actions: [
        { label: calloutPolicy.actionLabel, onPress: openProjectSettings, variant: "primary" },
      ],
      testID: calloutPolicy.testID,
    });
  }, [calloutPolicy, callouts, openProjectSettings]);

  return null;
}

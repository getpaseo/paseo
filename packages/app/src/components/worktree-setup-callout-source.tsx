import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useEffect, useMemo } from "react";
import { useSidebarCallouts } from "@/contexts/sidebar-callout-context";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { buildDraftStoreKey, generateDraftId } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import {
  navigateToWorkspace,
  useActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";
import {
  buildWorktreeSetupCalloutPolicy,
  selectActiveGitWorkspaceProject,
  shouldShowWorktreeSetupCallout,
} from "./worktree-setup-callout-policy";

// Sent to an agent, not shown as UI copy, so it stays untranslated.
const WORKTREE_SETUP_AGENT_PROMPT = `Set up Paseo worktree config for this repository.

Read https://paseo.sh/docs/worktrees and https://paseo.sh/docs/worktrees/worktreeinclude, then inspect the repo (package files, lockfiles, README/CONTRIBUTING, Makefile/justfile, Docker/Procfile, \`scripts/\`, \`bin/\`) and create or update \`paseo.json\` in the repo root.

- Keep existing settings unless they are clearly wrong.
- \`worktree.setup\` installs dependencies and prepares a fresh worktree, using the repo's package manager and conventions. Add \`worktree.teardown\` only if archiving needs cleanup.
- Add \`scripts\` for day-to-day commands. Run dev servers as services on \`$PASEO_PORT\` so several worktrees can run at once.
- List gitignored files that setup needs, such as \`.env\`, in \`.worktreeinclude\` instead of copying them in setup.
- Commands must be non-interactive, non-destructive and safe to run inside a worktree.

Paseo reads \`paseo.json\` from the committed base branch, usually \`main\`. If this workspace is on another branch, tell me. Ask me before committing or merging.

Finish by validating the JSON, summarising what you configured and why, and giving me one quick test.`;

export function WorktreeSetupCalloutSource() {
  const selection = useActiveWorkspaceSelection();
  const selectedWorkspaceProject = useWorkspaceFields(
    selection?.serverId ?? null,
    selection?.workspaceId ?? null,
    (workspace) => selectActiveGitWorkspaceProject(selection?.serverId ?? "", workspace),
  );
  const activeProject = selectedWorkspaceProject;
  const client = useHostRuntimeClient(activeProject?.serverId ?? "");
  const callouts = useSidebarCallouts();
  const router = useRouter();
  const openProjectSettings = useStableEvent(() => {
    if (!activeProject) {
      return;
    }
    router.navigate(buildWorktreeSetupCalloutPolicy(activeProject).projectSettingsRoute);
  });
  const askAgent = useStableEvent(() => {
    if (!selection) {
      return;
    }
    const target = { kind: "draft", draftId: generateDraftId() } as const;
    useDraftStore.getState().saveDraftInput({
      draftKey: buildDraftStoreKey({
        serverId: selection.serverId,
        agentId: buildDeterministicWorkspaceTabId(target),
        draftId: target.draftId,
      }),
      draft: { text: WORKTREE_SETUP_AGENT_PROMPT, attachments: [] },
    });
    navigateToWorkspace({
      serverId: selection.serverId,
      workspaceId: selection.workspaceId,
      target,
    });
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
        { label: calloutPolicy.askAgentLabel, onPress: askAgent, variant: "primary" },
        { label: calloutPolicy.addManuallyLabel, onPress: openProjectSettings },
      ],
      testID: calloutPolicy.testID,
    });
  }, [askAgent, calloutPolicy, callouts, openProjectSettings]);

  return null;
}

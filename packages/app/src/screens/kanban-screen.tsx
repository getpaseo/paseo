// KanbanScreen — main screen for the task kanban board
// Workspaces with kanbanStatus are the source of truth for kanban entries.

import { useCallback, useMemo, useState } from "react";
import { View, Text } from "react-native";
import { useRouter } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KanbanBoard } from "@/components/kanban/kanban-board";
import {
  TaskCreationModal,
  type TaskCreationSubmission,
} from "@/components/kanban/task-creation-modal";
import type { KanbanTask } from "@/types/kanban";
import type { TaskMetadata } from "@/types/integrations";
import { buildHostAgentDetailRoute, buildHostWorkspaceRoute } from "@/utils/host-routes";
import { prepareWorkspaceTab } from "@/utils/workspace-navigation";
import {
  useSessionStore,
  normalizeWorkspaceDescriptor,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import { useCliAgentLaunch } from "@/hooks/use-cli-agent-launch";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import type { CliProviderId } from "@server/shared/cli-provider-registry";
import { projectDisplayNameFromProjectId } from "@/utils/project-display-name";
import { buildTaskAgentPrompt } from "@/lib/task-agent-prompt";
import { useActiveOrgId } from "@/stores/active-org-store";

interface KanbanScreenProps {
  serverId: string;
  projectId: string;
}

/** Convert a WorkspaceDescriptor (with kanbanStatus) to a KanbanTask for the board. */
function workspaceToKanbanTask(workspace: WorkspaceDescriptor, serverId: string): KanbanTask {
  return {
    id: workspace.id,
    name: workspace.name,
    serverId,
    projectId: workspace.projectId,
    projectName: workspace.projectDisplayName,
    path: workspace.id,
    createdAt: new Date().toISOString(),
    prompt: workspace.prompt,
    autoApprove: workspace.autoApprove,
    useWorktree: workspace.workspaceKind === "worktree",
    integrations: workspace.issueContext,
    metadata: workspace.issueMetadata as TaskMetadata | undefined,
    agentProvider: workspace.agentProvider,
    agentMode: workspace.agentMode,
  };
}

export function KanbanScreen({ serverId, projectId }: KanbanScreenProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const sessionWorkspaces = useSessionStore((state) => state.sessions[serverId]?.workspaces);
  const mergeWorkspaces = useSessionStore((state) => state.mergeWorkspaces);
  const setAgents = useSessionStore((state) => state.setAgents);
  const { launch: launchCliAgent } = useCliAgentLaunch(serverId);
  const activeOrgId = useActiveOrgId();

  const projectWorkspaces = useMemo(() => {
    const workspaces = sessionWorkspaces ? Array.from(sessionWorkspaces.values()) : [];
    return workspaces.filter((workspace) => {
      if (workspace.projectId !== projectId) return false;
      // Hide workspaces scoped to a different org. Unscoped (legacy) workspaces
      // remain visible so existing boards don't go empty after upgrade.
      if (activeOrgId && workspace.orgId && workspace.orgId !== activeOrgId) return false;
      return true;
    });
  }, [projectId, sessionWorkspaces, activeOrgId]);

  // All worktree workspaces are shown in the kanban. Workspaces with explicit
  // kanbanStatus use that status; worktrees without one default to "todo".
  const kanbanWorkspaces = useMemo(
    () => projectWorkspaces.filter((w) => w.kanbanStatus || w.workspaceKind === "worktree"),
    [projectWorkspaces],
  );

  const projectTasks = useMemo(
    () => kanbanWorkspaces.map((w) => workspaceToKanbanTask(w, serverId)),
    [kanbanWorkspaces, serverId],
  );

  const statusByTask = useMemo(() => {
    const map: Record<string, "todo" | "in-progress" | "done"> = {};
    for (const w of kanbanWorkspaces) {
      map[w.id] = w.kanbanStatus ?? "todo";
    }
    return map;
  }, [kanbanWorkspaces]);

  const fallbackWorkspaceId = useMemo(() => {
    const preferredWorkspace =
      projectWorkspaces.find((workspace) => workspace.projectKind === "git") ??
      projectWorkspaces[0];
    return preferredWorkspace?.id?.trim() || null;
  }, [projectWorkspaces]);

  const projectName = useMemo(() => {
    const workspaceName = projectWorkspaces[0]?.projectDisplayName?.trim();
    return workspaceName || projectDisplayNameFromProjectId(projectId);
  }, [projectId, projectWorkspaces]);

  const handleStatusChange = useCallback(
    (taskId: string, status: "todo" | "in-progress" | "done") => {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client || !isHostRuntimeConnected(getHostRuntimeStore().getSnapshot(serverId))) {
        toast.error("Host is not connected");
        return;
      }
      void client.updateWorkspaceMetadata({
        workspaceId: taskId,
        changes: { kanbanStatus: status },
      });
    },
    [serverId, toast],
  );

  const resolveTaskInitialPrompt = useCallback((task: KanbanTask) => {
    const existingPrompt = task.prompt?.trim() ?? "";
    if (!task.metadata) {
      return existingPrompt || undefined;
    }

    const alreadySeeded =
      existingPrompt.startsWith("Linked ") || existingPrompt.includes("\n\nTask instructions:\n");
    if (alreadySeeded) {
      return existingPrompt;
    }

    return (
      buildTaskAgentPrompt({
        prompt: existingPrompt,
        metadata: task.metadata,
      }) ?? undefined
    );
  }, []);

  const handleOpenTask = useCallback(
    async (task: KanbanTask) => {
      try {
        const workspaceId = task.path?.trim();
        if (!workspaceId) {
          toast.error("This task is not linked to a workspace yet");
          return;
        }

        // Navigate to workspace directly
        router.navigate(buildHostWorkspaceRoute(serverId, workspaceId));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    },
    [router, serverId, toast],
  );

  const handleCreateTask = useCallback(() => {
    setShowCreateModal(true);
  }, []);

  const handleTaskCreated = useCallback(
    async (submission: TaskCreationSubmission) => {
      try {
        const baseWorkspaceId = submission.workspacePath?.trim() || fallbackWorkspaceId;
        if (!baseWorkspaceId) {
          toast.error("No workspace available to open this task");
          return;
        }

        const client = getHostRuntimeStore().getClient(serverId);
        if (!client || !isHostRuntimeConnected(getHostRuntimeStore().getSnapshot(serverId))) {
          toast.error("Host is not connected");
          return;
        }

        if (submission.useWorktree) {
          const payload = await client.createHubcodeWorktree({
            cwd: baseWorkspaceId,
            worktreeSlug: submission.taskName,
            workspaceName: submission.taskName,
            issueContext: submission.integrations,
            issueMetadata: submission.metadata as Record<string, unknown> | undefined,
            prompt: submission.prompt,
            autoApprove: submission.autoApprove,
            kanbanStatus: "todo",
            agentProvider: submission.agentSelection?.id,
            agentMode: submission.agentSelection?.mode === "cli" ? "cli" : "native",
            orgId: activeOrgId ?? undefined,
          });
          if (payload.error || !payload.workspace) {
            throw new Error(payload.error ?? "Failed to create workspace for task");
          }
          mergeWorkspaces(serverId, [normalizeWorkspaceDescriptor(payload.workspace)]);
        } else {
          // Use existing workspace — update its metadata
          await client.updateWorkspaceMetadata({
            workspaceId: baseWorkspaceId,
            changes: {
              issueContext: submission.integrations,
              issueMetadata: submission.metadata as Record<string, unknown> | undefined,
              prompt: submission.prompt,
              autoApprove: submission.autoApprove,
              kanbanStatus: "todo",
              agentProvider: submission.agentSelection?.id,
              agentMode: submission.agentSelection?.mode === "cli" ? "cli" : "native",
            },
          });
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    },
    [fallbackWorkspaceId, mergeWorkspaces, serverId, toast],
  );

  return (
    <View style={[screenStyles.container, { paddingTop: insets.top }]}>
      <View style={screenStyles.header}>
        <Text style={screenStyles.title}>{projectName}</Text>
        <Text style={screenStyles.subtitle}>Tasks</Text>
      </View>
      <KanbanBoard
        serverId={serverId}
        tasks={projectTasks}
        statusByTask={statusByTask}
        onStatusChange={handleStatusChange}
        onOpenTask={handleOpenTask}
        onCreateTask={handleCreateTask}
      />
      <TaskCreationModal
        visible={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onTaskCreated={handleTaskCreated}
        serverId={serverId}
        projectId={projectId}
        projectName={projectName}
      />
    </View>
  );
}

const screenStyles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  header: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
  },
  title: {
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  subtitle: {
    marginTop: theme.spacing[1],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));

import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/contexts/toast-context";
import { useProjects } from "@/hooks/use-projects";
import { useHostFeatureMap } from "@/runtime/host-features";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { type CreateTaskInput, TaskFormSheet } from "@/screens/backlog-screen";
import { useCreateBacklogTaskStore } from "@/stores/create-backlog-task-store";
import {
  buildMasterBacklogProjectOptionId,
  buildMasterBacklogProjectTargets,
} from "@/tasks/master-backlog";

const TASKS_QUERY_KEY = "tasks";

/**
 * Global "Add backlog task" sheet. Stays on the current screen; opened from the
 * sidebar Backlog + control or a project three-dot menu.
 */
export function CreateBacklogTaskHost() {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const request = useCreateBacklogTaskStore((state) => state.request);
  const closeCreateBacklogTask = useCreateBacklogTaskStore((state) => state.closeCreateBacklogTask);
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const { projects } = useProjects();
  const allServerIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const supportsBacklogByServerId = useHostFeatureMap(allServerIds, "taskBacklog");
  const projectTargets = useMemo(
    () =>
      buildMasterBacklogProjectTargets({
        projects,
        supportsBacklogByServerId,
      }),
    [projects, supportsBacklogByServerId],
  );

  const preferredTargetOptionId = useMemo(() => {
    if (!request?.preferredServerId || !request.preferredProjectId) {
      return undefined;
    }
    return buildMasterBacklogProjectOptionId(request.preferredServerId, request.preferredProjectId);
  }, [request?.preferredProjectId, request?.preferredServerId]);

  const preferredProjectName = useMemo(() => {
    if (!preferredTargetOptionId) {
      return request?.preferredProjectName;
    }
    return (
      projectTargets.find((target) => target.optionId === preferredTargetOptionId)?.projectName ??
      request?.preferredProjectName
    );
  }, [preferredTargetOptionId, projectTargets, request?.preferredProjectName]);

  const handleCreate = useCallback(
    async (input: CreateTaskInput) => {
      const target = input.target;
      if (!target) {
        throw new Error("Project is required");
      }
      const client = runtime.getClient(target.serverId);
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const uploaded = await Promise.all(
        input.attachments.map(async (attachment) => {
          const result = await client.uploadFile({
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            bytes: attachment.bytes,
          });
          if (result.error || !result.file) {
            throw new Error(result.error ?? `Failed to upload ${attachment.fileName}`);
          }
          return result.file;
        }),
      );
      const payload = await client.createTask({
        projectId: target.projectId,
        title: input.title,
        description: input.description,
        attachments: uploaded,
      });
      if (payload.error || !payload.task) {
        throw new Error(payload.error ?? "Failed to add task");
      }
      await queryClient.invalidateQueries({ queryKey: [TASKS_QUERY_KEY] });
      toast.show("Task added", { variant: "success" });
    },
    [queryClient, runtime, t, toast],
  );

  return (
    <TaskFormSheet
      visible={request !== null}
      projectName={preferredProjectName}
      projectTargets={projectTargets}
      preferredTargetOptionId={preferredTargetOptionId}
      onClose={closeCreateBacklogTask}
      onCreate={handleCreate}
    />
  );
}

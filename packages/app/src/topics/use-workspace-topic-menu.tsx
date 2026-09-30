import { useCallback, useState, type ReactNode } from "react";
import { useToast } from "@/contexts/toast-context";
import { useWorkspace } from "@/stores/session-store-hooks";
import { CombineIntoTopicDialog } from "./combine-into-topic-dialog";
import { useWorkspaceTopicActions } from "./use-workspace-topics";

/**
 * The workspace menu's topic actions. Row-level like rename: the dialog has to outlive the
 * kebab menu, which unmounts when an item is selected.
 */
export function useWorkspaceTopicMenu(input: { serverId: string; workspaceId: string }): {
  onCombineIntoTopic: () => void;
  onDetachFromTopic: (() => void) | undefined;
  topicDialog: ReactNode;
} {
  const { serverId, workspaceId } = input;
  const toast = useToast();
  const topic = useWorkspace(serverId, workspaceId)?.topic ?? null;
  const { assignTopic } = useWorkspaceTopicActions(serverId);
  const [open, setOpen] = useState(false);
  const onCombineIntoTopic = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const detach = useCallback(() => {
    void assignTopic(workspaceId, null).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error));
    });
  }, [assignTopic, toast, workspaceId]);
  return {
    onCombineIntoTopic,
    onDetachFromTopic: topic ? detach : undefined,
    topicDialog: (
      <CombineIntoTopicDialog
        visible={open}
        serverId={serverId}
        workspaceIds={[workspaceId]}
        onClose={close}
      />
    ),
  };
}

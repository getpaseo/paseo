import { create } from "zustand";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

interface WorkspaceRootTarget {
  serverId: string;
  workspaceId: string;
  cwd: string;
}

const useWorkspaceRootDialog = create<{ target: WorkspaceRootTarget | null }>(() => ({
  target: null,
}));

export function openWorkspaceRootDialog(target: WorkspaceRootTarget): void {
  useWorkspaceRootDialog.setState({ target });
}

function closeWorkspaceRootDialog(): void {
  useWorkspaceRootDialog.setState({ target: null });
}

export function WorkspaceRootHost() {
  const target = useWorkspaceRootDialog((state) => state.target);
  if (!target) return null;
  return <WorkspaceRootDialog key={`${target.serverId}:${target.workspaceId}`} target={target} />;
}

function WorkspaceRootDialog({ target }: { target: WorkspaceRootTarget }) {
  const { t } = useTranslation();
  const mutation = useMutation({
    mutationFn: async (cwd: string) => {
      const client = getHostRuntimeStore().getClient(target.serverId);
      if (!client) throw new Error(t("sidebar.workspace.toasts.hostDisconnected"));
      await client.setWorkspaceRoot(target.workspaceId, cwd.trim());
    },
  });
  return (
    <AdaptiveRenameModal
      visible
      title={t("sidebar.workspace.root.title")}
      initialValue={target.cwd}
      placeholder="/absolute/path/to/directory"
      submitLabel={t("sidebar.workspace.root.submit")}
      onClose={closeWorkspaceRootDialog}
      onSubmit={mutation.mutateAsync}
      testID="workspace-root-modal"
    />
  );
}

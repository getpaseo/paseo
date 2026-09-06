import { getHostProjectId, type HostProjectListItem } from "@/projects/host-project-model";
import type { TFunction } from "i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useProjects } from "@/hooks/use-projects";
import { useFetchQuery } from "@/data/query";
import { confirmDialog } from "@/utils/confirm-dialog";
import { LocalFilesSection } from "./section";

export function NewWorkspaceLocalFiles({
  client,
  serverId,
  project,
  isolation,
  supported,
}: {
  client: DaemonClient | null;
  serverId: string;
  project: HostProjectListItem | null;
  isolation: "local" | "worktree";
  supported: boolean;
}) {
  if (!supported || isolation !== "worktree" || !client || !project) return null;
  const projectId = getHostProjectId(project, serverId);
  if (!projectId) return null;
  return <LocalFilesCreationNotice client={client} serverId={serverId} projectId={projectId} />;
}

function LocalFilesCreationNotice({
  client,
  serverId,
  projectId,
}: {
  client: DaemonClient;
  serverId: string;
  projectId: string;
}) {
  const { projects } = useProjects();
  const host = projects
    .flatMap((project) => project.hosts)
    .find((entry) => entry.serverId === serverId && entry.projectId === projectId);
  const config = useFetchQuery({
    dataShape: "value",
    queryKey: ["project-config", serverId, host?.repoRoot],
    queryFn: () => client.readProjectConfig(host!.repoRoot),
    enabled: Boolean(host),
    staleTimeMs: 0,
    retry: false,
  });
  if (!host || !config.data?.ok) return null;
  return (
    <LocalFilesSection
      host={host}
      client={client}
      configuredPaths={config.data.config?.worktree?.localFiles ?? []}
      missingOnly
    />
  );
}

export class LocalFilesCreationCanceled extends Error {}

export async function confirmMissingLocalFiles(
  client: DaemonClient,
  projectId: string,
  root: string,
  t: TFunction,
): Promise<boolean> {
  const config = await client.readProjectConfig(root);
  if (!config.ok) throw new Error(t("localFiles.errors.load_failed"));
  const paths = config.config?.worktree?.localFiles ?? [];
  if (paths.length === 0) return false;
  const inspection = await client.inspectProjectLocalFiles({ projectId, paths });
  if (inspection.error) throw new Error(t("localFiles.errors.load_failed"));
  const unavailable = inspection.files.filter((file) => file.status !== "ready");
  if (unavailable.some((file) => file.status !== "missing")) {
    throw new Error(
      t("localFiles.unavailableForWorktree", {
        files: unavailable.map((file) => file.path).join(", "),
      }),
    );
  }
  if (unavailable.length === 0) return false;
  const proceed = await confirmDialog({
    title: t("localFiles.missingTitle"),
    message: t("localFiles.missingConfirm", {
      files: unavailable.map((file) => file.path).join(", "),
      root,
    }),
    confirmLabel: t("localFiles.continueWithout"),
    cancelLabel: t("common.actions.cancel"),
  });
  if (!proceed) throw new LocalFilesCreationCanceled();
  return true;
}

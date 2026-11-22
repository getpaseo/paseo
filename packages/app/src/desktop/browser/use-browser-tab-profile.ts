import { useEffect, useMemo } from "react";
import { useFetchQuery } from "@/data/query";
import type { BrowserProfileEntry } from "@/desktop/host";
import { useBrowserHydrated, useBrowserStore } from "@/desktop/browser/store";
import { useHasHydratedWorkspaces } from "@/stores/session-store-hooks";
import { profilePartition, workspaceProfile } from "./profiles";

/**
 * Resolves the profile a browser tab attaches with. The partition depends only on server,
 * project and workspace IDs and the stored choice: a workspace rename relabels the tab but
 * must never change the partition, because the pane re-parks its webview when it changes.
 */
export function useBrowserTabProfile(input: {
  browserId: string;
  serverId: string;
  projectId: string | null;
  workspaceId: string;
  workspaceName: string;
}): {
  selected: BrowserProfileEntry | null;
  automatic: BrowserProfileEntry | null;
  partition: string | undefined;
  unavailable: boolean;
} {
  const { browserId, serverId, projectId, workspaceId, workspaceName } = input;
  const hasRecord = useBrowserStore((state) => Boolean(state.browsersById[browserId]));
  const stored = useBrowserStore((state) => state.browsersById[browserId]?.profile);
  const selected = typeof stored === "object" ? stored : null;
  const { data: automaticSlug } = useFetchQuery({
    dataShape: "value",
    queryKey: ["browser-workspace-profile", serverId, projectId, workspaceId],
    enabled: projectId !== null,
    queryFn: async () => (await workspaceProfile(serverId, projectId ?? "", workspaceId, "")).slug,
    immutableWhen: () => true,
  });
  const { data: partition } = useFetchQuery({
    dataShape: "value",
    queryKey: [
      "browser-profile-partition",
      selected?.group?.serverId ?? null,
      selected?.group?.projectId ?? null,
      selected?.slug ?? null,
    ],
    enabled: selected !== null,
    queryFn: () => profilePartition(selected ?? { group: null, slug: "", name: "" }),
    immutableWhen: () => true,
  });
  const automatic = useMemo(
    () =>
      projectId && automaticSlug
        ? { group: { serverId, projectId }, slug: automaticSlug, name: workspaceName }
        : null,
    [projectId, automaticSlug, serverId, workspaceName],
  );
  const browserHydrated = useBrowserHydrated();
  const workspacesHydrated = useHasHydratedWorkspaces(serverId);
  // A new tab waits for the persisted store, then takes its workspace's automatic profile.
  useEffect(() => {
    if (
      browserHydrated &&
      automatic &&
      useBrowserStore.getState().browsersById[browserId]?.profile === "pending"
    )
      useBrowserStore.getState().updateBrowser(browserId, { profile: automatic });
  }, [browserHydrated, browserId, automatic]);
  return {
    selected,
    automatic,
    partition: selected ? partition : undefined,
    unavailable:
      (browserHydrated && !hasRecord) || (workspacesHydrated && !projectId) || stored === "invalid",
  };
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useToast } from "@/contexts/toast-context";
import { redirectIfArchivingActiveWorkspace } from "@/utils/sidebar-workspace-archive-redirect";
import { selectProjectWorkspacesToArchive } from "@/workspace/project-workspace-archive";
import { archiveWorkspacesOptimistically } from "@/workspace/workspace-archive";
import { purgeArchivedWorkspaceState } from "@/workspace/use-workspace-archive";
import {
  reconcileWorkspaceSelection,
  resolveRemainingWorkspaceSelection,
  selectAvailableWorkspaceKeys,
  toggleWorkspaceSelection,
  workspaceTargetKey,
} from "@/components/sidebar/sidebar-workspace-selection-model";

interface SidebarWorkspaceSelectionController {
  isManaging: boolean;
  isArchiving: boolean;
  selectedCount: number;
  availableCount: number;
  allSelected: boolean;
  beginManaging: () => void;
  finishManaging: () => void;
  toggleWorkspace: (workspaceKey: string) => void;
  isWorkspaceSelected: (workspaceKey: string) => boolean;
  toggleSelectAll: () => void;
  archiveSelected: () => void;
}

const SidebarWorkspaceSelectionContext = createContext<SidebarWorkspaceSelectionController | null>(
  null,
);

export function SidebarWorkspaceSelectionProvider({
  workspaceEntriesByKey,
  children,
}: {
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const [isManaging, setIsManaging] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const archiveInFlightRef = useRef(false);
  const [selectedWorkspaceKeys, setSelectedWorkspaceKeys] = useState<Set<string>>(() => new Set());

  const availableWorkspaceKeys = useMemo(
    () => selectAvailableWorkspaceKeys(workspaceEntriesByKey),
    [workspaceEntriesByKey],
  );

  useEffect(() => {
    if (isArchiving) return;
    setSelectedWorkspaceKeys((current) =>
      reconcileWorkspaceSelection(current, workspaceEntriesByKey),
    );
  }, [isArchiving, workspaceEntriesByKey]);

  const beginManaging = useCallback(() => {
    setSelectedWorkspaceKeys(new Set());
    setIsManaging(true);
  }, []);

  const finishManaging = useCallback(() => {
    if (isArchiving) return;
    setSelectedWorkspaceKeys(new Set());
    setIsManaging(false);
  }, [isArchiving]);

  const toggleWorkspace = useCallback(
    (workspaceKey: string) => {
      if (isArchiving || !availableWorkspaceKeys.has(workspaceKey)) return;
      setSelectedWorkspaceKeys((current) => toggleWorkspaceSelection(current, workspaceKey));
    },
    [availableWorkspaceKeys, isArchiving],
  );

  const isWorkspaceSelected = useCallback(
    (workspaceKey: string) => selectedWorkspaceKeys.has(workspaceKey),
    [selectedWorkspaceKeys],
  );

  const allSelected =
    availableWorkspaceKeys.size > 0 && selectedWorkspaceKeys.size === availableWorkspaceKeys.size;
  const toggleSelectAll = useCallback(() => {
    if (isArchiving) return;
    setSelectedWorkspaceKeys(allSelected ? new Set() : new Set(availableWorkspaceKeys));
  }, [allSelected, availableWorkspaceKeys, isArchiving]);

  const archiveSelected = useCallback(() => {
    if (archiveInFlightRef.current || selectedWorkspaceKeys.size === 0) return;
    archiveInFlightRef.current = true;
    setIsArchiving(true);

    void (async () => {
      try {
        const selectedWorkspaces = [...selectedWorkspaceKeys].flatMap((workspaceKey) => {
          const workspace = workspaceEntriesByKey.get(workspaceKey);
          return workspace ? [workspace] : [];
        });
        const targets = await selectProjectWorkspacesToArchive(selectedWorkspaces);
        if (targets.length === 0) return;

        const confirmedWorkspaceKeys = new Set(targets.map(workspaceTargetKey));
        const selectedActiveWorkspace = targets.find(
          (target) =>
            target.serverId === activeWorkspaceSelection?.serverId &&
            target.workspaceId === activeWorkspaceSelection.workspaceId,
        );
        if (selectedActiveWorkspace) {
          redirectIfArchivingActiveWorkspace({
            ...selectedActiveWorkspace,
            activeWorkspaceSelection,
          });
        }

        const failures = await archiveWorkspacesOptimistically({
          getClient: (serverId) => getHostRuntimeStore().getClient(serverId),
          workspaces: targets,
        });
        const failedWorkspaceKeys = new Set(failures.map(workspaceTargetKey));
        for (const target of targets) {
          if (!failedWorkspaceKeys.has(workspaceTargetKey(target))) {
            purgeArchivedWorkspaceState(target);
          }
        }

        const remainingSelection = resolveRemainingWorkspaceSelection({
          selectedWorkspaceKeys,
          confirmedWorkspaceKeys,
          failures,
        });
        setSelectedWorkspaceKeys(remainingSelection);
        if (remainingSelection.size === 0) {
          setIsManaging(false);
        }
        if (failures.length > 0) {
          let message = t("sidebar.workspace.selection.archiveFailed", {
            count: failures.length,
          });
          if (failures.length === 1 && failures[0]?.error instanceof Error) {
            message = failures[0].error.message;
          }
          toast.error(message);
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : t("sidebar.workspace.selection.archiveFailed"),
        );
      } finally {
        archiveInFlightRef.current = false;
        setIsArchiving(false);
      }
    })();
  }, [activeWorkspaceSelection, selectedWorkspaceKeys, t, toast, workspaceEntriesByKey]);

  const value = useMemo<SidebarWorkspaceSelectionController>(
    () => ({
      isManaging,
      isArchiving,
      selectedCount: selectedWorkspaceKeys.size,
      availableCount: availableWorkspaceKeys.size,
      allSelected,
      beginManaging,
      finishManaging,
      toggleWorkspace,
      isWorkspaceSelected,
      toggleSelectAll,
      archiveSelected,
    }),
    [
      allSelected,
      archiveSelected,
      availableWorkspaceKeys.size,
      beginManaging,
      finishManaging,
      isArchiving,
      isManaging,
      isWorkspaceSelected,
      selectedWorkspaceKeys.size,
      toggleSelectAll,
      toggleWorkspace,
    ],
  );

  return (
    <SidebarWorkspaceSelectionContext.Provider value={value}>
      {children}
    </SidebarWorkspaceSelectionContext.Provider>
  );
}

export function useSidebarWorkspaceSelection(): SidebarWorkspaceSelectionController {
  const selection = useContext(SidebarWorkspaceSelectionContext);
  if (!selection) throw new Error("SidebarWorkspaceSelectionProvider is required");
  return selection;
}

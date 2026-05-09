import { useCallback } from "react";
import { router } from "expo-router";
import { pickDirectory } from "@/desktop/pick-directory";
import {
  useKeyboardShortcutsStore,
  type ProjectPickerIntent,
} from "@/stores/keyboard-shortcuts-store";
import { buildHostNewWorkspaceRoute } from "@/utils/host-routes";
import { useIsLocalDaemon } from "./use-is-local-daemon";
import { useOpenProject } from "./use-open-project";

const OPEN_PROJECT_INTENT: ProjectPickerIntent = { kind: "open-project" };

export function useOpenProjectPicker(
  serverId: string | null,
  intent: ProjectPickerIntent = OPEN_PROJECT_INTENT,
): () => Promise<void> {
  const normalizedServerId = serverId?.trim() ?? "";
  const isLocalDaemon = useIsLocalDaemon(normalizedServerId);
  const setProjectPickerOpen = useKeyboardShortcutsStore((state) => state.setProjectPickerOpen);
  const openProject = useOpenProject(serverId);

  return useCallback(async () => {
    if (!normalizedServerId) {
      return;
    }

    if (!isLocalDaemon) {
      setProjectPickerOpen(true, intent);
      return;
    }

    const path = await pickDirectory();
    if (path === null) {
      return;
    }

    if (intent.kind === "new-workspace") {
      router.navigate(
        buildHostNewWorkspaceRoute(normalizedServerId, path, {
          headerTitle: intent.headerTitle,
        }) as never,
      );
      return;
    }

    await openProject(path);
  }, [intent, isLocalDaemon, normalizedServerId, openProject, setProjectPickerOpen]);
}

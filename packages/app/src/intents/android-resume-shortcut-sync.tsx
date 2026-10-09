import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { androidIntents } from "@/native/android-intents";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";

const RESUME_SHORTCUT_ID = "resume-workspace";

/** Keeps the launcher's dynamic shortcut pointed at the last opened workspace. */
export function AndroidResumeShortcutSync() {
  const { t } = useTranslation();
  const selection = useLastWorkspaceSelection();
  const workspace = useWorkspace(selection?.serverId ?? null, selection?.workspaceId ?? null);
  const serverId = selection?.serverId ?? null;
  const workspaceId = selection?.workspaceId ?? null;
  const workspaceName = workspace?.title?.trim() || workspace?.name?.trim() || null;

  useEffect(() => {
    if (!androidIntents.isAvailable || !serverId || !workspaceId || !workspaceName) {
      return;
    }
    const route = buildHostWorkspaceRoute(serverId, workspaceId);
    if (route === "/") {
      return;
    }
    androidIntents.setResumeShortcut({
      id: RESUME_SHORTCUT_ID,
      label: t("intents.shortcuts.resume", { name: workspaceName }),
      uri: `paseo:/${route}`,
    });
  }, [serverId, t, workspaceId, workspaceName]);

  return null;
}

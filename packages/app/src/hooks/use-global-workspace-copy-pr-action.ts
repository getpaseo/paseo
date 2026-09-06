import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { getForgePresentation, normalizeForge } from "@/git/forge";
import { selectPrHintFromStatus } from "@/git/pr-hint";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { copyToClipboard } from "@/utils/copy-to-clipboard";

const WORKSPACE_PR_COPY_ACTIONS: readonly KeyboardActionId[] = ["workspace.pr.copy"];

// The change-request link shortcut mirrors the pin shortcut's shape: one registration keyed on
// the active route selection, not on a rendered row, so it keeps working while the sidebar is
// collapsed or focus mode hides the row.
//
// The URL comes from the workspace descriptor's `githubRuntime` rather than the checkout PR
// query: the sidebar's change-request badge reads the same field, so the shortcut never copies
// a link the UI does not show.
export function useGlobalWorkspaceCopyPrAction() {
  const { t } = useTranslation();
  const toast = useToast();
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const routeWorkspaceId = selection?.workspaceId ?? null;
  // Narrow projection: only the fields that decide the copied URL, so diffStat and gitRuntime
  // branch ticks don't re-render this handler.
  const fields = useWorkspaceFields(serverId, routeWorkspaceId, (workspace) => ({
    prStatus: workspace.githubRuntime?.pullRequest ?? null,
    forge: workspace.forge ?? null,
  }));

  const handle = useCallback(() => {
    if (!fields) {
      return false;
    }
    const hint = selectPrHintFromStatus(fields.prStatus, fields.forge);
    if (!hint?.url) {
      toast.error(t("workspace.header.toasts.changeRequestLinkUnavailable"));
      return true;
    }
    const context = getForgePresentation(normalizeForge(hint.forge)).changeRequestContext;
    void copyToClipboard(hint.url)
      .then(() =>
        toast.copied(t("workspace.header.toasts.changeRequestLinkCopiedLabel", { context })),
      )
      .catch(() => toast.error(t("common.errors.unableToCopy")));
    return true;
  }, [fields, t, toast]);

  useKeyboardActionHandler({
    handlerId: "workspace-pr-copy-global",
    actions: WORKSPACE_PR_COPY_ACTIONS,
    enabled: serverId !== null && fields !== null,
    priority: 0,
    handle,
  });
}

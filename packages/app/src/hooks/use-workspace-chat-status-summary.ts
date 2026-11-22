import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "@/stores/session-store";
import { countWorkspaceChatStatuses } from "@/utils/workspace-agent-activity";
import { getStatusBucketLabel, STATUS_BUCKET_ORDER } from "./sidebar-status-view-model";

export function useWorkspaceChatStatusSummary(serverId?: string, workspaceId?: string) {
  const { t, i18n } = useTranslation();
  const agents = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.agents : undefined,
  );
  const language = i18n.resolvedLanguage;
  return useMemo(() => {
    if (!agents || !workspaceId) return null;
    const counts = countWorkspaceChatStatuses(agents, workspaceId);
    const labels = STATUS_BUCKET_ORDER.flatMap((bucket) => {
      const count = counts[bucket];
      return count ? [`${count.toLocaleString(language)} ${getStatusBucketLabel(bucket, t)}`] : [];
    });
    return labels.length > 1 ? labels.join(" · ") : null;
  }, [agents, workspaceId, language, t]);
}

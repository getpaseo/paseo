import { useCallback } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Globe } from "lucide-react-native";
import type { BrowserHandoff } from "@getpaseo/protocol/browser-activity/rpc-schemas";
import { Button } from "@/components/ui/button";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useBrowserHandoff } from "@/desktop/browser/activity";
import type { BrowserHandoffToolCall } from "@/desktop/browser/handoff";
import { useBrowserStore } from "@/desktop/browser/store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { usePanelStore } from "@/stores/panel-store";
import type { Theme } from "@/styles/theme";

interface BrowserHandoffCardProps {
  serverId: string;
  workspaceId: string;
  call: BrowserHandoffToolCall;
}

const ThemedGlobe = withUnistyles(Globe);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const STATUS_VARIANTS: Record<BrowserHandoff["status"], StatusBadgeVariant> = {
  active: "warning",
  done: "success",
  cancelled: "muted",
};

function openHandoffTab(input: {
  serverId: string;
  workspaceId: string;
  browserId: string;
  isCompact: boolean;
}): void {
  const store = useBrowserStore.getState();
  const record = Object.values(store.browsersById).find(
    (candidate) => candidate.remoteBrowserId === input.browserId,
  );
  // Without a record the pane would open a fresh daemon tab instead of the handed-off one.
  if (!record) store.upsertRemoteBrowser({ browserId: input.browserId, url: "about:blank" });
  if (input.isCompact) usePanelStore.getState().showMobileAgent();
  navigateToWorkspace({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    target: { kind: "browser", browserId: record?.browserId ?? input.browserId },
  });
}

export function BrowserHandoffCard({ serverId, workspaceId, call }: BrowserHandoffCardProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const handoff = useBrowserHandoff(serverId, call.handoffId);
  const openBrowser = useCallback(
    () => openHandoffTab({ serverId, workspaceId, browserId: call.browserId, isCompact }),
    [call.browserId, isCompact, serverId, workspaceId],
  );

  return (
    <View style={styles.card} testID="browser-handoff-card">
      <View style={styles.header}>
        <ThemedGlobe size={14} uniProps={mutedColor} />
        <Text style={styles.title}>{t("workspace.browser.handoff.title")}</Text>
        {handoff ? (
          <StatusBadge
            label={t(`workspace.browser.handoff.status.${handoff.status}`)}
            variant={STATUS_VARIANTS[handoff.status]}
          />
        ) : null}
      </View>
      <Text style={styles.reason}>{call.reason}</Text>
      <View style={styles.actions}>
        <Button size="sm" variant="outline" onPress={openBrowser} testID="browser-handoff-open">
          {t("workspace.browser.handoff.openBrowser")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    // Reserves the badge's height so the row does not grow when the state arrives.
    minHeight: 24,
  },
  title: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  reason: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  actions: { flexDirection: "row" },
}));

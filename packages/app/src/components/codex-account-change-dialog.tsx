import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { RefreshCw } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { CodexAccountChange } from "@/utils/codex-account-change";

const keepOpen = () => {};
const ThemedRefreshCw = withUnistyles(RefreshCw, (theme) => ({
  size: theme.iconSize.md,
  color: theme.colors.foreground,
}));

export function CodexAccountChangeDialog({
  accountChange,
  visible,
  isReloading,
  onKeepCurrentSession,
  onReloadAgent,
}: {
  accountChange: CodexAccountChange;
  visible: boolean;
  isReloading: boolean;
  onKeepCurrentSession: () => void;
  onReloadAgent: () => void;
}) {
  const { t } = useTranslation();
  const header = useMemo<SheetHeader>(
    () => ({
      title: t("agentPanel.codexAccountChange.title"),
      leading: <ThemedRefreshCw />,
    }),
    [t],
  );

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={isReloading ? keepOpen : onKeepCurrentSession}
      header={header}
      desktopMaxWidth={440}
      testID="codex-account-change-dialog"
    >
      <View style={styles.body}>
        <Text style={styles.message}>
          {t("agentPanel.codexAccountChange.message", {
            previousAccount: accountChange.previousLabel,
            nextAccount: accountChange.nextLabel,
          })}
        </Text>
        <View style={styles.actions}>
          <Button
            variant="secondary"
            size="sm"
            style={styles.action}
            disabled={isReloading}
            onPress={onKeepCurrentSession}
            testID="codex-account-change-keep"
          >
            {t("agentPanel.codexAccountChange.keepCurrent")}
          </Button>
          <Button
            variant="default"
            size="sm"
            style={styles.action}
            leftIcon={RefreshCw}
            loading={isReloading}
            disabled={isReloading}
            onPress={onReloadAgent}
            testID="codex-account-change-reload"
          >
            {isReloading
              ? t("workspace.tabs.toasts.reloadingAgent")
              : t("agentPanel.codexAccountChange.reload")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.5,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  action: {
    flex: 1,
  },
}));

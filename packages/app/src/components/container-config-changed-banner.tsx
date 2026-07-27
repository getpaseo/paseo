import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";

interface ContainerConfigChangedBannerProps {
  serverId: string;
  workspaceId: string;
}

/**
 * Banner shown when a devcontainer.json config change is detected for a
 * workspace running in a dev container. Offers "Rebuild" to rebuild the
 * container with the new config.
 *
 * The approval flow has been removed — backend selection now happens at
 * workspace creation time via a dropdown.
 */
export function ContainerConfigChangedBanner({
  serverId,
  workspaceId,
}: ContainerConfigChangedBannerProps) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const toast = useToast();

  const [configChanged, setConfigChanged] = useState(false);

  useEffect(() => {
    if (!client) return;
    const unsubConfig = client.onContainerConfigChanged((wsId) => {
      if (wsId === workspaceId) setConfigChanged(true);
    });
    return () => {
      unsubConfig();
    };
  }, [client, workspaceId]);

  const handleRebuild = useCallback(async () => {
    if (!client) return;
    try {
      await client.rebuildContainer(workspaceId);
      setConfigChanged(false);
    } catch {
      toast.error(t("workspace.header.container.configChangedTitle"));
    }
  }, [client, workspaceId, toast, t]);

  const handleDismiss = useCallback(() => {
    setConfigChanged(false);
  }, []);

  if (!configChanged) return null;

  return (
    <View style={styles.container}>
      <View style={styles.banner}>
        <View style={styles.bannerContent}>
          <Text style={styles.bannerTitle}>
            {t("workspace.header.container.configChangedTitle")}
          </Text>
          <Text style={styles.bannerMessage}>
            {t("workspace.header.container.configChangedMessage")}
          </Text>
        </View>
        <View style={styles.bannerActions}>
          <Pressable onPress={handleDismiss} style={styles.dismissButton}>
            <Text style={styles.dismissText}>{t("workspace.header.container.dismiss")}</Text>
          </Pressable>
          <Button variant="default" size="sm" onPress={handleRebuild} testID="container-rebuild">
            {t("workspace.header.container.rebuildAction")}
          </Button>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    gap: 8,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: theme.colors.muted,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  bannerContent: {
    flex: 1,
    gap: 2,
  },
  bannerTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  bannerMessage: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  bannerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dismissButton: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  dismissText: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
})) as unknown as Record<string, object>;

import { useCallback, useState } from "react";
import { View, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useOptionalPaneContext } from "@/panels/pane-context";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";

export interface ClaudeAwsAuthRefreshCalloutProps {
  serverId: string;
  agentId: string;
  onTerminalCreated?: (terminalId: string) => void;
}

export function ClaudeAwsAuthRefreshCallout({
  serverId,
  agentId,
  onTerminalCreated,
}: ClaudeAwsAuthRefreshCalloutProps) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const paneContext = useOptionalPaneContext();

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDismissing, setIsDismissing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const handleRefresh = useCallback(async () => {
    if (!client || !isConnected || isRefreshing || isDismissing) {
      return;
    }
    setIsRefreshing(true);
    setRefreshError(null);
    try {
      const response = await client.refreshClaudeAuth({ agentId, action: "refresh" });
      if (response.terminalId) {
        paneContext?.openTab({ kind: "terminal", terminalId: response.terminalId });
        onTerminalCreated?.(response.terminalId);
      }
    } catch (error) {
      setRefreshError(toErrorMessage(error));
    } finally {
      setIsRefreshing(false);
    }
  }, [agentId, client, isConnected, isDismissing, isRefreshing, onTerminalCreated, paneContext]);

  const handleDismiss = useCallback(async () => {
    if (!client || !isConnected || isRefreshing || isDismissing) {
      return;
    }
    setIsDismissing(true);
    setRefreshError(null);
    try {
      await client.refreshClaudeAuth({ agentId, action: "dismiss" });
    } catch (error) {
      setRefreshError(toErrorMessage(error));
    } finally {
      setIsDismissing(false);
    }
  }, [agentId, client, isConnected, isDismissing, isRefreshing]);

  return (
    <View style={styles.container} testID="claude-aws-auth-refresh-callout">
      <View style={styles.inputAreaContainer}>
        <View style={styles.inputAreaContent}>
          <View style={styles.calloutStack}>
            <View style={styles.callout}>
              <Text style={styles.calloutText}>{t("agentPanel.claudeAuthRefresh.callout")}</Text>
              <View style={styles.actions}>
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={handleDismiss}
                  disabled={!isConnected || isRefreshing || isDismissing}
                  loading={isDismissing}
                  testID="claude-auth-refresh-dismiss"
                >
                  {t("agentPanel.claudeAuthRefresh.dismiss")}
                </Button>
                <Button
                  size="sm"
                  variant="default"
                  onPress={handleRefresh}
                  disabled={!isConnected || isRefreshing || isDismissing}
                  loading={isRefreshing}
                  testID="claude-auth-refresh-submit"
                >
                  {t("agentPanel.claudeAuthRefresh.refresh")}
                </Button>
              </View>
            </View>
            {refreshError ? (
              <Text style={styles.errorText} testID="claude-auth-refresh-error">
                {refreshError}
              </Text>
            ) : null}
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flexDirection: "column",
    position: "relative",
    width: "100%",
  },
  inputAreaContainer: {
    position: "relative",
    marginHorizontal: "auto",
    alignItems: "center",
    width: "100%",
    overflow: "visible",
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  inputAreaContent: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
  },
  callout: {
    flexDirection: {
      xs: "column",
      md: "row",
    },
    alignItems: {
      xs: "stretch",
      md: "center",
    },
    justifyContent: "space-between",
    gap: {
      xs: theme.spacing[2],
      md: theme.spacing[3],
    },
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius["2xl"],
    paddingVertical: {
      xs: theme.spacing[2],
      md: theme.spacing[3],
    },
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[4],
    },
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: {
      xs: "flex-end",
      md: "flex-start",
    },
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  calloutStack: {
    gap: theme.spacing[2],
  },
  calloutText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    flexShrink: 1,
  },
  errorText: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
})) as unknown as Record<string, object>;

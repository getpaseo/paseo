import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { settingsStyles } from "@/styles/settings";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildProviderDefinitions } from "@/utils/provider-definitions";
import { getProviderIcon } from "@/components/provider-icons";
import { ProviderDiagnosticSheet } from "@/components/provider-diagnostic-sheet";
import { SpinningRefreshIcon } from "@/components/spinning-refresh-icon";
import { StatusBadge } from "@/components/ui/status-badge";
import { SettingsSection } from "@/screens/settings/settings-section";

export interface ProvidersSectionProps {
  serverId: string;
}

export function ProvidersSection({ serverId }: ProvidersSectionProps) {
  const { theme } = useUnistyles();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { entries, isLoading, isRefreshing, refresh } = useProvidersSnapshot(serverId);
  const [diagnosticProvider, setDiagnosticProvider] = useState<string | null>(null);
  const providerDefinitions = buildProviderDefinitions(entries);
  const providerRefreshInFlight =
    isRefreshing || (entries?.some((entry) => entry.status === "loading") ?? false);
  const hasServer = serverId.length > 0;

  const refreshAction =
    hasServer && isConnected ? (
      <Pressable
        onPress={() => void refresh()}
        disabled={providerRefreshInFlight}
        hitSlop={8}
        style={settingsStyles.sectionHeaderLink}
        accessibilityRole="button"
        accessibilityLabel="Refresh providers"
      >
        <SpinningRefreshIcon
          spinning={providerRefreshInFlight}
          size={theme.iconSize.sm}
          color={theme.colors.foregroundMuted}
        />
      </Pressable>
    ) : undefined;

  return (
    <>
      <SettingsSection
        title="Providers"
        trailing={refreshAction}
        testID="host-page-providers-card"
        style={styles.sectionSpacing}
      >
        {!hasServer || !isConnected ? (
          <View style={[settingsStyles.card, styles.emptyCard]}>
            <Text style={styles.emptyText}>Connect to this host to see providers</Text>
          </View>
        ) : isLoading ? (
          <View style={[settingsStyles.card, styles.emptyCard]}>
            <Text style={styles.emptyText}>Loading...</Text>
          </View>
        ) : (
          <View style={settingsStyles.card}>
            {providerDefinitions.map((def, index) => {
              const entry = entries?.find((e) => e.provider === def.id);
              const status = entry?.status ?? "unavailable";
              const ProviderIcon = getProviderIcon(def.id);
              const providerError =
                status === "error" &&
                typeof entry?.error === "string" &&
                entry.error.trim().length > 0
                  ? entry.error.trim()
                  : null;
              const modelCount = entry?.models?.length ?? 0;

              return (
                <Pressable
                  key={def.id}
                  style={[settingsStyles.row, index > 0 && settingsStyles.rowBorder]}
                  onPress={() => setDiagnosticProvider(def.id)}
                  accessibilityRole="button"
                >
                  <View style={settingsStyles.rowContent}>
                    <View style={styles.titleRow}>
                      <ProviderIcon size={theme.iconSize.sm} color={theme.colors.foreground} />
                      <Text style={settingsStyles.rowTitle}>{def.label}</Text>
                    </View>
                    {providerError ? (
                      <Text style={styles.errorText} numberOfLines={3}>
                        {providerError}
                      </Text>
                    ) : null}
                    {status === "ready" && modelCount > 0 ? (
                      <Text style={settingsStyles.rowHint}>
                        {modelCount === 1 ? "1 model" : `${modelCount} models`}
                      </Text>
                    ) : null}
                  </View>
                  <StatusBadge
                    label={
                      status === "ready"
                        ? "Available"
                        : status === "error"
                          ? "Error"
                          : status === "loading"
                            ? "Loading..."
                            : "Not installed"
                    }
                    variant={
                      status === "ready" ? "success" : status === "error" ? "error" : "muted"
                    }
                  />
                </Pressable>
              );
            })}
          </View>
        )}
      </SettingsSection>

      {diagnosticProvider ? (
        <ProviderDiagnosticSheet
          provider={diagnosticProvider}
          visible
          onClose={() => setDiagnosticProvider(null)}
          serverId={serverId}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  sectionSpacing: {
    marginBottom: theme.spacing[4],
  },
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
}));

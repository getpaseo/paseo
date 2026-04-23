import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { settingsStyles } from "@/styles/settings";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildProviderDefinitions } from "@/utils/provider-definitions";
import { getProviderIcon } from "@/components/provider-icons";
import { ProviderDiagnosticSheet } from "@/components/provider-diagnostic-sheet";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { SettingsSection } from "@/screens/settings/settings-section";
import { RotateCw } from "lucide-react-native";

type ProviderDefinition = ReturnType<typeof buildProviderDefinitions>[number];
type ProviderEntry = NonNullable<ReturnType<typeof useProvidersSnapshot>["entries"]>[number];

function getProviderStatusLabel(status: string): string {
  if (status === "ready") return "Available";
  if (status === "error") return "Error";
  if (status === "loading") return "Loading...";
  return "Not installed";
}

function getProviderStatusVariant(status: string): "success" | "error" | "muted" {
  if (status === "ready") return "success";
  if (status === "error") return "error";
  return "muted";
}

interface ProviderRowProps {
  def: ProviderDefinition;
  entry: ProviderEntry | undefined;
  isFirst: boolean;
  onPress: (providerId: string) => void;
}

function ProviderRow({ def, entry, isFirst, onPress }: ProviderRowProps) {
  const { theme } = useUnistyles();
  const status = entry?.status ?? "unavailable";
  const ProviderIcon = getProviderIcon(def.id);
  const providerError =
    status === "error" && typeof entry?.error === "string" && entry.error.trim().length > 0
      ? entry.error.trim()
      : null;
  const modelCount = entry?.models?.length ?? 0;

  const handlePress = useCallback(() => onPress(def.id), [def.id, onPress]);

  const rowStyle = useMemo(
    () => [settingsStyles.row, !isFirst && settingsStyles.rowBorder],
    [isFirst],
  );

  return (
    <Pressable style={rowStyle} onPress={handlePress} accessibilityRole="button">
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
        label={getProviderStatusLabel(status)}
        variant={getProviderStatusVariant(status)}
      />
    </Pressable>
  );
}

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

  const handleRefresh = useCallback(() => {
    void refresh();
  }, [refresh]);

  const handleCloseDiagnostic = useCallback(() => setDiagnosticProvider(null), []);

  const refreshAction =
    hasServer && isConnected ? (
      <Pressable
        onPress={handleRefresh}
        disabled={providerRefreshInFlight}
        hitSlop={8}
        style={settingsStyles.sectionHeaderLink}
        accessibilityRole="button"
        accessibilityLabel={providerRefreshInFlight ? "Refreshing providers" : "Refresh providers"}
      >
        {providerRefreshInFlight ? (
          <LoadingSpinner size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
        ) : (
          <RotateCw size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
        )}
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
          <View style={EMPTY_CARD_STYLE}>
            <Text style={styles.emptyText}>Connect to this host to see providers</Text>
          </View>
        ) : isLoading ? (
          <View style={EMPTY_CARD_STYLE}>
            <Text style={styles.emptyText}>Loading...</Text>
          </View>
        ) : (
          <View style={settingsStyles.card}>
            {providerDefinitions.map((def, index) => (
              <ProviderRow
                key={def.id}
                def={def}
                entry={entries?.find((e) => e.provider === def.id)}
                isFirst={index === 0}
                onPress={setDiagnosticProvider}
              />
            ))}
          </View>
        )}
      </SettingsSection>

      {diagnosticProvider ? (
        <ProviderDiagnosticSheet
          provider={diagnosticProvider}
          visible
          onClose={handleCloseDiagnostic}
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

const EMPTY_CARD_STYLE = [settingsStyles.card, styles.emptyCard];

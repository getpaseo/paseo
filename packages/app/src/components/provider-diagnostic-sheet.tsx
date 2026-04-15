import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, ActivityIndicator, ScrollView } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { resolveProviderLabel } from "@/utils/provider-definitions";
import type { AgentProvider, AgentModelDefinition } from "@server/server/agent/agent-sdk-types";

interface ProviderDiagnosticSheetProps {
  provider: string;
  visible: boolean;
  onClose: () => void;
  serverId: string;
}

export function ProviderDiagnosticSheet({
  provider,
  visible,
  onClose,
  serverId,
}: ProviderDiagnosticSheetProps) {
  const { theme } = useUnistyles();
  const client = useHostRuntimeClient(serverId);
  const { entries: snapshotEntries } = useProvidersSnapshot(serverId);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const providerLabel = resolveProviderLabel(provider, snapshotEntries);
  const models = useMemo(() => {
    const entry = snapshotEntries?.find((e) => e.provider === provider);
    return entry?.models ?? [];
  }, [snapshotEntries, provider]);

  const fetchDiagnostic = useCallback(async () => {
    if (!client || !provider) return;

    setLoading(true);
    setDiagnostic(null);

    try {
      const result = await client.getProviderDiagnostic(provider as AgentProvider);
      setDiagnostic(result.diagnostic);
    } catch (err) {
      setDiagnostic(err instanceof Error ? err.message : "Failed to fetch diagnostic");
    } finally {
      setLoading(false);
    }
  }, [client, provider]);

  useEffect(() => {
    if (visible) {
      fetchDiagnostic();
    } else {
      setDiagnostic(null);
    }
  }, [visible, fetchDiagnostic]);

  return (
    <AdaptiveModalSheet
      title={providerLabel}
      visible={visible}
      onClose={onClose}
      snapPoints={["50%", "85%"]}
    >
      <ScrollView
        style={sheetStyles.scrollContainer}
        contentContainerStyle={sheetStyles.scrollContent}
      >
        {models.length > 0 ? (
          <View style={sheetStyles.modelsSection}>
            <Text style={sheetStyles.modelsSectionTitle}>
              {models.length === 1 ? "1 model" : `${models.length} models`}
            </Text>
            {models.map((model: AgentModelDefinition) => (
              <View key={model.id} style={sheetStyles.modelRow}>
                <Text style={sheetStyles.modelLabel} numberOfLines={1}>
                  {model.label}
                </Text>
                <Text style={sheetStyles.modelId} numberOfLines={1} selectable>
                  {model.id}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {loading ? (
          <View style={sheetStyles.loadingContainer}>
            <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
            <Text style={sheetStyles.loadingText}>Fetching diagnostic…</Text>
          </View>
        ) : diagnostic ? (
          <View style={sheetStyles.diagnosticSection}>
            <Text style={sheetStyles.modelsSectionTitle}>Diagnostic</Text>
            <ScrollView horizontal>
              <Text style={sheetStyles.diagnosticText} selectable>
                {diagnostic}
              </Text>
            </ScrollView>
          </View>
        ) : null}
      </ScrollView>
    </AdaptiveModalSheet>
  );
}

const sheetStyles = StyleSheet.create((theme) => ({
  loadingContainer: {
    paddingVertical: theme.spacing[6],
    alignItems: "center",
    gap: theme.spacing[2],
  },
  loadingText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  scrollContainer: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: theme.spacing[4],
  },
  modelsSection: {
    gap: theme.spacing[1],
    marginBottom: theme.spacing[4],
  },
  modelsSectionTitle: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: theme.spacing[2],
  },
  modelRow: {
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  modelLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  modelId: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontFamily: "monospace",
    marginTop: 2,
  },
  diagnosticSection: {
    marginTop: theme.spacing[2],
  },
  diagnosticText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontFamily: "monospace",
    lineHeight: theme.fontSize.sm * 1.6,
  },
}));

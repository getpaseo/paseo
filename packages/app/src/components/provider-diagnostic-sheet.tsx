import { useCallback, useEffect, useState } from "react";
import { View, Text, ActivityIndicator, ScrollView } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { AgentProvider } from "@server/server/agent/agent-sdk-types";
import { AGENT_PROVIDER_DEFINITIONS } from "@server/server/agent/provider-manifest";

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
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const providerLabel =
    AGENT_PROVIDER_DEFINITIONS.find((d) => d.id === provider)?.label ?? provider;

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
      {loading ? (
        <View style={sheetStyles.loadingContainer}>
          <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
          <Text style={sheetStyles.loadingText}>Fetching diagnostic…</Text>
        </View>
      ) : diagnostic ? (
        <ScrollView
          horizontal
          style={sheetStyles.scrollContainer}
          contentContainerStyle={sheetStyles.scrollContent}
        >
          <Text style={sheetStyles.diagnosticText} selectable>
            {diagnostic}
          </Text>
        </ScrollView>
      ) : null}
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
  diagnosticText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontFamily: "monospace",
    lineHeight: theme.fontSize.sm * 1.6,
  },
}));

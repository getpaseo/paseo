import { AlertCircle, Search } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { SpinningRefreshIcon } from "@/components/spinning-refresh-icon";
import { isWeb } from "@/constants/platform";
import { Fonts } from "@/constants/theme";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { resolveProviderLabel } from "@/utils/provider-definitions";
import { formatTimeAgo } from "@/utils/time";
import type { AgentModelDefinition, AgentProvider } from "@server/server/agent/agent-sdk-types";

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
  const { entries: snapshotEntries, refresh, isRefreshing } = useProvidersSnapshot(serverId);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  const providerLabel = resolveProviderLabel(provider, snapshotEntries);
  const providerEntry = useMemo(
    () => snapshotEntries?.find((entry) => entry.provider === provider),
    [snapshotEntries, provider],
  );
  const models = providerEntry?.models ?? [];
  const providerSnapshotRefreshing = providerEntry?.status === "loading";
  const providerErrorMessage =
    providerEntry?.status === "error" ? (providerEntry.error ?? "Unknown error") : null;
  const refreshInFlight = isRefreshing || providerSnapshotRefreshing || loading;

  const [clockTick, setClockTick] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => setClockTick((t) => t + 1), 10_000);
    return () => clearInterval(id);
  }, [visible]);
  const fetchedAtLabel = useMemo(() => {
    if (!providerEntry?.fetchedAt) return null;
    return formatTimeAgo(new Date(providerEntry.fetchedAt));
    // clockTick triggers re-computation on timer
  }, [providerEntry?.fetchedAt, clockTick]);

  const q = query.trim().toLowerCase();
  const filteredModels = q
    ? models.filter((m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
    : models;

  const fetchDiagnostic = useCallback(
    async (options?: { keepCurrent?: boolean }) => {
      if (!client || !provider) return;

      setLoading(true);
      if (!options?.keepCurrent) {
        setDiagnostic(null);
      }

      try {
        const result = await client.getProviderDiagnostic(provider as AgentProvider);
        setDiagnostic(result.diagnostic);
      } catch (err) {
        setDiagnostic(err instanceof Error ? err.message : "Failed to fetch diagnostic");
      } finally {
        setLoading(false);
      }
    },
    [client, provider],
  );

  const handleRefresh = useCallback(() => {
    void refresh([provider as AgentProvider]);
    void fetchDiagnostic({ keepCurrent: true });
  }, [fetchDiagnostic, provider, refresh]);

  useEffect(() => {
    if (visible) {
      fetchDiagnostic();
    } else {
      setDiagnostic(null);
      setQuery("");
    }
  }, [visible, fetchDiagnostic]);

  function renderModelsBody() {
    if (models.length === 0 && providerSnapshotRefreshing) {
      return (
        <View style={sheetStyles.emptyState}>
          <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
          <Text style={sheetStyles.mutedText}>Loading models…</Text>
        </View>
      );
    }
    if (models.length === 0 && providerErrorMessage) {
      return (
        <View style={sheetStyles.emptyState}>
          <AlertCircle size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
          <Text style={sheetStyles.mutedText}>{providerErrorMessage}</Text>
        </View>
      );
    }
    if (models.length === 0) {
      return (
        <View style={sheetStyles.emptyState}>
          <Text style={sheetStyles.mutedText}>No models detected.</Text>
        </View>
      );
    }
    if (filteredModels.length === 0) {
      return (
        <View style={sheetStyles.emptyState}>
          <Search size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
          <Text style={sheetStyles.mutedText}>No models match your search</Text>
        </View>
      );
    }
    return filteredModels.map((model: AgentModelDefinition, index) => (
      <View key={model.id} style={[sheetStyles.modelRow, index > 0 && sheetStyles.modelRowBorder]}>
        <Text style={sheetStyles.modelLabel} numberOfLines={1}>
          {model.label}
        </Text>
        <Text style={sheetStyles.modelId} numberOfLines={1} selectable>
          {model.id}
        </Text>
      </View>
    ));
  }

  return (
    <AdaptiveModalSheet
      title={providerLabel}
      visible={visible}
      onClose={onClose}
      snapPoints={["50%", "85%"]}
      scrollable={false}
      headerActions={
        <Pressable
          onPress={handleRefresh}
          disabled={refreshInFlight}
          hitSlop={8}
          style={({ hovered, pressed }) => [
            sheetStyles.iconButton,
            (hovered || pressed) && sheetStyles.iconButtonHovered,
            refreshInFlight ? sheetStyles.disabled : null,
          ]}
          accessibilityRole="button"
          accessibilityLabel={`Refresh ${providerLabel}`}
        >
          <SpinningRefreshIcon
            spinning={refreshInFlight}
            size={theme.iconSize.sm}
            color={theme.colors.foregroundMuted}
          />
        </Pressable>
      }
    >
      <View style={sheetStyles.section}>
        <Text style={sheetStyles.sectionTitle}>Diagnostic</Text>
        <View style={sheetStyles.codeBlock}>
          {loading && !diagnostic ? (
            <View style={sheetStyles.codeBlockLoading}>
              <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
              <Text style={sheetStyles.mutedText}>Running diagnostic…</Text>
            </View>
          ) : diagnostic ? (
            <ScrollView
              style={sheetStyles.codeScroll}
              contentContainerStyle={sheetStyles.codeContent}
              showsVerticalScrollIndicator={false}
            >
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <Text style={sheetStyles.codeText} selectable>
                  {diagnostic}
                </Text>
              </ScrollView>
            </ScrollView>
          ) : (
            <View style={sheetStyles.codeBlockLoading}>
              <Text style={sheetStyles.mutedText}>No diagnostic available.</Text>
            </View>
          )}
        </View>
      </View>

      <View style={sheetStyles.modelsSection}>
        <View style={sheetStyles.modelsHeader}>
          <Text style={sheetStyles.sectionTitle}>Models</Text>
          <View style={sheetStyles.modelsHeaderMeta}>
            <Text style={sheetStyles.countText}>{models.length}</Text>
            {fetchedAtLabel ? (
              <>
                <Text style={sheetStyles.metaDot}>·</Text>
                <Text style={sheetStyles.countText}>Updated {fetchedAtLabel}</Text>
              </>
            ) : null}
          </View>
        </View>
        {models.length > 0 ? (
          <View style={sheetStyles.searchContainer}>
            <Search size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
            <AdaptiveTextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search models"
              placeholderTextColor={theme.colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              // @ts-expect-error - outlineStyle is web-only
              style={[sheetStyles.searchInput, isWeb && { outlineStyle: "none" }]}
            />
          </View>
        ) : null}
        <ScrollView
          style={sheetStyles.modelsScroll}
          contentContainerStyle={sheetStyles.modelsScrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {renderModelsBody()}
        </ScrollView>
      </View>
    </AdaptiveModalSheet>
  );
}

const sheetStyles = StyleSheet.create((theme) => ({
  section: {
    gap: theme.spacing[2],
  },
  sectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
  },
  mutedText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  iconButton: {
    width: 30,
    height: 30,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  disabled: {
    opacity: 0.5,
  },
  codeBlock: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
    maxHeight: 180,
  },
  codeScroll: {
    maxHeight: 180,
  },
  codeContent: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
  },
  codeText: {
    fontFamily: Fonts.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    lineHeight: 18,
  },
  codeBlockLoading: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[3],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  modelsSection: {
    flex: 1,
    minHeight: 0,
    gap: theme.spacing[2],
  },
  modelsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  modelsHeaderMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  metaDot: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  countText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
  },
  searchInput: {
    flex: 1,
    paddingVertical: theme.spacing[2],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  modelsScroll: {
    flex: 1,
    minHeight: 0,
  },
  modelsScrollContent: {
    paddingBottom: theme.spacing[2],
  },
  modelRow: {
    paddingVertical: theme.spacing[3],
  },
  modelRowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  modelLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  modelId: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontFamily: Fonts.mono,
    marginTop: 2,
  },
  emptyState: {
    paddingVertical: theme.spacing[6],
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));

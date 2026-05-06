import { AlertCircle, RotateCw, Search, Trash2 } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  type PressableStateCallbackType,
  ScrollView,
  Text,
  View,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { isWeb } from "@/constants/platform";
import { Fonts } from "@/constants/theme";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { resolveProviderLabel } from "@/utils/provider-definitions";
import { formatTimeAgo } from "@/utils/time";
import type { AgentModelDefinition, AgentProvider } from "@server/server/agent/agent-sdk-types";
import type { ProviderProfileModel } from "@server/server/agent/provider-launch-config";

interface ProviderDiagnosticSheetProps {
  provider: string;
  visible: boolean;
  onClose: () => void;
  serverId: string;
}

function ModelRow({ model }: { model: AgentModelDefinition }) {
  return (
    <View style={MODEL_ROW_STYLE}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {model.label}
        </Text>
        <Text style={sheetStyles.monoHint} numberOfLines={1} selectable>
          {model.id}
        </Text>
      </View>
    </View>
  );
}

function CustomModelRow(props: {
  model: ProviderProfileModel;
  deleting: boolean;
  onDelete: (modelId: string) => void;
}) {
  const { theme } = useUnistyles();
  const { model, deleting, onDelete } = props;
  const handleDelete = useCallback(() => onDelete(model.id), [model.id, onDelete]);
  const deleteButtonStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      sheetStyles.iconButton,
      (Boolean(hovered) || pressed) && sheetStyles.iconButtonHovered,
      deleting ? sheetStyles.disabled : null,
    ],
    [deleting],
  );

  return (
    <View style={MODEL_ROW_STYLE}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {model.label}
        </Text>
        <Text style={sheetStyles.monoHint} numberOfLines={1} selectable>
          {model.id}
        </Text>
      </View>
      <Pressable
        onPress={handleDelete}
        disabled={deleting}
        hitSlop={8}
        style={deleteButtonStyle}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${model.id}`}
      >
        <Trash2 size={theme.iconSize.sm} color={theme.colors.destructive} />
      </Pressable>
    </View>
  );
}

function CustomModelsSection(props: {
  provider: string;
  serverId: string;
  refresh: (providers?: AgentProvider[]) => Promise<void>;
}) {
  const { provider, serverId, refresh } = props;
  const { theme } = useUnistyles();
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingModelId, setDeletingModelId] = useState<string | null>(null);
  const providerConfig = config?.providers?.[provider];
  const additionalModels = useMemo(
    () => providerConfig?.additionalModels ?? [],
    [providerConfig?.additionalModels],
  );
  const trimmedInput = input.trim();
  const canAdd =
    trimmedInput.length > 0 && !additionalModels.some((model) => model.id === trimmedInput);

  const patchAdditionalModels = useCallback(
    async (nextModels: ProviderProfileModel[]) => {
      await patchConfig({
        providers: {
          [provider]: {
            additionalModels: nextModels,
          },
        },
      });
      await refresh([provider]);
    },
    [patchConfig, provider, refresh],
  );

  const handleAdd = useCallback(() => {
    if (!canAdd) {
      return;
    }

    setError(null);
    setSaving(true);
    void patchAdditionalModels([
      ...additionalModels,
      {
        id: trimmedInput,
        label: trimmedInput,
      },
    ])
      .then(() => setInput(""))
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to save model");
      })
      .finally(() => setSaving(false));
  }, [additionalModels, canAdd, patchAdditionalModels, trimmedInput]);

  const handleDelete = useCallback(
    (modelId: string) => {
      setError(null);
      setDeletingModelId(modelId);
      void patchAdditionalModels(additionalModels.filter((model) => model.id !== modelId))
        .catch((err) => {
          setError(err instanceof Error ? err.message : "Failed to delete model");
        })
        .finally(() => {
          setDeletingModelId((current) => (current === modelId ? null : current));
        });
    },
    [additionalModels, patchAdditionalModels],
  );

  return (
    <SettingsSection title="Custom models">
      <View style={settingsStyles.card}>
        <View style={INLINE_ROW_STYLE}>
          <AdaptiveTextInput
            value={input}
            onChangeText={setInput}
            onSubmitEditing={handleAdd}
            placeholder="Model ID"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            // @ts-expect-error - outlineStyle is web-only
            style={DIAGNOSTIC_INLINE_INPUT_STYLE}
          />
          <Button
            variant="default"
            size="sm"
            onPress={handleAdd}
            disabled={!canAdd || saving}
            accessibilityLabel="Add model"
          >
            {saving ? "Adding…" : "Add"}
          </Button>
        </View>
        {additionalModels.map((model) => (
          <CustomModelRow
            key={model.id}
            model={model}
            deleting={deletingModelId === model.id}
            onDelete={handleDelete}
          />
        ))}
      </View>
      {error ? <Text style={sheetStyles.errorText}>{error}</Text> : null}
    </SettingsSection>
  );
}

function DiagnosticCodeBlock(props: {
  loading: boolean;
  diagnostic: string | null;
  foregroundMutedColor: string;
}) {
  if (props.loading && !props.diagnostic) {
    return (
      <View style={sheetStyles.codeBlockLoading}>
        <ActivityIndicator size="small" color={props.foregroundMutedColor} />
        <Text style={sheetStyles.mutedText}>Running diagnostic…</Text>
      </View>
    );
  }
  if (props.diagnostic) {
    return (
      <ScrollView
        style={sheetStyles.codeScroll}
        contentContainerStyle={sheetStyles.codeContent}
        showsVerticalScrollIndicator={false}
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text style={sheetStyles.codeText} selectable>
            {props.diagnostic}
          </Text>
        </ScrollView>
      </ScrollView>
    );
  }
  return (
    <View style={sheetStyles.codeBlockLoading}>
      <Text style={sheetStyles.mutedText}>No diagnostic available</Text>
    </View>
  );
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
    void clockTick;
    return formatTimeAgo(new Date(providerEntry.fetchedAt));
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
        const result = await client.getProviderDiagnostic(provider);
        setDiagnostic(result.diagnostic);
      } catch (err) {
        setDiagnostic(err instanceof Error ? err.message : "Failed to fetch diagnostic");
      } finally {
        setLoading(false);
      }
    },
    [client, provider],
  );

  const refreshButtonStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      sheetStyles.iconButton,
      (Boolean(hovered) || pressed) && sheetStyles.iconButtonHovered,
      refreshInFlight ? sheetStyles.disabled : null,
    ],
    [refreshInFlight],
  );

  const handleRefresh = useCallback(() => {
    if (!provider) {
      return;
    }
    void Promise.all([refresh([provider]), fetchDiagnostic()]).catch((err) => {
      setDiagnostic(err instanceof Error ? err.message : "Failed to refresh provider");
    });
  }, [fetchDiagnostic, provider, refresh]);

  const headerActions = useMemo(
    () => (
      <Pressable
        onPress={handleRefresh}
        disabled={refreshInFlight}
        hitSlop={8}
        style={refreshButtonStyle}
        accessibilityRole="button"
        accessibilityLabel={
          refreshInFlight ? `Refreshing ${providerLabel}` : `Refresh ${providerLabel}`
        }
      >
        {refreshInFlight ? (
          <LoadingSpinner size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
        ) : (
          <RotateCw size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
        )}
      </Pressable>
    ),
    [
      handleRefresh,
      refreshInFlight,
      refreshButtonStyle,
      providerLabel,
      theme.iconSize.sm,
      theme.colors.foregroundMuted,
    ],
  );

  useEffect(() => {
    if (visible) {
      fetchDiagnostic();
    } else {
      setDiagnostic(null);
      setQuery("");
    }
  }, [visible, fetchDiagnostic]);

  const modelsTrailing = useMemo(() => {
    if (models.length === 0 && !fetchedAtLabel) return undefined;
    return (
      <View style={sheetStyles.modelsTrailing}>
        {models.length > 0 ? (
          <Text style={settingsStyles.sectionHeaderTitle}>{models.length}</Text>
        ) : null}
        {models.length > 0 && fetchedAtLabel ? (
          <Text style={settingsStyles.sectionHeaderTitle}>·</Text>
        ) : null}
        {fetchedAtLabel ? (
          <Text style={settingsStyles.sectionHeaderTitle}>Updated {fetchedAtLabel}</Text>
        ) : null}
      </View>
    );
  }, [models.length, fetchedAtLabel]);

  function renderModelsBody() {
    if (models.length === 0 && providerSnapshotRefreshing) {
      return (
        <View style={sheetStyles.emptyRow}>
          <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
          <Text style={sheetStyles.mutedText}>Loading models…</Text>
        </View>
      );
    }
    if (models.length === 0 && providerErrorMessage) {
      return (
        <View style={sheetStyles.emptyRow}>
          <AlertCircle size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
          <Text style={sheetStyles.mutedText}>{providerErrorMessage}</Text>
        </View>
      );
    }
    if (models.length === 0) {
      return (
        <View style={sheetStyles.emptyRow}>
          <Text style={sheetStyles.mutedText}>No models detected</Text>
        </View>
      );
    }
    if (filteredModels.length === 0) {
      return (
        <View style={sheetStyles.emptyRow}>
          <Search size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
          <Text style={sheetStyles.mutedText}>No models match your search</Text>
        </View>
      );
    }
    return filteredModels.map((model: AgentModelDefinition) => (
      <ModelRow key={model.id} model={model} />
    ));
  }

  return (
    <AdaptiveModalSheet
      title={providerLabel}
      visible={visible}
      onClose={onClose}
      snapPoints={DIAGNOSTIC_SHEET_SNAP_POINTS}
      headerActions={headerActions}
    >
      <SettingsSection title="Diagnostic">
        <View style={settingsStyles.card}>
          <DiagnosticCodeBlock
            loading={loading}
            diagnostic={diagnostic}
            foregroundMutedColor={theme.colors.foregroundMuted}
          />
        </View>
      </SettingsSection>

      <CustomModelsSection provider={provider} serverId={serverId} refresh={refresh} />

      <View>
        <View style={sheetStyles.modelsHeader}>
          <Text style={settingsStyles.sectionHeaderTitle}>Models</Text>
          {modelsTrailing}
        </View>
        <View style={settingsStyles.card}>
          <View style={INLINE_ROW_STYLE}>
            <Search size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
            <AdaptiveTextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search models"
              placeholderTextColor={theme.colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              // @ts-expect-error - outlineStyle is web-only
              style={DIAGNOSTIC_SEARCH_INPUT_STYLE}
            />
          </View>
          <ScrollView
            style={sheetStyles.modelsScroll}
            contentContainerStyle={sheetStyles.modelsScrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {renderModelsBody()}
          </ScrollView>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const sheetStyles = StyleSheet.create((theme) => ({
  mutedText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  monoHint: {
    fontFamily: Fonts.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    marginTop: theme.spacing[1],
  },
  errorText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
    marginTop: theme.spacing[2],
    marginLeft: theme.spacing[1],
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
  inlineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  inlineInput: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  codeScroll: {
    maxHeight: 200,
  },
  codeContent: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  codeText: {
    fontFamily: Fonts.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    lineHeight: 18,
  },
  codeBlockLoading: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  modelsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[3],
    marginLeft: theme.spacing[1],
  },
  modelsTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  modelsScroll: {
    maxHeight: 360,
  },
  modelsScrollContent: {
    paddingBottom: 0,
  },
  emptyRow: {
    paddingVertical: theme.spacing[6],
    paddingHorizontal: theme.spacing[4],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
}));

const DIAGNOSTIC_SHEET_SNAP_POINTS = ["50%", "85%"];
const DIAGNOSTIC_SEARCH_INPUT_STYLE = [sheetStyles.inlineInput, isWeb && { outlineStyle: "none" }];
const DIAGNOSTIC_INLINE_INPUT_STYLE = [sheetStyles.inlineInput, isWeb && { outlineStyle: "none" }];
const MODEL_ROW_STYLE = [settingsStyles.row, settingsStyles.rowBorder];
const INLINE_ROW_STYLE = [settingsStyles.row, sheetStyles.inlineRow];

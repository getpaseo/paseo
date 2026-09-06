import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { AgentProvider, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { MutableManualVoiceOrchestratorConfig } from "@getpaseo/protocol/messages";
import type { TFunction } from "i18next";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useToast } from "@/contexts/toast-context";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { resolveVoiceOrchestratorSelection } from "./voice-settings-model";

function findEntry(entries: ProviderSnapshotEntry[], provider: string | null) {
  return entries.find((entry) => entry.provider === provider) ?? null;
}

function optionDisplay(
  options: SelectFieldOption<string>[],
  value: string | null,
): SelectFieldDisplay | null {
  const option = options.find((candidate) => candidate.value === value);
  return option ? { label: option.label, description: option.description } : null;
}

export function VoiceSettingsPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { config, isLoading: isConfigLoading, patchConfig } = useDaemonConfig(serverId);
  const snapshot = useProvidersSnapshot(serverId);
  const entries = useMemo(() => snapshot.entries ?? [], [snapshot.entries]);
  const [isSaving, setIsSaving] = useState(false);
  const orchestrator = config?.manualVoice?.orchestrator;
  const providers = useMemo(() => buildSelectableProviderSelectorProviders(entries), [entries]);
  const selectedEntry = findEntry(entries, orchestrator?.provider ?? null);
  const modeOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      (selectedEntry?.modes ?? []).map((mode) => ({
        id: mode.id,
        value: mode.id,
        label: mode.label,
        description: mode.description,
      })),
    [selectedEntry],
  );
  const selectedModel =
    selectedEntry?.models?.find((model) => model.id === orchestrator?.model) ?? null;
  const thinkingOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      (selectedModel?.thinkingOptions ?? []).map((option) => ({
        id: option.id,
        value: option.id,
        label: option.label,
        description: option.description,
      })),
    [selectedModel],
  );

  const save = useCallback(
    async (next: {
      provider?: string | null;
      model?: string | null;
      modeId?: string | null;
      thinkingOptionId?: string | null;
    }) => {
      setIsSaving(true);
      try {
        await patchConfig({ manualVoice: { orchestrator: next } });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("common.errors.unableToSave"));
      } finally {
        setIsSaving(false);
      }
    },
    [patchConfig, t, toast],
  );

  const handleModelSelect = useCallback(
    (provider: AgentProvider, model: string) => {
      const selection = resolveVoiceOrchestratorSelection({
        entries,
        current: orchestrator,
        provider,
        model,
      });
      if (!selection) {
        toast.error("This provider does not offer an agent mode.");
        return;
      }
      void save(selection);
    },
    [entries, orchestrator, save, toast],
  );

  const handleModeSelect = useCallback((modeId: string) => void save({ modeId }), [save]);
  const handleThinkingSelect = useCallback(
    (thinkingOptionId: string) => void save({ thinkingOptionId }),
    [save],
  );
  const handleSelectorOpen = useCallback(() => {
    snapshot.refetchIfStale(orchestrator?.provider ?? undefined);
  }, [orchestrator?.provider, snapshot]);
  const handleRetryProvider = useCallback(
    (provider: AgentProvider) => snapshot.refresh([provider]),
    [snapshot],
  );

  if (isConfigLoading || !config) {
    return (
      <View style={styles.loading}>
        <LoadingSpinner size="large" color={styles.spinnerColor.color} />
      </View>
    );
  }

  return (
    <VoiceSettingsFields
      t={t}
      serverId={serverId}
      orchestrator={orchestrator}
      providers={providers}
      modeOptions={modeOptions}
      thinkingOptions={thinkingOptions}
      isLoadingProviders={snapshot.isLoading || snapshot.isFetching}
      isRefreshingProvider={snapshot.isRefreshing}
      isSaving={isSaving}
      onModelSelect={handleModelSelect}
      onModeSelect={handleModeSelect}
      onThinkingSelect={handleThinkingSelect}
      onSelectorOpen={handleSelectorOpen}
      onRetryProvider={handleRetryProvider}
    />
  );
}

interface VoiceSettingsFieldsProps {
  t: TFunction;
  serverId: string;
  orchestrator: MutableManualVoiceOrchestratorConfig | undefined;
  providers: ProviderSelectorProvider[];
  modeOptions: SelectFieldOption<string>[];
  thinkingOptions: SelectFieldOption<string>[];
  isLoadingProviders: boolean;
  isRefreshingProvider: boolean;
  isSaving: boolean;
  onModelSelect(provider: AgentProvider, model: string): void;
  onModeSelect(modeId: string): void;
  onThinkingSelect(thinkingOptionId: string): void;
  onSelectorOpen(): void;
  onRetryProvider(provider: AgentProvider): void;
}

function VoiceSettingsFields(props: VoiceSettingsFieldsProps) {
  const { orchestrator, modeOptions, thinkingOptions } = props;
  return (
    <SettingsSection title={props.t("composer.voice.voiceMode")} testID="voice-settings">
      <Text style={styles.description}>
        Choose the hidden orchestrator Paseo creates for each manual voice call. It receives Paseo
        tools independently of ordinary agent MCP injection.
      </Text>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{props.t("modelSelector.model")}</Text>
            <Text style={settingsStyles.rowHint}>
              Provider and model for the voice orchestrator
            </Text>
          </View>
          <CombinedModelSelector
            providers={props.providers}
            selectedProvider={orchestrator?.provider ?? ""}
            selectedModel={orchestrator?.model ?? ""}
            onSelect={props.onModelSelect}
            isLoading={props.isLoadingProviders}
            onOpen={props.onSelectorOpen}
            onRetryProvider={props.onRetryProvider}
            isRetryingProvider={props.isRefreshingProvider}
            disabled={props.isSaving}
            serverId={props.serverId}
            desktopPlacement="bottom-start"
            desktopMinWidth={360}
          />
        </View>
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{props.t("agentControls.mode.title")}</Text>
            <Text style={settingsStyles.rowHint}>Access and approval policy for voice work</Text>
          </View>
          <SelectField
            label={props.t("agentControls.mode.title")}
            value={orchestrator?.modeId ?? null}
            selectedDisplay={optionDisplay(modeOptions, orchestrator?.modeId ?? null)}
            options={modeOptions}
            onChange={props.onModeSelect}
            placeholder="Select mode"
            emptyText="No modes available"
            disabled={props.isSaving || !orchestrator?.provider || modeOptions.length === 0}
            searchable={modeOptions.length > 6}
            size="sm"
            field={false}
            triggerTestID="voice-mode-trigger"
          />
        </View>
        {thinkingOptions.length > 0 ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{props.t("agentControls.thinking.title")}</Text>
              <Text style={settingsStyles.rowHint}>Reasoning effort for the orchestrator</Text>
            </View>
            <SelectField
              label={props.t("agentControls.thinking.title")}
              value={orchestrator?.thinkingOptionId ?? null}
              selectedDisplay={optionDisplay(
                thinkingOptions,
                orchestrator?.thinkingOptionId ?? null,
              )}
              options={thinkingOptions}
              onChange={props.onThinkingSelect}
              placeholder="Select thinking"
              emptyText="No thinking options available"
              disabled={props.isSaving}
              searchable={thinkingOptions.length > 6}
              size="sm"
              field={false}
              triggerTestID="voice-thinking-trigger"
            />
          </View>
        ) : null}
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.45,
    marginHorizontal: theme.spacing[1],
  },
  loading: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 180,
  },
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
}));

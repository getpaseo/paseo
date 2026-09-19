import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import type { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";

type SuggestionMode = "shared" | "custom";
type ProviderEntry = MutableDaemonConfig["metadataGeneration"]["providers"][number];

interface SuggestionModelSectionProps {
  serverId: string;
  metadataGeneration: MutableDaemonConfig["metadataGeneration"];
  patchConfig: (patch: MutableDaemonConfigPatch) => Promise<unknown>;
  providers: ReturnType<typeof buildSelectableProviderSelectorProviders>;
  snapshot: ReturnType<typeof useProvidersSnapshot>;
}

// "Automatic" empties the suggestion list so it falls back to the shared model.
export function SuggestionModelSection({
  serverId,
  metadataGeneration,
  patchConfig,
  providers,
  snapshot,
}: SuggestionModelSectionProps) {
  const { t } = useTranslation();
  const configuredList = metadataGeneration.promptSuggestions?.providers;
  const configured = configuredList?.[0] ?? null;
  const savedMode: SuggestionMode = configured ? "custom" : "shared";
  const [draftMode, setDraftMode] = useState<SuggestionMode | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const mode = draftMode ?? savedMode;

  useEffect(() => {
    setDraftMode(null);
  }, [configured?.model, configured?.provider]);

  const modeOptions = useMemo(
    () => [
      { value: "shared" as const, label: t("settings.metadataGeneration.automatic") },
      { value: "custom" as const, label: t("settings.metadataGeneration.preferred") },
    ],
    [t],
  );

  const save = useCallback(
    async (entries: ProviderEntry[]) => {
      setIsSaving(true);
      try {
        await patchConfig({ metadataGeneration: { promptSuggestions: { providers: entries } } });
      } catch (error) {
        setDraftMode(null);
        Alert.alert(
          t("settings.metadataGeneration.saveError"),
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setIsSaving(false);
      }
    },
    [patchConfig, t],
  );

  const handleModeChange = useCallback(
    (next: SuggestionMode) => {
      setDraftMode(next);
      if (next === "shared") {
        void save([]);
      }
    },
    [save],
  );

  const handleModelSelect = useCallback(
    (provider: AgentProvider, model: string) => {
      setDraftMode("custom");
      void save([{ provider, ...(model ? { model } : {}) }, ...(configuredList?.slice(1) ?? [])]);
    },
    [configuredList, save],
  );

  const handleSelectorOpen = useCallback(() => {
    snapshot.refetchIfStale(configured?.provider);
  }, [configured?.provider, snapshot]);
  const handleRetryProvider = useCallback(
    (provider: AgentProvider) => snapshot.refresh([provider]),
    [snapshot],
  );

  return (
    <SettingsSection
      title={t("settings.metadataGeneration.suggestionSection")}
      testID="suggestion-model-settings"
    >
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.metadataGeneration.selection")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {mode === "shared"
                ? t("settings.metadataGeneration.suggestionSharedHint")
                : t("settings.metadataGeneration.suggestionCustomHint")}
            </Text>
          </View>
          <SegmentedControl
            options={modeOptions}
            value={mode}
            onValueChange={handleModeChange}
            size="sm"
            testID="suggestion-model-mode"
          />
        </View>
        {mode === "custom" ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("settings.metadataGeneration.model")}</Text>
              <Text style={settingsStyles.rowHint}>
                {t("settings.metadataGeneration.fallbackHint")}
              </Text>
            </View>
            <CombinedModelSelector
              providers={providers}
              selectedProvider={configured?.provider ?? ""}
              selectedModel={configured?.model ?? ""}
              onSelect={handleModelSelect}
              isLoading={snapshot.isLoading || snapshot.isFetching}
              onOpen={handleSelectorOpen}
              onRetryProvider={handleRetryProvider}
              isRetryingProvider={snapshot.isRefreshing}
              disabled={isSaving}
              serverId={serverId}
              desktopPlacement="bottom-start"
              desktopMinWidth={360}
            />
          </View>
        ) : null}
      </View>
    </SettingsSection>
  );
}

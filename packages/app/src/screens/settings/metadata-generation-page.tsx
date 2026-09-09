import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { ExternalLink } from "@/components/ui/external-link";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import {
  applyModelVisibilityToProviders,
  buildSelectableProviderSelectorProviders,
  getProviderModelRows,
} from "@/provider-selection/provider-selection";
import { retryModelSelection, useModelVisibility } from "@/hooks/use-model-visibility";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";

const METADATA_GENERATION_DOCS_URL = "https://paseo.sh/docs/metadata-generation";
type SelectionMode = "automatic" | "preferred";

function resolveCatalogModels(
  catalogProviders: ReturnType<typeof buildSelectableProviderSelectorProviders>,
  providerId: string | undefined,
): { id: string; label: string }[] | null {
  const provider = catalogProviders.find((entry) => entry.id === providerId);
  if (!provider) return null;
  return getProviderModelRows(provider).map((row) => ({ id: row.modelId, label: row.modelLabel }));
}

export function MetadataGenerationPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const {
    config,
    isError: isConfigError,
    refetch: refetchConfig,
    patchConfig,
  } = useDaemonConfig(serverId);
  const snapshot = useProvidersSnapshot(serverId);
  const modelVisibility = useModelVisibility(serverId);
  const catalogProviders = useMemo(
    () => buildSelectableProviderSelectorProviders(snapshot.entries),
    [snapshot.entries],
  );
  const providers = useMemo(
    () => applyModelVisibilityToProviders(catalogProviders, modelVisibility),
    [catalogProviders, modelVisibility],
  );
  const configuredProviders = config?.metadataGeneration.providers;
  const configuredProvider = configuredProviders?.[0] ?? null;
  // The saved model may be hidden from the picker. Its label still comes from
  // the unfiltered catalog so the row does not read as a raw model ID.
  const catalogModels = useMemo(
    () => resolveCatalogModels(catalogProviders, configuredProvider?.provider),
    [catalogProviders, configuredProvider?.provider],
  );
  const savedMode: SelectionMode = configuredProvider ? "preferred" : "automatic";
  const [draftMode, setDraftMode] = useState<SelectionMode | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const mode = draftMode ?? savedMode;

  useEffect(() => {
    setDraftMode(null);
  }, [configuredProvider?.model, configuredProvider?.provider]);

  const modeOptions = useMemo(
    () => [
      { value: "automatic" as const, label: t("settings.metadataGeneration.automatic") },
      { value: "preferred" as const, label: t("settings.metadataGeneration.preferred") },
    ],
    [t],
  );

  const saveProviders = useCallback(
    async (providersPatch: { provider: string; model?: string }[]) => {
      setIsSaving(true);
      try {
        await patchConfig({ metadataGeneration: { providers: providersPatch } });
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
    (next: SelectionMode) => {
      setDraftMode(next);
      if (next === "automatic") {
        void saveProviders([]);
      }
    },
    [saveProviders],
  );

  const handleModelSelect = useCallback(
    (provider: AgentProvider, model: string) => {
      setDraftMode("preferred");
      void saveProviders([
        { provider, ...(model ? { model } : {}) },
        ...(configuredProviders?.slice(1) ?? []),
      ]);
    },
    [configuredProviders, saveProviders],
  );

  const handleRetryConfig = useCallback(() => {
    void refetchConfig();
  }, [refetchConfig]);

  const handleSelectorOpen = useCallback(() => {
    snapshot.refetchIfStale(configuredProvider?.provider);
  }, [configuredProvider?.provider, snapshot]);
  const handleRetryProvider = useCallback(
    (provider: AgentProvider) => {
      retryModelSelection({
        status: modelVisibility.status,
        retryVisibility: modelVisibility.retry,
        refreshDiscovery: () => void snapshot.refresh([provider]),
      });
    },
    [modelVisibility.retry, modelVisibility.status, snapshot],
  );
  const docsLink = useMemo(
    () => (
      <ExternalLink
        href={METADATA_GENERATION_DOCS_URL}
        label={t("settings.metadataGeneration.docs")}
      />
    ),
    [t],
  );

  if (!config) {
    return <MetadataGenerationPending isError={isConfigError} onRetry={handleRetryConfig} />;
  }

  return (
    <SettingsSection
      title={t("settings.metadataGeneration.title")}
      info={t("settings.metadataGeneration.description")}
      trailing={docsLink}
      testID="metadata-generation-settings"
    >
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.metadataGeneration.selection")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {mode === "automatic"
                ? t("settings.metadataGeneration.automaticHint")
                : t("settings.metadataGeneration.preferredHint")}
            </Text>
          </View>
          <SegmentedControl
            options={modeOptions}
            value={mode}
            onValueChange={handleModeChange}
            size="sm"
            testID="metadata-generation-mode"
          />
        </View>
        {mode === "preferred" ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("settings.metadataGeneration.model")}</Text>
              <Text style={settingsStyles.rowHint}>
                {t("settings.metadataGeneration.fallbackHint")}
              </Text>
            </View>
            <CombinedModelSelector
              providers={providers}
              catalogModels={catalogModels}
              selectedProvider={configuredProvider?.provider ?? ""}
              selectedModel={configuredProvider?.model ?? ""}
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

// Shown while there is no config to render. A cold fetch that failed has
// nothing cached, so without the error branch the page would sit on the
// spinner with no way to try again.
function MetadataGenerationPending({
  isError,
  onRetry,
}: {
  isError: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (!isError) {
    return (
      <View style={styles.loading}>
        <LoadingSpinner size="large" color={styles.spinnerColor.color} />
      </View>
    );
  }
  return (
    <View style={settingsStyles.card} testID="metadata-generation-load-error">
      <Pressable
        style={settingsStyles.row}
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel={t("common.actions.retry")}
        testID="metadata-generation-load-error-retry"
      >
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.metadataGeneration.loadError")}</Text>
        </View>
        <Text style={settingsStyles.rowTitle}>{t("common.actions.retry")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  loading: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 180,
  },
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
}));

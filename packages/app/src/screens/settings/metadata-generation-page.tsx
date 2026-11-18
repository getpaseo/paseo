import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { METADATA_TITLE_LANGUAGES, type MetadataTitleLanguage } from "@getpaseo/protocol/messages";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import {
  LANGUAGE_OPTIONS,
  formatLanguageOptionLabel,
  parseAppLanguage,
  resolveSupportedLocale,
} from "@/i18n/locales";

const METADATA_GENERATION_DOCS_URL = "https://paseo.sh/docs/metadata-generation";
type SelectionMode = "automatic" | "preferred";
const TITLE_LANGUAGE_OPTIONS = METADATA_TITLE_LANGUAGES.map((value) => {
  const option = LANGUAGE_OPTIONS.find((candidate) => candidate.value === value);
  if (!option) {
    throw new Error(`Missing language option for metadata title language ${value}`);
  }
  return { value, labelKey: option.labelKey };
});

function TitleLanguageRow({
  value,
  disabled,
  onSave,
}: {
  value: MetadataTitleLanguage;
  disabled: boolean;
  onSave: (value: MetadataTitleLanguage) => void;
}) {
  const { t, i18n } = useTranslation();
  const activeLocale = resolveSupportedLocale(
    parseAppLanguage(i18n.resolvedLanguage ?? i18n.language) ?? "en",
    [],
  );
  const selectedOption =
    TITLE_LANGUAGE_OPTIONS.find((option) => option.value === value) ?? TITLE_LANGUAGE_OPTIONS[0]!;
  const handleSelect = useCallback(
    (next: string) => onSave(next as MetadataTitleLanguage),
    [onSave],
  );
  const optionSelectHandlers = useMemo(
    () => TITLE_LANGUAGE_OPTIONS.map((option) => handleSelect.bind(null, option.value)),
    [handleSelect],
  );

  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>
          {t("settings.metadataGeneration.titleLanguage")}
        </Text>
        <Text style={settingsStyles.rowHint}>
          {t("settings.metadataGeneration.titleLanguageHint")}
        </Text>
      </View>
      <DropdownMenu>
        <DropdownTrigger
          accessibilityRole="button"
          accessibilityLabel={t("settings.metadataGeneration.titleLanguage")}
          disabled={disabled}
        >
          {formatLanguageOptionLabel(
            selectedOption,
            activeLocale,
            t("settings.general.language.options.system"),
          )}
        </DropdownTrigger>
        <DropdownMenuContent side="bottom" align="end" width={220}>
          {TITLE_LANGUAGE_OPTIONS.map((option, index) => (
            <DropdownMenuItem
              key={option.value}
              selected={value === option.value}
              onSelect={optionSelectHandlers[index]!}
            >
              {formatLanguageOptionLabel(
                option,
                activeLocale,
                t("settings.general.language.options.system"),
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

export function MetadataGenerationPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { config, isLoading: isConfigLoading, patchConfig } = useDaemonConfig(serverId);
  const snapshot = useProvidersSnapshot(serverId);
  const providers = useMemo(
    () => buildSelectableProviderSelectorProviders(snapshot.entries),
    [snapshot.entries],
  );
  const configuredProviders = config?.metadataGeneration.providers;
  const configuredProvider = configuredProviders?.[0] ?? null;
  const titleLanguage = config?.metadataGeneration.titleLanguage ?? "en";
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

  const saveTitleLanguage = useCallback(
    async (next: MetadataTitleLanguage) => {
      setIsSaving(true);
      try {
        await patchConfig({ metadataGeneration: { titleLanguage: next } });
      } catch (error) {
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
  const handleTitleLanguageSave = useCallback(
    (next: MetadataTitleLanguage) => void saveTitleLanguage(next),
    [saveTitleLanguage],
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

  const handleSelectorOpen = useCallback(() => {
    snapshot.refetchIfStale(configuredProvider?.provider);
  }, [configuredProvider?.provider, snapshot]);
  const handleRetryProvider = useCallback(
    (provider: AgentProvider) => snapshot.refresh([provider]),
    [snapshot],
  );
  const docsLink = useMemo(
    () => ({ href: METADATA_GENERATION_DOCS_URL, label: t("settings.metadataGeneration.docs") }),
    [t],
  );

  if (isConfigLoading || !config) {
    return (
      <View style={styles.loading}>
        <LoadingSpinner size="large" color={styles.spinnerColor.color} />
      </View>
    );
  }

  return (
    <SettingsSection
      title={t("settings.metadataGeneration.title")}
      info={t("settings.metadataGeneration.description")}
      link={docsLink}
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
            testID="metadata-generation-mode"
          />
        </View>
        {mode === "preferred" ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("settings.metadataGeneration.model")}</Text>
              <Text style={settingsStyles.rowHint}>
                {t("settings.metadataGeneration.modelHint")}
              </Text>
            </View>
            <CombinedModelSelector
              providers={providers}
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
        <TitleLanguageRow
          value={titleLanguage}
          disabled={isSaving}
          onSave={handleTitleLanguageSave}
        />
      </View>
    </SettingsSection>
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

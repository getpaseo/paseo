import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { SettingsCard, SettingsDetailRow } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { SettingsTextAreaCard } from "@/components/settings-textarea";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { settingsStyles } from "@/styles/settings";

const METADATA_GENERATION_DOCS_URL = "https://paseo.sh/docs/metadata-generation";
type SelectionMode = "automatic" | "preferred";
type PromptKey = "title" | "branchName" | "commitMessage" | "pullRequest";

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

  const handleSavePrompt = useCallback(
    async (key: PromptKey, instructions: string | null) => {
      setIsSaving(true);
      try {
        await patchConfig({
          metadataGeneration: {
            [key]: instructions ? { instructions } : null,
          },
        });
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
    <>
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
                <Text style={settingsStyles.rowTitle}>
                  {t("settings.metadataGeneration.model")}
                </Text>
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
        </View>
      </SettingsSection>

      <MetadataInstructionsSection
        metadataGeneration={config.metadataGeneration}
        isSaving={isSaving}
        onSavePrompt={handleSavePrompt}
      />
    </>
  );
}

interface MetadataInstructionsSectionProps {
  metadataGeneration: MutableDaemonConfig["metadataGeneration"];
  isSaving: boolean;
  onSavePrompt: (key: PromptKey, instructions: string | null) => Promise<void>;
}

function MetadataInstructionsSection({
  metadataGeneration,
  isSaving,
  onSavePrompt,
}: MetadataInstructionsSectionProps) {
  const { t } = useTranslation();
  const [editingPromptKey, setEditingPromptKey] = useState<PromptKey | null>(null);

  const handleEditTitle = useCallback(() => setEditingPromptKey("title"), []);
  const handleEditBranch = useCallback(() => setEditingPromptKey("branchName"), []);
  const handleEditCommit = useCallback(() => setEditingPromptKey("commitMessage"), []);
  const handleEditPullRequest = useCallback(() => setEditingPromptKey("pullRequest"), []);
  const handleClose = useCallback(() => setEditingPromptKey(null), []);

  const handleSave = useCallback(
    async (instructions: string | null) => {
      if (!editingPromptKey) return;
      await onSavePrompt(editingPromptKey, instructions);
      setEditingPromptKey(null);
    },
    [editingPromptKey, onSavePrompt],
  );

  const titleSummary =
    metadataGeneration.title?.instructions || t("settings.metadataGeneration.prompts.default");
  const branchSummary =
    metadataGeneration.branchName?.instructions || t("settings.metadataGeneration.prompts.default");
  const commitSummary =
    metadataGeneration.commitMessage?.instructions ||
    t("settings.metadataGeneration.prompts.default");
  const pullRequestSummary =
    metadataGeneration.pullRequest?.instructions ||
    t("settings.metadataGeneration.prompts.default");

  return (
    <>
      <SettingsSection
        title={t("settings.metadataGeneration.instructionsTitle")}
        info={t("settings.metadataGeneration.instructionsInfo")}
        testID="metadata-generation-instructions-section"
      >
        <SettingsCard>
          <SettingsDetailRow
            label={t("settings.metadataGeneration.prompts.title")}
            hint={t("settings.metadataGeneration.prompts.titleHint")}
            summary={titleSummary}
            onPress={handleEditTitle}
            testID="metadata-generation-prompt-title"
          />
          <SettingsDetailRow
            label={t("settings.metadataGeneration.prompts.branchName")}
            hint={t("settings.metadataGeneration.prompts.branchNameHint")}
            summary={branchSummary}
            onPress={handleEditBranch}
            testID="metadata-generation-prompt-branchName"
          />
          <SettingsDetailRow
            label={t("settings.metadataGeneration.prompts.commitMessage")}
            hint={t("settings.metadataGeneration.prompts.commitMessageHint")}
            summary={commitSummary}
            onPress={handleEditCommit}
            testID="metadata-generation-prompt-commitMessage"
          />
          <SettingsDetailRow
            label={t("settings.metadataGeneration.prompts.pullRequest")}
            hint={t("settings.metadataGeneration.prompts.pullRequestHint")}
            summary={pullRequestSummary}
            onPress={handleEditPullRequest}
            testID="metadata-generation-prompt-pullRequest"
          />
        </SettingsCard>
      </SettingsSection>

      {editingPromptKey ? (
        <MetadataPromptSheet
          promptKey={editingPromptKey}
          currentValue={metadataGeneration[editingPromptKey]?.instructions ?? ""}
          isSaving={isSaving}
          onSave={handleSave}
          onClose={handleClose}
        />
      ) : null}
    </>
  );
}

function MetadataPromptSheet({
  promptKey,
  currentValue,
  isSaving,
  onSave,
  onClose,
}: {
  promptKey: PromptKey;
  currentValue: string;
  isSaving: boolean;
  onSave: (instructions: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(currentValue);
  const header = useMemo<SheetHeader>(
    () => ({ title: t(`settings.metadataGeneration.prompts.${promptKey}`) }),
    [promptKey, t],
  );
  const placeholder = t(`settings.metadataGeneration.prompts.${promptKey}Placeholder`);
  const hasChanges = draft.trim() !== currentValue.trim();

  const handleReset = useCallback(() => {
    setDraft("");
  }, []);

  const handleSave = useCallback(() => {
    const trimmed = draft.trim();
    void onSave(trimmed ? trimmed : null);
  }, [draft, onSave]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      testID={`metadata-prompt-sheet-${promptKey}`}
      desktopMaxWidth={560}
    >
      <SettingsTextAreaCard
        testID={`metadata-prompt-input-${promptKey}`}
        accessibilityLabel={header.title}
        value={draft}
        onChangeText={setDraft}
        placeholder={placeholder}
      />
      <View style={styles.sheetActions}>
        <Button
          variant="ghost"
          onPress={handleReset}
          disabled={!draft || isSaving}
          testID="metadata-prompt-reset"
        >
          {t("settings.metadataGeneration.prompts.resetToDefault")}
        </Button>
        <Button
          variant="default"
          onPress={handleSave}
          disabled={!hasChanges || isSaving}
          testID="metadata-prompt-save"
        >
          {t("settings.metadataGeneration.prompts.save")}
        </Button>
      </View>
    </AdaptiveModalSheet>
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
  sheetActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[4],
  },
}));

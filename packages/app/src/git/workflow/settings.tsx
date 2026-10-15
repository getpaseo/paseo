import { useCallback, useMemo, useState } from "react";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useAgentProfiles } from "@/agent-profiles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { SettingsTextAreaCard } from "@/components/settings-textarea";
import { Button } from "@/components/ui/button";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { findModelByReference } from "@/provider-selection/model-catalog";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import {
  createWorkspaceGitWorkflowSettingsModel,
  workspaceGitWorkflowSettingsPatch,
  selectWorkspaceWorkflowModel,
  type WorkspaceWorkflowModel,
  type WorkspaceWorkflowModelKey,
  type WorkspaceGitWorkflowSettingsModel,
} from "./settings-model";

const MODEL_FIELDS = ["reviewModel", "commitModel", "prModel"] as const;

function selectionSummary(selection: WorkspaceWorkflowModel | null | undefined) {
  return selection
    ? [selection.provider, selection.model, selection.thinkingOptionId].filter(Boolean).join(" · ")
    : null;
}

export function WorkspaceGitWorkflowSettingsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { config, isLoading, patchConfig } = useDaemonConfig(serverId);
  const snapshot = useProvidersSnapshot(serverId);
  const { profiles } = useAgentProfiles(serverId);
  const [draft, setDraft] = useState<WorkspaceGitWorkflowSettingsModel | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = useCallback(() => {
    if (!config || isLoading) return;
    setError(null);
    setDraft(createWorkspaceGitWorkflowSettingsModel(config?.workspaceGitWorkflow));
  }, [config, isLoading]);
  const close = useCallback(() => {
    if (!saving) setDraft(null);
  }, [saving]);
  const update = useCallback(
    <K extends keyof WorkspaceGitWorkflowSettingsModel>(
      key: K,
      value: WorkspaceGitWorkflowSettingsModel[K],
    ) => {
      setDraft((current) => (current ? { ...current, [key]: value } : current));
    },
    [],
  );
  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await patchConfig({
        workspaceGitWorkflow: workspaceGitWorkflowSettingsPatch(draft),
      });
      if (!saved) throw new Error(t("workspace.git.workflow.saveFailed"));
      setDraft(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("workspace.git.workflow.saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [draft, patchConfig, t]);
  const header = useMemo(() => ({ title: t("workspace.git.workflow.title") }), [t]);
  const onReviewPrompt = useCallback((value: string) => update("reviewPrompt", value), [update]);
  const onCreatePrPrompt = useCallback(
    (value: string) => update("createPrPrompt", value),
    [update],
  );
  const onCommitAndPushPrompt = useCallback(
    (value: string) => update("commitAndPushPrompt", value),
    [update],
  );
  const handleSave = useCallback(() => void save(), [save]);
  const labels = {
    reviewModel: t("workspace.git.workflow.review"),
    commitModel: "Commit",
    prModel: "PR",
  };
  const fallback = (key: WorkspaceWorkflowModelKey) => {
    const profileIds = {
      reviewModel: config?.workspaceGitWorkflow?.reviewProfileId,
      prModel: config?.workspaceGitWorkflow?.deliveryProfileId,
      commitModel: undefined,
    };
    const id = profileIds[key];
    return id
      ? (profiles?.find((profile) => profile.id === id)?.name ??
          `${id} — ${t("workspace.git.workflow.missingProfile")}`)
      : t("workspace.git.workflow.defaultSelection");
  };

  const footer = useMemo(
    () => (
      <Button
        size="sm"
        variant="default"
        onPress={handleSave}
        disabled={saving}
        testID="workspace-git-workflow-save"
      >
        {saving ? t("workspace.git.workflow.saving") : t("workspace.git.workflow.save")}
      </Button>
    ),
    [handleSave, saving, t],
  );

  return (
    <>
      <SettingsSection title={t("workspace.git.workflow.title")}>
        <SettingsCard testID="workspace-git-workflow-settings">
          {MODEL_FIELDS.map((key, index) => (
            <SettingsRow
              key={key}
              label={labels[key]}
              hint={selectionSummary(config?.workspaceGitWorkflow?.[key]) ?? fallback(key)}
            >
              {index === 0 ? (
                <Button
                  size="sm"
                  variant="outline"
                  onPress={open}
                  disabled={isLoading || !config}
                  testID="workspace-git-workflow-edit"
                >
                  {t("workspace.git.workflow.edit")}
                </Button>
              ) : null}
            </SettingsRow>
          ))}
        </SettingsCard>
      </SettingsSection>
      {draft ? (
        <AdaptiveModalSheet
          header={header}
          visible
          onClose={close}
          desktopMaxWidth={560}
          footer={footer}
          testID="workspace-git-workflow-settings-sheet"
        >
          <View style={styles.form}>
            {MODEL_FIELDS.map((key) => (
              <WorkflowModelField
                key={key}
                label={labels[key]}
                selection={draft[key]}
                fallback={fallback(key)}
                snapshot={snapshot}
                serverId={serverId}
                disabled={saving}
                fieldKey={key}
                onChange={update}
                testID={`workspace-git-workflow-${key}`}
              />
            ))}
            <PromptField
              label={t("workspace.git.workflow.reviewPrompt")}
              value={draft.reviewPrompt}
              onChange={onReviewPrompt}
              testID="workspace-git-workflow-review-prompt"
            />
            <PromptField
              label={t("workspace.git.workflow.createPrPrompt")}
              value={draft.createPrPrompt}
              onChange={onCreatePrPrompt}
              testID="workspace-git-workflow-create-pr-prompt"
            />
            <PromptField
              label={t("workspace.git.workflow.commitAndPushPrompt")}
              value={draft.commitAndPushPrompt}
              onChange={onCommitAndPushPrompt}
              testID="workspace-git-workflow-commit-push-prompt"
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
}

function WorkflowModelField({
  label,
  selection,
  fallback,
  snapshot,
  serverId,
  disabled,
  onChange,
  testID,
  fieldKey,
}: {
  fieldKey: WorkspaceWorkflowModelKey;
  label: string;
  selection: WorkspaceWorkflowModel | null;
  fallback: string;
  snapshot: ReturnType<typeof useProvidersSnapshot>;
  serverId: string;
  disabled: boolean;
  onChange: (key: WorkspaceWorkflowModelKey, selection: WorkspaceWorkflowModel | null) => void;
  testID: string;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const selectedProvider = selection?.provider ?? "";
  const providers = useMemo(
    () => buildSelectableProviderSelectorProviders(snapshot.entries),
    [snapshot.entries],
  );
  const entry = snapshot.entries?.find((candidate) => candidate.provider === selectedProvider);
  const model = findModelByReference(entry?.models ?? null, selection?.model ?? "");
  const thinkingOptions = useMemo<SelectFieldOption<string>[]>(
    () => [
      { id: "", value: "", label: t("providerSelection.defaultModel") },
      ...(model?.thinkingOptions ?? []).map((option) => ({
        id: option.id,
        value: option.id,
        label: formatThinkingOptionLabel(option),
      })),
    ],
    [model, t],
  );
  const unavailable = useMemo(
    () =>
      Boolean(
        selection &&
        snapshot.entries &&
        !snapshot.isLoading &&
        !snapshot.isFetching &&
        (!entry?.enabled ||
          entry.status === "unavailable" ||
          entry.status === "error" ||
          (entry.status === "ready" && selection.model && !model)),
      ),
    [selection, snapshot.entries, snapshot.isLoading, snapshot.isFetching, entry, model],
  );
  const handleReset = useCallback(() => onChange(fieldKey, null), [fieldKey, onChange]);
  const handleSelect = useCallback(
    (provider: AgentProvider, modelId: string) => {
      const definition = findModelByReference(
        snapshot.entries?.find((candidate) => candidate.provider === provider)?.models ?? null,
        modelId,
      );
      onChange(fieldKey, selectWorkspaceWorkflowModel(selection, provider, modelId, definition));
    },
    [fieldKey, onChange, selection, snapshot.entries],
  );
  const handleOpen = useCallback(
    () => snapshot.refetchIfStale(selectedProvider),
    [selectedProvider, snapshot],
  );
  const handleRetry = useCallback(
    (provider: AgentProvider) => {
      void snapshot.refresh([provider]);
    },
    [snapshot],
  );
  const handleThinking = useCallback(
    (thinkingOptionId: string) => {
      if (!selection) return;
      const { thinkingOptionId: _, ...rest } = selection;
      onChange(fieldKey, { ...rest, ...(thinkingOptionId ? { thinkingOptionId } : {}) });
    },
    [fieldKey, onChange, selection],
  );
  const thinkingDisplay = useMemo(
    () => ({
      label:
        thinkingOptions.find((option) => option.value === (selection?.thinkingOptionId ?? ""))
          ?.label ??
        selection?.thinkingOptionId ??
        "",
    }),
    [selection?.thinkingOptionId, thinkingOptions],
  );

  return (
    <View style={styles.modelField} testID={testID}>
      <View style={styles.modelHeading}>
        <Text style={styles.label}>{label}</Text>
        {selection ? (
          <Button size="sm" variant="ghost" disabled={disabled} onPress={handleReset}>
            {t("workspace.git.workflow.resetSelection")}
          </Button>
        ) : null}
      </View>
      {!selection ? <Text style={styles.fallback}>{fallback}</Text> : null}
      <CombinedModelSelector
        providers={providers}
        selectedProvider={selectedProvider}
        selectedModel={selection?.model ?? ""}
        onSelect={handleSelect}
        isLoading={snapshot.isLoading || snapshot.isFetching}
        onOpen={handleOpen}
        onRetryProvider={handleRetry}
        isRetryingProvider={snapshot.isRefreshing}
        disabled={disabled}
        serverId={serverId}
        desktopPlacement="bottom-start"
        desktopMinWidth={360}
      />
      {unavailable ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {selectionSummary(selection)} — {t("providerSelection.unavailable")}
        </Text>
      ) : null}
      {selection && (thinkingOptions.length > 1 || selection.thinkingOptionId) ? (
        <SelectField
          label={t("agentControls.thinking.title")}
          value={selection.thinkingOptionId ?? ""}
          selectedDisplay={thinkingDisplay}
          options={thinkingOptions}
          onChange={handleThinking}
          placeholder={t("agentControls.thinking.select")}
          emptyText={t("agentControls.thinking.unknown")}
          disabled={disabled}
          size={compact ? "md" : "sm"}
          testID={`${testID}-thinking`}
        />
      ) : null}
    </View>
  );
}

function PromptField({
  label,
  value,
  onChange,
  testID,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  testID: string;
}) {
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <SettingsTextAreaCard
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        testID={testID}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  form: { gap: theme.spacing[4] },
  modelField: { gap: theme.spacing[2] },
  modelHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  fallback: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));

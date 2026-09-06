import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Check, MoreVertical } from "lucide-react-native";
import type { Assistant, AssistantTemplate } from "@getpaseo/protocol/assistants";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { HostFilter } from "@/components/hosts/host-filter";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isNative } from "@/constants/platform";
import { useLiveVoiceHostAvailability } from "@/live-voice/live-voice-availability";
import { useLiveVoiceBackendModelOptions } from "@/live-voice/live-voice-backend-model-catalog";
import { useLiveVoiceVoiceOptions } from "@/hooks/use-live-voice-voice-options";
import { useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { openAssistantForm, type AssistantFormModel } from "./assistant-form-model";
import { AssistantFormView } from "./assistant-form-view";
import { AssistantHistoryView } from "./assistant-history-view";
import { useAssistantMutations } from "./assistant-mutations";
import { useAssistants, useAssistantTemplates } from "./assistant-queries";
import { useAssistantSelectionStore } from "./assistant-selection-store";

const ThemedKebab = withUnistyles(MoreVertical);
const ThemedCheck = withUnistyles(Check);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const successMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const ROW_ICON_SIZE = 14;

type SheetView =
  | { kind: "list" }
  | { kind: "form"; model: AssistantFormModel; title: string }
  | { kind: "history"; assistant: Assistant };

export interface AssistantsSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Which host to open on. Falls back to the first host with assistants. */
  initialServerId?: string | null;
}

/**
 * Templates and instances for one host, and everything done to them: create
 * from a template, edit, pick for the launcher, read and compact history,
 * delete. Three views in one sheet, reached through the header's back arrow,
 * so the user is never left on a stale list while a second modal edits it.
 */
export function AssistantsSheet(props: AssistantsSheetProps): ReactElement | null {
  return props.visible ? <OpenAssistantsSheet {...props} /> : null;
}

function OpenAssistantsSheet({
  onClose,
  initialServerId = null,
}: AssistantsSheetProps): ReactElement {
  const { t } = useTranslation();
  const hosts = useHosts();
  const availability = useLiveVoiceHostAvailability();
  const capableHosts = useMemo(
    () =>
      hosts.filter((host) =>
        availability.some(
          (candidate) =>
            candidate.serverId === host.serverId &&
            candidate.connectionStatus === "online" &&
            candidate.supportsAssistants === true,
        ),
      ),
    [availability, hosts],
  );
  const [chosenServerId, setChosenServerId] = useState<string | null>(
    () => initialServerId ?? capableHosts[0]?.serverId ?? null,
  );
  const serverId = chosenServerId;
  useEffect(() => {
    if (chosenServerId === null && capableHosts[0]) setChosenServerId(capableHosts[0].serverId);
  }, [capableHosts, chosenServerId]);

  const [view, setView] = useState<SheetView>({ kind: "list" });

  const {
    assistants,
    isLoading: isLoadingAssistants,
    error: assistantsError,
  } = useAssistants(serverId);
  const { templates, error: templatesError } = useAssistantTemplates(serverId);
  const [actionError, setActionError] = useState<string | null>(null);
  const voiceOptions = useLiveVoiceVoiceOptions();
  const backendModelOptions = useLiveVoiceBackendModelOptions();
  const mutations = useAssistantMutations({ serverId: serverId ?? "" });
  const selectedAssistantId = useAssistantSelectionStore((state) =>
    serverId ? (state.selectedByServerId[serverId] ?? null) : null,
  );
  const selectAssistant = useAssistantSelectionStore((state) => state.select);

  // Late catalog data is an explicit model input, never a reconstruction.
  const formModel = view.kind === "form" ? view.model : null;
  useEffect(() => () => formModel?.close(), [formModel]);
  useEffect(() => {
    formModel?.applyTemplates(templates);
  }, [formModel, templates]);
  useEffect(() => {
    formModel?.applyVoiceOptions(voiceOptions);
  }, [formModel, voiceOptions]);
  useEffect(() => {
    formModel?.applyBackendModelOptions(backendModelOptions);
  }, [backendModelOptions, formModel]);

  const showList = useCallback(() => {
    setView((current) => {
      if (current.kind === "form") current.model.close();
      return { kind: "list" };
    });
  }, []);

  const openForm = useCallback(
    (title: string, snapshot: Parameters<typeof openAssistantForm>[0]) => {
      setView((current) => {
        if (current.kind === "form") current.model.close();
        return { kind: "form", title, model: openAssistantForm(snapshot) };
      });
    },
    [],
  );

  const baseSnapshot = useMemo(
    () => ({ templates, voiceOptions, backendModelOptions }),
    [backendModelOptions, templates, voiceOptions],
  );

  const handleNewAssistant = useCallback(
    (templateId?: string) => {
      const template = templates.find((candidate) => candidate.id === templateId);
      openForm(t("assistants.form.createAssistantTitle"), {
        ...baseSnapshot,
        kind: "assistant",
        mode: "create",
        ...(template
          ? { seed: { templateId: template.id, configuration: template.configuration } }
          : {}),
      });
    },
    [baseSnapshot, openForm, t, templates],
  );
  const handleEditAssistant = useCallback(
    (assistant: Assistant) => {
      openForm(t("assistants.form.editAssistantTitle"), {
        ...baseSnapshot,
        kind: "assistant",
        mode: "edit",
        record: assistant,
      });
    },
    [baseSnapshot, openForm, t],
  );
  const handleNewTemplate = useCallback(
    (seed?: Assistant) => {
      openForm(t("assistants.form.createTemplateTitle"), {
        ...baseSnapshot,
        kind: "template",
        mode: "create",
        ...(seed ? { seed: { name: seed.name, configuration: seed.configuration } } : {}),
      });
    },
    [baseSnapshot, openForm, t],
  );
  const handleEditTemplate = useCallback(
    (template: AssistantTemplate) => {
      openForm(t("assistants.form.editTemplateTitle"), {
        ...baseSnapshot,
        kind: "template",
        mode: "edit",
        record: template,
      });
    },
    [baseSnapshot, openForm, t],
  );
  const handleOpenHistory = useCallback((assistant: Assistant) => {
    setView({ kind: "history", assistant });
  }, []);

  const handleSelectForCalls = useCallback(
    (assistant: Assistant | null) => {
      if (serverId) selectAssistant(serverId, assistant?.id ?? null);
    },
    [selectAssistant, serverId],
  );

  const handleDeleteAssistant = useCallback(
    async (assistant: Assistant) => {
      const confirmed = await confirmDialog({
        title: t("assistants.actions.deleteAssistantTitle", { name: assistant.name }),
        message: t("assistants.actions.deleteAssistantMessage"),
        confirmLabel: t("assistants.actions.delete"),
        destructive: true,
      });
      if (!confirmed) return;
      setActionError(null);
      try {
        await mutations.deleteAssistant(assistant.id);
      } catch (error) {
        setActionError(toErrorMessage(error));
      }
    },
    [mutations, t],
  );
  const handleDeleteTemplate = useCallback(
    async (template: AssistantTemplate) => {
      const confirmed = await confirmDialog({
        title: t("assistants.actions.deleteTemplateTitle", { name: template.name }),
        message: t("assistants.actions.deleteTemplateMessage"),
        confirmLabel: t("assistants.actions.delete"),
        destructive: true,
      });
      if (!confirmed) return;
      setActionError(null);
      try {
        await mutations.deleteTemplate(template.id);
      } catch (error) {
        setActionError(toErrorMessage(error));
      }
    },
    [mutations, t],
  );

  const handleCompact = useCallback(
    async (input: { assistant: Assistant; summary: string; throughSeq: number }) => {
      await mutations.compactAssistant({
        assistantId: input.assistant.id,
        expectedRevision: input.assistant.revision,
        throughSeq: input.throughSeq,
        summary: input.summary,
      });
    },
    [mutations],
  );

  const submitForm = useCallback(async () => {
    if (view.kind !== "form") return;
    const { model } = view;
    const state = model.getState();
    if (!state.canSubmit) return;
    model.setSubmitError(null);
    try {
      if (state.kind === "template") {
        await mutations.saveTemplate(model.buildSaveTemplateInput());
      } else if (state.mode === "create") {
        const created = await mutations.createAssistant(model.buildCreateAssistantInput());
        // The first assistant on a host is what the launcher should reach for.
        if (serverId && assistants.length === 0) selectAssistant(serverId, created.id);
      } else {
        await mutations.updateAssistant(model.buildUpdateAssistantInput());
      }
      showList();
    } catch (error) {
      model.setSubmitError(toErrorMessage(error));
    }
  }, [assistants.length, mutations, selectAssistant, serverId, showList, view]);
  const handleSubmitPress = useCallback(() => {
    void submitForm();
  }, [submitForm]);

  const handleNewAssistantPress = useCallback(() => handleNewAssistant(), [handleNewAssistant]);
  const handleNewTemplatePress = useCallback(() => handleNewTemplate(), [handleNewTemplate]);

  const header = useMemo<SheetHeader>(() => {
    if (view.kind === "form") {
      return { title: view.title, back: { onPress: showList } };
    }
    if (view.kind === "history") {
      return { title: view.assistant.name, back: { onPress: showList } };
    }
    return { title: t("assistants.manage.title") };
  }, [showList, t, view]);

  const footer = useMemo(
    () =>
      view.kind === "form" ? (
        <AssistantFormFooter
          model={view.model}
          isSaving={mutations.isSaving}
          onCancel={showList}
          onSubmit={handleSubmitPress}
        />
      ) : undefined,
    [view, mutations.isSaving, showList, handleSubmitPress],
  );

  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      footer={footer}
      sizeContentToCurrentSnapPoint
      testID="assistants-sheet"
    >
      {view.kind === "form" ? (
        <AssistantFormView model={view.model} disabled={mutations.isSaving} />
      ) : null}
      {view.kind === "history" && serverId ? (
        <AssistantHistoryView
          key={`${serverId}:${view.assistant.id}`}
          serverId={serverId}
          assistantId={view.assistant.id}
          disabled={mutations.isSaving}
          onCompact={handleCompact}
        />
      ) : null}
      {view.kind === "list" ? (
        <View style={styles.list}>
          {actionError ? <Text style={styles.error}>{actionError}</Text> : null}
          {capableHosts.length > 1 && serverId ? (
            <HostFilter
              hosts={capableHosts}
              selectedHost={serverId}
              onSelectHost={setChosenServerId}
              includeAllHost={false}
              triggerTestID="assistants-sheet-host"
            />
          ) : null}
          {!serverId ? <Text style={styles.muted}>{t("assistants.manage.noHosts")}</Text> : null}
          {serverId ? (
            <>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>{t("assistants.manage.assistants")}</Text>
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={handleNewAssistantPress}
                  disabled={mutations.isSaving}
                  testID="assistants-sheet-new-assistant"
                >
                  {t("assistants.actions.newAssistant")}
                </Button>
              </View>
              {assistantsError ? (
                <Text style={styles.error}>{toErrorMessage(assistantsError)}</Text>
              ) : null}
              {assistants.length === 0 && !isLoadingAssistants ? (
                <Text style={styles.muted}>{t("assistants.manage.empty")}</Text>
              ) : null}
              {assistants.map((assistant) => (
                <AssistantRow
                  key={assistant.id}
                  assistant={assistant}
                  templateName={
                    templates.find((template) => template.id === assistant.templateId)?.name ?? null
                  }
                  isSelected={assistant.id === selectedAssistantId}
                  disabled={mutations.isDeleting}
                  onSelectForCalls={handleSelectForCalls}
                  onOpenHistory={handleOpenHistory}
                  onEdit={handleEditAssistant}
                  onSaveAsTemplate={handleNewTemplate}
                  onDelete={handleDeleteAssistant}
                />
              ))}

              <View style={[styles.sectionHeader, styles.sectionHeaderSpaced]}>
                <Text style={styles.sectionTitle}>{t("assistants.manage.templates")}</Text>
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={handleNewTemplatePress}
                  disabled={mutations.isSaving}
                  testID="assistants-sheet-new-template"
                >
                  {t("assistants.actions.newTemplate")}
                </Button>
              </View>
              {templatesError ? (
                <Text style={styles.error}>{toErrorMessage(templatesError)}</Text>
              ) : null}
              {templates.length === 0 ? (
                <Text style={styles.muted}>{t("assistants.manage.templatesEmpty")}</Text>
              ) : null}
              {templates.map((template) => (
                <TemplateRow
                  key={template.id}
                  template={template}
                  disabled={mutations.isDeleting}
                  onCreateFrom={handleNewAssistant}
                  onEdit={handleEditTemplate}
                  onDelete={handleDeleteTemplate}
                />
              ))}
            </>
          ) : null}
        </View>
      ) : null}
    </AdaptiveModalSheet>
  );
}

function AssistantFormFooter({
  model,
  isSaving,
  onCancel,
  onSubmit,
}: {
  model: AssistantFormModel;
  isSaving: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  return (
    <View style={styles.footer}>
      <Button
        style={styles.footerButton}
        variant="secondary"
        onPress={onCancel}
        disabled={isSaving}
      >
        {t("common.actions.cancel")}
      </Button>
      <Button
        style={styles.footerButton}
        variant="default"
        onPress={onSubmit}
        disabled={!state.canSubmit || isSaving}
        loading={isSaving}
        testID="assistant-form-submit"
      >
        {state.mode === "edit" ? t("assistants.form.save") : t("assistants.form.create")}
      </Button>
    </View>
  );
}

function renderKebabTriggerIcon({ hovered }: { hovered?: boolean }): ReactElement {
  return <ThemedKebab size={ROW_ICON_SIZE} uniProps={hovered ? foregroundMapping : mutedMapping} />;
}

function kebabTriggerStyle({
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.kebabTrigger, hovered && styles.kebabTriggerHovered];
}

function AssistantRow({
  assistant,
  templateName,
  isSelected,
  disabled,
  onSelectForCalls,
  onOpenHistory,
  onEdit,
  onSaveAsTemplate,
  onDelete,
}: {
  assistant: Assistant;
  templateName: string | null;
  isSelected: boolean;
  disabled: boolean;
  onSelectForCalls: (assistant: Assistant | null) => void;
  onOpenHistory: (assistant: Assistant) => void;
  onEdit: (assistant: Assistant) => void;
  onSaveAsTemplate: (assistant: Assistant) => void;
  onDelete: (assistant: Assistant) => Promise<void>;
}): ReactElement {
  const { t } = useTranslation();
  let hint = t("assistants.manage.entries", { n: assistant.lastSeq });
  if (templateName) hint = t("assistants.manage.fromTemplate", { name: templateName });
  if (isSelected) hint = t("assistants.manage.selectedForCalls");
  const handleSelect = useCallback(
    () => onSelectForCalls(isSelected ? null : assistant),
    [onSelectForCalls, isSelected, assistant],
  );
  const handleHistory = useCallback(() => onOpenHistory(assistant), [onOpenHistory, assistant]);
  const handleEdit = useCallback(() => onEdit(assistant), [onEdit, assistant]);
  const handleTemplate = useCallback(
    () => onSaveAsTemplate(assistant),
    [onSaveAsTemplate, assistant],
  );
  const handleDelete = useCallback(() => {
    void onDelete(assistant);
  }, [onDelete, assistant]);
  return (
    <View style={styles.row} testID={`assistant-row-${assistant.id}`}>
      <View style={styles.rowContent}>
        <View style={styles.rowTitleLine}>
          {isSelected ? <ThemedCheck size={ROW_ICON_SIZE} uniProps={successMapping} /> : null}
          <Text style={styles.rowTitle} numberOfLines={1}>
            {assistant.name}
          </Text>
        </View>
        <Text style={styles.rowHint} numberOfLines={1}>
          {hint}
        </Text>
      </View>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={kebabTriggerStyle}
          accessibilityRole={isNative ? "button" : undefined}
          accessibilityLabel={t("assistants.actions.menu", { name: assistant.name })}
          testID={`assistant-kebab-${assistant.id}`}
        >
          {renderKebabTriggerIcon}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" width={240}>
          <DropdownMenuItem
            onSelect={handleSelect}
            testID={`assistant-menu-select-${assistant.id}`}
          >
            {isSelected ? t("assistants.actions.stopUsing") : t("assistants.actions.useForCalls")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleHistory}>
            {t("assistants.actions.openHistory")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleEdit}>{t("assistants.actions.edit")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={handleTemplate}>
            {t("assistants.actions.saveAsTemplate")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            destructive
            disabled={disabled}
            onSelect={handleDelete}
            testID={`assistant-menu-delete-${assistant.id}`}
          >
            {t("assistants.actions.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function TemplateRow({
  template,
  disabled,
  onCreateFrom,
  onEdit,
  onDelete,
}: {
  template: AssistantTemplate;
  disabled: boolean;
  onCreateFrom: (templateId: string) => void;
  onEdit: (template: AssistantTemplate) => void;
  onDelete: (template: AssistantTemplate) => Promise<void>;
}): ReactElement {
  const { t } = useTranslation();
  const handleCreate = useCallback(() => onCreateFrom(template.id), [onCreateFrom, template.id]);
  const handleEdit = useCallback(() => onEdit(template), [onEdit, template]);
  const handleDelete = useCallback(() => {
    void onDelete(template);
  }, [onDelete, template]);
  return (
    <View style={styles.row} testID={`assistant-template-row-${template.id}`}>
      <View style={styles.rowContent}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {template.name}
        </Text>
        {template.configuration.instructions ? (
          <Text style={styles.rowHint} numberOfLines={1}>
            {template.configuration.instructions}
          </Text>
        ) : null}
      </View>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={kebabTriggerStyle}
          accessibilityRole={isNative ? "button" : undefined}
          accessibilityLabel={t("assistants.actions.menu", { name: template.name })}
          testID={`assistant-template-kebab-${template.id}`}
        >
          {renderKebabTriggerIcon}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" width={240}>
          <DropdownMenuItem onSelect={handleCreate}>
            {t("assistants.actions.newFromTemplate")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleEdit}>{t("assistants.actions.edit")}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive disabled={disabled} onSelect={handleDelete}>
            {t("assistants.actions.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[2],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  sectionHeaderSpaced: {
    marginTop: theme.spacing[4],
  },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  rowContent: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  rowTitleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  rowTitle: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  rowHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  kebabTrigger: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  kebabTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  footer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
}));

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentTemplate } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";

interface AgentTemplatesCardProps {
  serverId: string;
}

interface TemplateFormState {
  id: string;
  name: string;
  description: string;
  instructions: string;
  provider: string;
}

interface EditorState {
  key: number;
  mode: "add" | "edit";
  initial: TemplateFormState;
}

const EMPTY_FORM: TemplateFormState = {
  id: "",
  name: "",
  description: "",
  instructions: "",
  provider: "",
};

function templateToForm(id: string, template: AgentTemplate): TemplateFormState {
  return {
    id,
    name: template.name,
    description: template.description,
    instructions: template.instructions,
    provider: template.provider ?? "",
  };
}

function AgentTemplateRow({
  id,
  template,
  isFirst,
  onToggle,
  onEdit,
  onRemove,
}: {
  id: string;
  template: AgentTemplate;
  isFirst: boolean;
  onToggle: (id: string, template: AgentTemplate, enabled: boolean) => void;
  onEdit: (id: string, template: AgentTemplate) => void;
  onRemove: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const handleToggle = useCallback(
    (enabled: boolean) => onToggle(id, template, enabled),
    [id, onToggle, template],
  );
  const handleEdit = useCallback(() => onEdit(id, template), [id, onEdit, template]);
  const handleRemove = useCallback(() => void onRemove(id), [id, onRemove]);

  return (
    <View
      style={[styles.row, !isFirst && settingsStyles.rowBorder]}
      testID={`agent-template-row-${id}`}
    >
      <View style={styles.rowContent}>
        <Text style={styles.name}>{template.name}</Text>
        <Text style={styles.id}>{id}</Text>
        <Text style={styles.description} numberOfLines={2}>
          {template.description}
        </Text>
      </View>
      <View style={styles.actions}>
        <Switch
          value={template.enabled !== false}
          onValueChange={handleToggle}
          accessibilityLabel={t("settings.host.orchestration.agentTemplates.enableAccessibility", {
            name: template.name,
          })}
        />
        <Button variant="ghost" size="sm" onPress={handleEdit}>
          {t("settings.host.orchestration.agentTemplates.edit")}
        </Button>
        <Button variant="ghost" size="sm" onPress={handleRemove}>
          {t("settings.host.orchestration.agentTemplates.remove")}
        </Button>
      </View>
    </View>
  );
}

export function AgentTemplatesCard({ serverId }: AgentTemplatesCardProps) {
  const { t } = useTranslation();
  const supportsAgentTemplates = useHostFeature(serverId, "hostManagedAgentTemplates");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const templates = useMemo(() => config?.agentTemplates ?? {}, [config?.agentTemplates]);
  const entries = useMemo(
    () => Object.entries(templates).sort(([left], [right]) => left.localeCompare(right)),
    [templates],
  );
  const handleOpenAdd = useCallback(
    () => setEditor({ key: Date.now(), mode: "add", initial: { ...EMPTY_FORM } }),
    [],
  );
  const handleOpenEdit = useCallback((id: string, template: AgentTemplate) => {
    setEditor({ key: Date.now(), mode: "edit", initial: templateToForm(id, template) });
  }, []);
  const handleCloseEditor = useCallback(() => setEditor(null), []);

  const handleSave = useCallback(
    async (id: string, template: AgentTemplate) => {
      if (editor?.mode === "add" && templates[id]) {
        throw new Error(t("settings.host.orchestration.agentTemplates.duplicateId", { id }));
      }
      const existingEnabled = templates[id]?.enabled;
      const nextTemplate =
        existingEnabled === undefined ? template : { ...template, enabled: existingEnabled };
      await patchConfig({ upsertAgentTemplates: { [id]: nextTemplate } });
    },
    [editor?.mode, patchConfig, t, templates],
  );

  const handleToggle = useCallback(
    (id: string, template: AgentTemplate, enabled: boolean) => {
      void patchConfig({ upsertAgentTemplates: { [id]: { ...template, enabled } } });
    },
    [patchConfig],
  );

  const handleRemove = useCallback(
    async (id: string) => {
      const confirmed = await confirmDialog({
        title: t("settings.host.orchestration.agentTemplates.removeTitle"),
        message: t("settings.host.orchestration.agentTemplates.removeMessage", { id }),
        confirmLabel: t("settings.host.orchestration.agentTemplates.remove"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (confirmed) await patchConfig({ removeAgentTemplates: [id] });
    },
    [patchConfig, t],
  );

  if (!supportsAgentTemplates) return null;

  return (
    <>
      <View style={settingsStyles.card} testID="host-page-agent-templates-card">
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.host.orchestration.agentTemplates.title")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.host.orchestration.agentTemplates.hint")}
            </Text>
          </View>
          <Button variant="outline" size="sm" onPress={handleOpenAdd} testID="agent-template-add">
            {t("settings.host.orchestration.agentTemplates.add")}
          </Button>
        </View>

        {entries.length === 0 ? (
          <Text style={styles.empty}>{t("settings.host.orchestration.agentTemplates.empty")}</Text>
        ) : (
          entries.map(([id, template], index) => (
            <AgentTemplateRow
              key={id}
              id={id}
              template={template}
              isFirst={index === 0}
              onToggle={handleToggle}
              onEdit={handleOpenEdit}
              onRemove={handleRemove}
            />
          ))
        )}
      </View>

      {editor ? (
        <AgentTemplateModal
          key={editor.key}
          mode={editor.mode}
          initial={editor.initial}
          onClose={handleCloseEditor}
          onSave={handleSave}
        />
      ) : null}
    </>
  );
}

function AgentTemplateModal({
  mode,
  initial,
  onClose,
  onSave,
}: {
  mode: "add" | "edit";
  initial: TemplateFormState;
  onClose: () => void;
  onSave: (id: string, template: AgentTemplate) => Promise<void>;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [state, setState] = useState(initial);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const header = useMemo<SheetHeader>(
    () => ({
      title: t(
        mode === "add"
          ? "settings.host.orchestration.agentTemplates.addTitle"
          : "settings.host.orchestration.agentTemplates.editTitle",
        { name: initial.name },
      ),
    }),
    [initial.name, mode, t],
  );
  const controlSize = isCompact ? "md" : "sm";
  const update = useCallback((key: keyof TemplateFormState, value: string) => {
    setState((current) => ({ ...current, [key]: value }));
    setError(null);
  }, []);
  const handleIdChange = useCallback((value: string) => update("id", value), [update]);
  const handleNameChange = useCallback((value: string) => update("name", value), [update]);
  const handleDescriptionChange = useCallback(
    (value: string) => update("description", value),
    [update],
  );
  const handleProviderChange = useCallback((value: string) => update("provider", value), [update]);
  const handleInstructionsChange = useCallback(
    (value: string) => update("instructions", value),
    [update],
  );

  const handleSave = useCallback(async () => {
    const id = state.id.trim();
    const provider = state.provider.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      setError(t("settings.host.orchestration.agentTemplates.invalidId"));
      return;
    }
    if (!state.name.trim() || !state.description.trim() || !state.instructions.trim()) {
      setError(t("settings.host.orchestration.agentTemplates.requiredFields"));
      return;
    }
    if (provider && !provider.includes("/")) {
      setError(t("settings.host.orchestration.agentTemplates.invalidProvider"));
      return;
    }
    setIsPending(true);
    try {
      await onSave(id, {
        name: state.name.trim(),
        description: state.description.trim(),
        instructions: state.instructions.trim(),
        ...(provider ? { provider } : {}),
      });
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setIsPending(false);
    }
  }, [onClose, onSave, state, t]);
  const handleSavePress = useCallback(() => void handleSave(), [handleSave]);

  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={onClose}
      desktopMaxWidth={640}
      testID="agent-template-modal"
    >
      <View style={styles.modalBody}>
        <Field label={t("settings.host.orchestration.agentTemplates.id")}>
          <FormTextInput
            initialValue={initial.id}
            resetKey={`${initial.id}-id`}
            onChangeText={handleIdChange}
            editable={!isPending && mode === "add"}
            autoCapitalize="none"
            autoCorrect={false}
            size={controlSize}
          />
        </Field>
        <Field label={t("settings.host.orchestration.agentTemplates.name")}>
          <FormTextInput
            initialValue={initial.name}
            resetKey={`${initial.id}-name`}
            onChangeText={handleNameChange}
            editable={!isPending}
            size={controlSize}
          />
        </Field>
        <Field label={t("settings.host.orchestration.agentTemplates.description")}>
          <FormTextInput
            initialValue={initial.description}
            resetKey={`${initial.id}-description`}
            onChangeText={handleDescriptionChange}
            editable={!isPending}
            multiline
            size={controlSize}
          />
        </Field>
        <Field
          label={t("settings.host.orchestration.agentTemplates.provider")}
          hint={t("settings.host.orchestration.agentTemplates.providerHint")}
        >
          <FormTextInput
            initialValue={initial.provider}
            resetKey={`${initial.id}-provider`}
            onChangeText={handleProviderChange}
            editable={!isPending}
            autoCapitalize="none"
            autoCorrect={false}
            size={controlSize}
          />
        </Field>
        <Field label={t("settings.host.orchestration.agentTemplates.instructions")}>
          <FormTextInput
            initialValue={initial.instructions}
            resetKey={`${initial.id}-instructions`}
            onChangeText={handleInstructionsChange}
            editable={!isPending}
            multiline
            size={controlSize}
          />
        </Field>
        {error ? <Alert variant="error" description={error} /> : null}
        <View style={styles.modalActions}>
          <Button variant="secondary" onPress={onClose} disabled={isPending} style={styles.action}>
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            onPress={handleSavePress}
            loading={isPending}
            disabled={isPending}
            style={styles.action}
          >
            {t("settings.host.orchestration.agentTemplates.save")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  headerText: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    marginHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
  },
  rowContent: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  name: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  id: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  description: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[1],
  },
  modalBody: { gap: theme.spacing[4], padding: theme.spacing[4] },
  modalActions: { flexDirection: "row", gap: theme.spacing[2] },
  action: { flex: 1 },
}));

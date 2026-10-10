import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import { openProjectSearchForm } from "./project-search-form-model";

export function ProjectSearchSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  // COMPAT(projectSearchRoots): added after v0.9.2; remove after 2027-03-27 once supported daemons include it.
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.projectSearchRoots === true,
  );
  const { config, patchConfig } = useDaemonConfig(serverId);

  let content;
  if (!supported || !config) {
    let label = t("settings.projectSearch.loading");
    if (!isConnected) label = t("workspace.terminal.hostDisconnected");
    else if (!supported) label = t("settings.projectSearch.updateHost");
    content = (
      <SettingsCard>
        <SettingsRow label={label} />
      </SettingsCard>
    );
  } else {
    content = (
      <ProjectSearchEditor
        key={serverId}
        savedRoots={config.projects?.searchRoots}
        patchConfig={patchConfig}
        isConnected={isConnected}
      />
    );
  }

  return (
    <SettingsSection
      title={t("settings.projectSearch.title")}
      info={t("settings.projectSearch.description")}
      testID="project-search-settings"
    >
      {content}
    </SettingsSection>
  );
}

function ProjectSearchEditor({
  savedRoots,
  patchConfig,
  isConnected,
}: {
  savedRoots: string[] | undefined;
  patchConfig: ReturnType<typeof useDaemonConfig>["patchConfig"];
  isConnected: boolean;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const size = compact ? "md" : "sm";
  const [model] = useState(() => openProjectSearchForm(savedRoots));
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  useEffect(() => () => model.close(), [model]);
  useEffect(() => model.applySavedRoots(savedRoots), [model, savedRoots]);

  const mutation = useMutation({
    mutationFn: async () => {
      const patch = model.getSubmission();
      if (!patch) return;
      const updated = await patchConfig(patch);
      if (!updated) throw new Error(t("workspace.terminal.hostDisconnected"));
      model.markSaved();
    },
  });
  const { mutate } = mutation;
  const save = useCallback(() => mutate(), [mutate]);
  const disabled = mutation.isPending || !isConnected;
  let status = "";
  if (!isConnected) status = t("workspace.terminal.hostDisconnected");
  else if (mutation.error) status = mutation.error.message;
  else if (mutation.isSuccess && !state.isDirty) status = t("settings.projectSearch.saved");

  return (
    <SettingsCard testID="project-search-editor">
      {state.roots.map((root, index) => (
        <SearchRootRow
          key={root.id}
          root={root}
          index={index}
          model={model}
          disabled={disabled}
          canRemove={state.roots.length > 1}
        />
      ))}
      <View style={styles.footer}>
        <View style={styles.actions}>
          <Button
            variant="outline"
            size={size}
            disabled={disabled || !state.canAdd}
            onPress={model.addRoot}
            testID="project-search-add"
          >
            {t("settings.projectSearch.add")}
          </Button>
          <Button
            variant="ghost"
            size={size}
            disabled={disabled}
            onPress={model.resetToHome}
            testID="project-search-reset"
          >
            {t("settings.projectSearch.reset")}
          </Button>
          <Button
            variant="default"
            size={size}
            disabled={disabled || !state.canSave}
            onPress={save}
            testID="project-search-save"
          >
            {mutation.isPending
              ? t("settings.projectSearch.saving")
              : t("settings.projectSearch.save")}
          </Button>
        </View>
        <Text
          style={[styles.status, mutation.error && settingsStyles.rowError]}
          accessibilityLiveRegion="polite"
          testID="project-search-status"
        >
          {status}
        </Text>
      </View>
    </SettingsCard>
  );
}

function SearchRootRow({
  root,
  index,
  model,
  disabled,
  canRemove,
}: {
  root: ReturnType<ReturnType<typeof openProjectSearchForm>["getState"]>["roots"][number];
  index: number;
  model: ReturnType<typeof openProjectSearchForm>;
  disabled: boolean;
  canRemove: boolean;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const size = compact ? "md" : "sm";
  const remove = useCallback(() => model.removeRoot(root.id), [model, root.id]);
  const change = useCallback((path: string) => model.setRoot(root.id, path), [model, root.id]);
  const showPathError = root.path.length > 0 && !root.isValid;
  const removeButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size={size}
        disabled={disabled || !canRemove}
        onPress={remove}
        accessibilityLabel={t("settings.projectSearch.removeDirectory", { number: index + 1 })}
        testID={`project-search-remove-${index}`}
      >
        {t("settings.projectSearch.remove")}
      </Button>
    ),
    [size, disabled, canRemove, remove, t, index],
  );
  return (
    <View style={styles.fieldRow}>
      <Field
        label={t("settings.projectSearch.directory", { number: index + 1 })}
        error={showPathError ? t("settings.projectSearch.invalidPath") : null}
        trailing={removeButton}
      >
        <FormTextInput
          initialValue={root.path}
          autoFocus={root.path.length === 0}
          placeholder="~/projects"
          onChangeText={change}
          editable={!disabled}
          autoCapitalize="none"
          autoCorrect={false}
          size={size}
          accessibilityLabel={t("settings.projectSearch.directory", { number: index + 1 })}
          testID={`project-search-root-${index}`}
        />
      </Field>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fieldRow: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  footer: {
    padding: theme.spacing[4],
    gap: theme.spacing[2],
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  status: {
    minHeight: theme.spacing[6],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));

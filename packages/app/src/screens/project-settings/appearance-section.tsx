import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProjectAppearance } from "@getpaseo/protocol/messages";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField } from "@/components/ui/select-field";
import { useToast } from "@/contexts/toast-context";
import { useProjectAppearanceForm } from "@/projects/appearance/use-form";
import { SettingsGroup } from "@/screens/settings/settings-group";
import { settingsStyles } from "@/styles/settings";
import { PROJECT_ICON_COLORS } from "@/styles/theme";

interface ProjectAppearanceSectionProps {
  projectId: string;
  serverId: string;
  appearance?: ProjectAppearance | null;
  client: DaemonClient;
  onColorPreview: (color: string | null) => void;
}

export function ProjectAppearanceSection({
  projectId,
  serverId,
  appearance,
  client,
  onColorPreview,
}: ProjectAppearanceSectionProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const toast = useToast();
  const form = useProjectAppearanceForm({
    appearance,
    labels: {
      automatic: t("settings.project.appearance.automatic"),
      favicon: t("settings.project.appearance.favicon"),
      custom: t("settings.project.appearance.custom"),
      urlRequired: t("settings.project.appearance.urlRequired"),
      customRequired: t("settings.project.appearance.customRequired"),
    },
  });
  const state = useSyncExternalStore(form.subscribe, form.getState, form.getState);
  const options = useMemo(
    () => [
      {
        id: "automatic",
        value: "automatic" as const,
        label: t("settings.project.appearance.automatic"),
      },
      {
        id: "favicon",
        value: "favicon" as const,
        label: t("settings.project.appearance.favicon"),
      },
      {
        id: "custom",
        value: "custom" as const,
        label: t("settings.project.appearance.custom"),
      },
    ],
    [t],
  );
  const mutation = useMutation({
    mutationFn: () => client.setProjectAppearance(projectId, state.input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projectIcon", serverId] });
      toast.show(t("settings.project.appearance.saved"), { variant: "success" });
    },
  });

  const save = useCallback(() => mutation.mutate(), [mutation]);
  const setColor = useCallback(
    (color: string) => {
      form.setColor(color);
      onColorPreview(color || null);
    },
    [form, onColorPreview],
  );

  return (
    <SettingsGroup title={t("settings.project.appearance.title")} testID="appearance-group">
      <View style={[settingsStyles.card, styles.card]}>
        <SelectField
          label={t("settings.project.appearance.icon")}
          value={state.mode}
          selectedDisplay={state.selectedDisplay}
          options={options}
          onChange={form.setMode}
          placeholder={t("settings.project.appearance.automatic")}
          emptyText=""
          searchable={false}
          size="sm"
          testID="project-icon-mode"
        />
        {state.showFaviconUrl ? (
          <Field label={t("settings.project.appearance.url")} error={state.valueError}>
            <FormTextInput
              value={state.faviconUrl}
              onChangeText={form.setFaviconUrl}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="https://example.com/favicon.ico"
              size="sm"
              testID="project-icon-url"
            />
          </Field>
        ) : null}
        {state.showCustomText ? (
          <Field label={t("settings.project.appearance.text")} error={state.valueError}>
            <FormTextInput
              value={state.customText}
              onChangeText={form.setCustomText}
              placeholder="🚀"
              size="sm"
              testID="project-icon-text"
            />
          </Field>
        ) : null}
        <ProjectColorPicker value={state.color} onChange={setColor} />
        {mutation.isError ? (
          <Alert
            variant="error"
            title={t("settings.project.appearance.saveFailed")}
            description={mutation.error.message || undefined}
          />
        ) : null}
        <Button
          variant="outline"
          size="sm"
          loading={mutation.isPending}
          disabled={!state.canSubmit}
          onPress={save}
          style={styles.save}
          testID="project-icon-save"
        >
          {t("settings.project.appearance.save")}
        </Button>
      </View>
    </SettingsGroup>
  );
}

function ProjectColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  const { t } = useTranslation();
  const setAutomatic = useCallback(() => onChange(""), [onChange]);
  const setTransparent = useCallback(() => onChange("transparent"), [onChange]);

  return (
    <Field label={t("settings.project.appearance.color")}>
      <View style={styles.colorPickerRow}>
        <Button variant={value ? "ghost" : "secondary"} size="xs" onPress={setAutomatic}>
          {t("settings.project.appearance.automatic")}
        </Button>
        <Button
          variant={value === "transparent" ? "secondary" : "ghost"}
          size="xs"
          onPress={setTransparent}
        >
          {t("settings.project.appearance.transparent")}
        </Button>
        {PROJECT_ICON_COLORS.map((color) => (
          <ProjectColorSwatch
            key={color}
            color={color}
            selected={value === color}
            onChange={onChange}
          />
        ))}
      </View>
    </Field>
  );
}

function ProjectColorSwatch({
  color,
  selected,
  onChange,
}: {
  color: string;
  selected: boolean;
  onChange: (color: string) => void;
}) {
  const select = useCallback(() => onChange(color), [color, onChange]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const swatchStyle = useMemo(
    () => [styles.colorSwatch, { backgroundColor: color }, selected && styles.colorSwatchSelected],
    [color, selected],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={color}
      accessibilityState={accessibilityState}
      onPress={select}
      style={styles.colorSwatchPressable}
    >
      <View style={swatchStyle} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  save: {
    alignSelf: "flex-end",
  },
  colorPickerRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  colorSwatchPressable: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
  },
  colorSwatch: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.full,
  },
  colorSwatchSelected: {
    borderWidth: 2,
    borderColor: theme.colors.foreground,
  },
}));

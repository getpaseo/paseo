import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsRow, SettingsSection, SettingsSelect } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { useInstalledPlugins } from "../registry";
import { sidebarViews } from "./catalog";
import { useSidebarViewSelection } from "./selection";

export function SidebarViewPicker() {
  const { t } = useTranslation();
  const views = sidebarViews(useInstalledPlugins());
  const { state, reload, setSelection, pending, error } = useSidebarViewSelection();
  let content;
  if (state.status === "loading") {
    content = (
      <SettingsRow label={t("settings.appearance.sidebar.view.label")}>
        <Text style={styles.message}>{t("common.loading")}</Text>
      </SettingsRow>
    );
  } else if (state.status === "error") {
    content = (
      <SettingsRow
        label={t("settings.appearance.sidebar.view.label")}
        hint={t("sidebar.view.readFailed")}
      >
        <Button onPress={reload}>{t("common.actions.retry")}</Button>
      </SettingsRow>
    );
  } else {
    const missing =
      state.selection !== "default" && !views.some((view) => view.id === state.selection);
    const value = missing ? "default" : state.selection;
    let hint: string | undefined;
    if (missing) hint = t("settings.appearance.sidebar.view.unavailable");
    if (error) hint = error.message;
    const options = [
      { value: "default", label: t("settings.appearance.sidebar.view.default") },
      ...views.map((view) => ({ value: view.id, label: view.title })),
    ];
    content = (
      <SettingsSelect
        label={t("settings.appearance.sidebar.view.label")}
        value={value}
        options={options}
        onValueChange={setSelection}
        disabled={pending}
        hint={hint}
      />
    );
  }
  return (
    <SettingsSection title={t("settings.appearance.sidebar.view.title")}>
      <SettingsCard>{content}</SettingsCard>
    </SettingsSection>
  );
}
const styles = StyleSheet.create((theme) => ({ message: { color: theme.colors.foregroundMuted } }));

import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSection, SettingsSwitch } from "@/components/settings";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";

export function WorkspacesSection() {
  const { t } = useTranslation();
  const sortMode = useSidebarViewStore((state) => state.sortMode);
  const groupMode = useSidebarViewStore((state) => state.groupMode);
  const projectSortMode = useSidebarViewStore((state) => state.projectSortMode);
  const workspaceRunningFirst = useSidebarViewStore((state) => state.workspaceActivityRunningFirst);
  const projectRunningFirst = useSidebarViewStore((state) => state.projectActivityRunningFirst);
  const setWorkspaceRunningFirst = useSidebarViewStore(
    (state) => state.setWorkspaceActivityRunningFirst,
  );
  const setProjectRunningFirst = useSidebarViewStore(
    (state) => state.setProjectActivityRunningFirst,
  );
  const hint = (mode: typeof sortMode, sortLabel: string) =>
    mode === "recent"
      ? t("settings.workspaces.runningFirstHint")
      : t("settings.workspaces.disabledHint", {
          sortLabel,
          sortMode: t(`sidebar.display.sorting.${mode}`),
        });
  return (
    <SettingsSection title={t("settings.workspaces.sorting")}>
      <SettingsCard>
        <SettingsSwitch
          label={t("settings.workspaces.workspaceRunningFirst")}
          hint={
            groupMode === "day"
              ? t("settings.workspaces.runningFirstHint")
              : hint(sortMode, t("sidebar.display.sorting.workspaces"))
          }
          value={workspaceRunningFirst}
          onValueChange={setWorkspaceRunningFirst}
          // Day groups always order by activity, so the running-first preference applies even
          // while the stored workspace sort mode is Manual or Name — it must stay settable.
          disabled={sortMode !== "recent" && groupMode !== "day"}
          testID="settings-workspaces-workspace-running"
        />
        <SettingsSwitch
          label={t("settings.workspaces.projectRunningFirst")}
          hint={
            groupMode === "project"
              ? hint(projectSortMode, t("sidebar.display.sorting.projects"))
              : t("settings.workspaces.projectGroupingHint")
          }
          value={projectRunningFirst}
          onValueChange={setProjectRunningFirst}
          disabled={projectSortMode !== "recent" || groupMode !== "project"}
          testID="settings-workspaces-project-running"
        />
      </SettingsCard>
    </SettingsSection>
  );
}

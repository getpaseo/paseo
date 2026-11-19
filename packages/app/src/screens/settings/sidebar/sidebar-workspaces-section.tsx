import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSection, SettingsSelect } from "@/components/settings";
import { useSidebarWorkspaceScope } from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";

const groupingModes = ["project", "status"] as const;
const sortModes = ["manual", "created", "lastPrompt"] as const;

export function SidebarWorkspacesSection() {
  const { t } = useTranslation();
  const grouping = useSidebarViewStore((state) => state.groupMode);
  const setGrouping = useSidebarViewStore((state) => state.setGroupMode);
  const workspaceSort = useSidebarViewStore((state) => state.workspaceSort);
  const setWorkspaceSort = useSidebarViewStore((state) => state.setWorkspaceSort);
  const { workspaceSortSupported } = useSidebarWorkspaceScope();
  const groupedByProject = grouping === "project";

  const sortHint = groupedByProject
    ? t("settings.appearance.sidebar.workspaces.manualHint")
    : t("settings.appearance.sidebar.workspaces.projectHint");
  const hint =
    groupedByProject && !workspaceSortSupported
      ? [sortHint, t("sidebar.display.sort.updateHost")].join("\n")
      : sortHint;

  return (
    <SettingsSection title={t("settings.appearance.sidebar.workspaces.title")}>
      <SettingsCard>
        <SettingsSelect
          label={t("sidebar.display.grouping.label")}
          value={grouping}
          options={groupingModes.map((value) => ({
            value,
            label: t(`sidebar.display.grouping.${value}`),
          }))}
          onValueChange={setGrouping}
        />
        <SettingsSelect
          label={t("settings.appearance.sidebar.workspaces.sortLabel")}
          hint={hint}
          disabled={!groupedByProject}
          value={workspaceSort}
          options={sortModes.map((value) => ({
            value,
            label: t(`sidebar.display.sort.${value}`),
            disabled: value !== "manual" && !workspaceSortSupported,
          }))}
          onValueChange={setWorkspaceSort}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

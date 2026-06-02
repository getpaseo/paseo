import { useCallback, useMemo } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { router } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { ProjectIconView } from "@/components/project-icon-view";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useProjects, type ProjectHostError } from "@/hooks/use-projects";
import { useProjectIconDataByProjectKey } from "@/projects/project-icons";
import { settingsStyles } from "@/styles/settings";
import { buildProjectSettingsRoute } from "@/utils/host-routes";
import type { ProjectSummary } from "@/utils/projects";

interface ProjectsScreenProps {
  view: { kind: "projects" } | { kind: "project"; projectKey: string };
}

export default function ProjectsScreen({ view }: ProjectsScreenProps) {
  const { t } = useTranslation();
  const { projects, hostErrors, isLoading } = useProjects();
  const selectedProjectKey = view.kind === "project" ? view.projectKey : null;
  const iconTargets = useMemo(
    () =>
      projects.flatMap((project) => {
        const host = project.hosts[0];
        if (!host) return [];
        return [
          {
            serverId: host.serverId,
            projectKey: project.projectKey,
            iconWorkingDir: host.repoRoot,
          },
        ];
      }),
    [projects],
  );
  const iconDataByProjectKey = useProjectIconDataByProjectKey({
    serverId: null,
    projects: iconTargets,
  });

  if (isLoading && projects.length === 0) {
    return (
      <View style={styles.centered} testID="projects-list">
        <LoadingSpinner size="large" color={styles.spinnerColor.color} />
      </View>
    );
  }

  if (projects.length === 0) {
    return (
      <View style={styles.centered} testID="projects-list">
        <Text style={styles.emptyText}>{t("sidebar.project.empty.title")}</Text>
      </View>
    );
  }

  return (
    <View testID="projects-list">
      {hostErrors.length > 0 ? <HostErrorsBanner errors={hostErrors} /> : null}
      <View style={settingsStyles.card}>
        {projects.map((project, index) => (
          <ProjectRow
            key={project.projectKey}
            project={project}
            isFirst={index === 0}
            isSelected={selectedProjectKey === project.projectKey}
            iconDataUri={iconDataByProjectKey.get(project.projectKey) ?? null}
          />
        ))}
      </View>
    </View>
  );
}

function HostErrorsBanner({ errors }: { errors: ProjectHostError[] }) {
  const { t } = useTranslation();
  return (
    <View style={styles.errorsBanner} testID="projects-host-errors">
      {errors.map((error) => (
        <Text key={error.serverId} style={styles.errorsBannerText}>
          {t("settings.projectList.hostLoadFailed", {
            hostName: error.serverName,
            message: error.message,
          })}
        </Text>
      ))}
    </View>
  );
}

interface ProjectRowProps {
  project: ProjectSummary;
  isFirst: boolean;
  isSelected: boolean;
  iconDataUri: string | null;
}

function ProjectRow({ project, isFirst, isSelected, iconDataUri }: ProjectRowProps) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const { projectKey, projectName } = project;

  const handleNavigate = useCallback(() => {
    router.navigate(buildProjectSettingsRoute(projectKey));
  }, [projectKey]);

  const rowStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      settingsStyles.row,
      !isFirst && settingsStyles.rowBorder,
      styles.row,
      isSelected && styles.rowSelected,
      hovered && !isSelected && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isFirst, isSelected],
  );

  return (
    <Pressable
      style={rowStyle}
      onPress={handleNavigate}
      accessibilityRole="button"
      accessibilityLabel={t("settings.projectList.editProject", { projectName })}
      testID={`project-row-${projectKey}`}
      data-selected={isSelected ? "true" : "false"}
    >
      <View style={styles.rowMain}>
        <View style={styles.leading}>
          <ProjectRowIcon
            iconDataUri={iconDataUri}
            projectName={projectName}
            projectKey={projectKey}
          />
        </View>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {projectName}
        </Text>
      </View>
      <ChevronRight size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
}

function ProjectRowIcon({
  iconDataUri,
  projectName,
  projectKey,
}: {
  iconDataUri: string | null;
  projectName: string;
  projectKey: string;
}) {
  const initial = projectName.trim().charAt(0).toUpperCase() || "?";
  return (
    <ProjectIconView
      iconDataUri={iconDataUri}
      initial={initial}
      projectKey={projectKey}
      imageStyle={styles.iconImage}
      fallbackStyle={styles.iconFallback}
      textStyle={styles.iconFallbackText}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorsBanner: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    marginBottom: theme.spacing[3],
    gap: theme.spacing[1],
  },
  errorsBannerText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
  row: {
    gap: theme.spacing[3],
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  rowSelected: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  leading: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  iconImage: {
    width: 16,
    height: 16,
    borderRadius: theme.borderRadius.sm,
  },
  iconFallback: {
    width: 16,
    height: 16,
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  iconFallbackText: {
    fontSize: theme.fontSize.xs,
  },
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
}));

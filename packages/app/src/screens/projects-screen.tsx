import { useCallback, useMemo } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { ProjectIconView } from "@/components/project-icon-view";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useProjects, type ProjectHostError } from "@/hooks/use-projects";
import { useProjectIcons } from "@/projects/icons";
import { settingsStyles } from "@/styles/settings";
import { openProjectSettings } from "@/navigation/settings-navigation";
import type { ProjectHostEntry, ProjectSummary } from "@/utils/projects";

interface ProjectsScreenProps {
  serverId: string;
}

interface HostProject {
  project: ProjectSummary;
  host: ProjectHostEntry;
}

export default function ProjectsScreen({ serverId }: ProjectsScreenProps) {
  const { t } = useTranslation();
  const { projects, hostErrors, isLoading } = useProjects();
  const hostProjects = useMemo<HostProject[]>(
    () =>
      projects.flatMap((project) =>
        project.hosts
          .filter((host) => host.serverId === serverId)
          .map((host) => ({ project, host })),
      ),
    [projects, serverId],
  );
  const scopedErrors = hostErrors.filter((error) => error.serverId === serverId);
  const iconTargets = useMemo(
    () =>
      hostProjects.map(({ project, host }) => ({
        serverId: host.serverId,
        projectViewKey: project.viewKey,
        projectId: host.projectId,
        iconWorkingDir: host.repoRoot,
        customIconRevision: host.customIconRevision,
      })),
    [hostProjects],
  );
  const iconDataByProjectViewKey = useProjectIcons({
    projects: iconTargets,
  });

  if (isLoading && hostProjects.length === 0) {
    return (
      <View style={styles.centered} testID="projects-list">
        <LoadingSpinner size="large" color={styles.spinnerColor.color} />
      </View>
    );
  }

  if (hostProjects.length === 0) {
    return (
      <View style={styles.centered} testID="projects-list">
        <Text style={styles.emptyText}>{t("sidebar.project.empty.title")}</Text>
      </View>
    );
  }

  return (
    <View testID="projects-list">
      {scopedErrors.length > 0 ? <HostErrorsBanner errors={scopedErrors} /> : null}
      <View style={settingsStyles.card}>
        {hostProjects.map(({ project, host }, index) => (
          <ProjectRow
            key={host.projectId}
            project={project}
            host={host}
            isFirst={index === 0}
            iconDataUri={iconDataByProjectViewKey.get(project.viewKey) ?? null}
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
  host: ProjectHostEntry;
  isFirst: boolean;
  iconDataUri: string | null;
}

function ProjectRow({ project, host, isFirst, iconDataUri }: ProjectRowProps) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const { viewKey } = project;
  const { projectName } = host;
  const handleNavigate = useCallback(() => {
    openProjectSettings(host.serverId, host.projectId);
  }, [host.projectId, host.serverId]);

  const rowStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      settingsStyles.row,
      !isFirst && settingsStyles.rowBorder,
      styles.row,
      hovered && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isFirst],
  );

  return (
    <Pressable
      style={rowStyle}
      onPress={handleNavigate}
      accessibilityRole="button"
      accessibilityLabel={t("settings.projectList.editProject", { projectName })}
      testID={`project-row-${viewKey}`}
    >
      <View style={styles.rowMain}>
        <View style={styles.leading}>
          <ProjectRowIcon
            iconDataUri={iconDataUri}
            projectName={projectName}
            projectViewKey={viewKey}
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
  projectViewKey,
}: {
  iconDataUri: string | null;
  projectName: string;
  projectViewKey: string;
}) {
  const initial = projectName.trim().charAt(0).toUpperCase() || "?";
  return (
    <ProjectIconView
      iconDataUri={iconDataUri}
      initial={initial}
      projectViewKey={projectViewKey}
      size={16}
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
    fontSize: theme.fontSize.base,
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
    fontSize: theme.fontSize.sm,
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
  leading: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  iconFallbackText: {
    fontSize: theme.fontSize.sm,
  },
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
}));

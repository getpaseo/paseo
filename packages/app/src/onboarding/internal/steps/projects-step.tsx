import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, FolderPlus } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import {
  FolderProjectIcon,
  ProjectSuggestionList,
  type ProjectSuggestionsController,
} from "@/project-suggestions";
import { useProjectRootPaths } from "@/stores/session-store-hooks";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedCheck = withUnistyles(Check);
const successMapping = (theme: Theme) => ({ color: theme.colors.palette.green[400] });

function basename(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? path;
}

/** Adding the checked suggestions is the setup's primary action; see the modal footer. */
export function ProjectsStep({
  serverId,
  suggestions,
}: {
  serverId: string;
  suggestions: ProjectSuggestionsController;
}) {
  const { t } = useTranslation();
  const openAddProject = useOpenAddProject();
  const projectRootPaths = useProjectRootPaths(serverId);
  const handleAddProject = useCallback(() => openAddProject(serverId), [openAddProject, serverId]);

  return (
    <View style={styles.container}>
      <View style={styles.actions}>
        <Button variant="outline" leftIcon={FolderPlus} onPress={handleAddProject}>
          {t("onboarding.setup.steps.projects.addProject")}
        </Button>
      </View>
      {projectRootPaths.length > 0 ? (
        <View style={settingsStyles.card}>
          {projectRootPaths.map((rootPath, index) => (
            <View
              key={rootPath}
              style={[settingsStyles.row, index > 0 && settingsStyles.rowBorder]}
            >
              <View style={settingsStyles.rowContent}>
                <View style={styles.titleLine}>
                  <FolderProjectIcon
                    serverId={serverId}
                    rootPath={rootPath}
                    name={basename(rootPath)}
                  />
                  <Text style={[settingsStyles.rowTitle, styles.title]} numberOfLines={1}>
                    {basename(rootPath)}
                  </Text>
                </View>
                <Text style={[settingsStyles.rowHint, styles.underTitle]} numberOfLines={1}>
                  {rootPath}
                </Text>
              </View>
              <View style={styles.addedBadge}>
                <ThemedCheck size={14} uniProps={successMapping} />
                <Text style={styles.addedLabel}>{t("onboarding.setup.steps.projects.added")}</Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}
      <ProjectSuggestionList serverId={serverId} suggestions={suggestions} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[4],
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  titleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    flexShrink: 1,
  },
  underTitle: {
    marginLeft: ICON_SIZE.md + theme.spacing[2],
  },
  addedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  addedLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));

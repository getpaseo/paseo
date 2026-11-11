import { StyleSheet } from "react-native-unistyles";
import { ProjectIconView } from "@/components/project-icon-view";
import { projectIconDataUri, useProjectIcon } from "@/projects/icons";
import { ICON_SIZE } from "@/styles/theme";

// The initial sits in a 16px square, below the smallest font-size token.
const INITIAL_FONT_SIZE = 10;

/**
 * The icon of a folder that may not be a project yet: the icon the host discovers in it, or a
 * colored initial. Keyed on the folder, so a suggestion keeps its color once it is added here.
 */
export function FolderProjectIcon({
  serverId,
  rootPath,
  name,
}: {
  serverId: string;
  rootPath: string;
  name: string;
}) {
  const { icon } = useProjectIcon({ serverId, cwd: rootPath });
  return (
    <ProjectIconView
      iconDataUri={projectIconDataUri(icon)}
      initial={name.trim().charAt(0).toUpperCase() || "?"}
      projectViewKey={rootPath}
      size={ICON_SIZE.md}
      textStyle={styles.initial}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  initial: {
    fontSize: INITIAL_FONT_SIZE,
    fontWeight: theme.fontWeight.semibold,
  },
}));

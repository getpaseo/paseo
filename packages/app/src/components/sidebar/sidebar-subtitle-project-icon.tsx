import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ProjectIconView } from "@/components/project-icon-view";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";

/**
 * Decorative project marker for a sidebar row's subtitle line. Status mode breaks
 * the project grouping, so the icon is what makes two same-named branches from
 * different projects tell apart at a glance — the project name next to it carries
 * the meaning, so the icon itself stays out of the accessibility tree.
 */
export function SidebarSubtitleProjectIcon({
  projectViewKey,
  projectName,
  iconDataUri,
  testID,
}: {
  projectViewKey: string;
  projectName: string;
  iconDataUri: string | null;
  testID?: string;
}) {
  const placeholderInitial = projectIconPlaceholderLabelFromDisplayName(projectName)
    .charAt(0)
    .toUpperCase();
  if (!iconDataUri && !placeholderInitial) {
    return null;
  }

  return (
    <View
      style={styles.slot}
      testID={testID}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <ProjectIconView
        iconDataUri={iconDataUri}
        initial={placeholderInitial}
        projectViewKey={projectViewKey}
        imageStyle={styles.icon}
        fallbackStyle={styles.fallback}
        textStyle={styles.fallbackText}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  slot: {
    width: 12,
    // Match the 14px subtitle line so the icon does not change row density.
    height: 14,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  icon: {
    width: 12,
    height: 12,
    borderRadius: theme.borderRadius.sm,
  },
  fallback: {
    width: 12,
    height: 12,
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  fallbackText: {
    fontSize: 8,
    lineHeight: 12,
  },
}));

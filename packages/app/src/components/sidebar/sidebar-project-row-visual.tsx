import React, { memo, useMemo, type ReactElement } from "react";
import { Image, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";

export interface SidebarProjectRowVisualProps {
  projectName: string;
  iconDataUri: string | null;
  leadingVisual?: ReactElement | null;
}

export const SidebarProjectRowVisual = memo(function SidebarProjectRowVisual({
  projectName,
  iconDataUri,
  leadingVisual = null,
}: SidebarProjectRowVisualProps): ReactElement {
  return (
    <View style={styles.projectRowLeft}>
      {leadingVisual ?? <SidebarProjectIcon projectName={projectName} iconDataUri={iconDataUri} />}
      <SidebarProjectName projectName={projectName} />
    </View>
  );
});

export const SidebarProjectIcon = memo(function SidebarProjectIcon({
  projectName,
  iconDataUri,
}: {
  projectName: string;
  iconDataUri: string | null;
}): ReactElement {
  const placeholderLabel = projectIconPlaceholderLabelFromDisplayName(projectName);
  const placeholderInitial = placeholderLabel.charAt(0).toUpperCase();
  const imageSource = useMemo(() => ({ uri: iconDataUri ?? "" }), [iconDataUri]);

  return (
    <View style={styles.projectLeadingVisualSlot}>
      {iconDataUri ? (
        <Image source={imageSource} style={styles.projectIcon} />
      ) : (
        <View style={styles.projectIconFallback}>
          <Text style={styles.projectIconFallbackText}>{placeholderInitial}</Text>
        </View>
      )}
    </View>
  );
});

const SidebarProjectName = memo(function SidebarProjectName({
  projectName,
}: {
  projectName: string;
}): ReactElement {
  return (
    <View style={styles.projectTitleGroup}>
      <Text style={styles.projectTitle} numberOfLines={1}>
        {projectName}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  projectRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  projectLeadingVisualSlot: {
    position: "relative",
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  projectIcon: {
    width: "100%",
    height: "100%",
    borderRadius: theme.borderRadius.sm,
  },
  projectIconFallback: {
    width: "100%",
    height: "100%",
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  projectIconFallbackText: {
    color: theme.colors.foregroundMuted,
    fontSize: 9,
  },
  projectTitleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
  },
  projectTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "400",
    minWidth: 0,
    flexShrink: 1,
  },
}));

import { useCallback, useState, type ReactElement, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export interface ComposerTrackRowProps {
  /** `link` for a row that leaves the agent, `button` for one that acts in place. */
  accessibilityRole: "button" | "link";
  accessibilityLabel: string;
  testID: string;
  onPress: () => void;
  renderLeading?: () => ReactNode;
  label: string;
  /** Muted trailing context — a provider note, a cadence. */
  secondary?: string;
  actions?: () => ReactNode;
}

interface ComposerTrackRowLayoutProps extends ComposerTrackRowProps {
  isHovered: boolean;
  showActions: boolean;
}

/**
 * One row in a track. The row control and its actions are siblings so an
 * action never activates the row's navigation.
 */
export function ComposerTrackRowLayout({
  accessibilityRole,
  accessibilityLabel,
  testID,
  onPress,
  renderLeading,
  label,
  secondary,
  actions,
  isHovered,
  showActions,
}: ComposerTrackRowLayoutProps): ReactElement {
  const [pressed, setPressed] = useState(false);
  const handlePressIn = useCallback(() => setPressed(true), []);
  const handlePressOut = useCallback(() => setPressed(false), []);

  return (
    <View style={isHovered || pressed ? styles.rowActive : styles.row}>
      <Pressable
        accessibilityRole={accessibilityRole}
        accessibilityLabel={accessibilityLabel}
        testID={testID}
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={styles.rowMain}
      >
        {renderLeading?.()}
        <Text style={styles.rowLabel} numberOfLines={1}>
          {label}
        </Text>
        {secondary ? (
          <Text style={styles.rowSecondary} numberOfLines={1}>
            {secondary}
          </Text>
        ) : null}
      </Pressable>
      {actions ? (
        <View
          style={showActions ? styles.actionClusterVisible : styles.actionClusterHidden}
          pointerEvents={showActions ? "auto" : "none"}
        >
          {actions()}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  rowActive: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  rowLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  // Keep secondary context bounded so the row's own name stays readable on
  // compact screens.
  rowSecondary: {
    flexShrink: 1,
    minWidth: 0,
    maxWidth: "45%",
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  actionClusterVisible: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    opacity: 1,
  },
  actionClusterHidden: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    opacity: 0,
  },
}));

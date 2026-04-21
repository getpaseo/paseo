import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { LucideIcon } from "lucide-react-native";
import { HEADER_INNER_HEIGHT, HEADER_INNER_HEIGHT_MOBILE } from "@/constants/layout";

interface SidebarHeaderRowProps {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  isActive?: boolean;
  testID?: string;
  nativeID?: string;
  accessibilityLabel?: string;
}

/**
 * Top-of-sidebar header row: a sidebar-height pressable with an icon + label
 * and a full-width border separator beneath. Used as the first element of a
 * sidebar (workspace "Sessions", settings "Back to workspace"). Owns its own
 * separator line so both sidebars converge on the same edge and padding.
 */
export function SidebarHeaderRow({
  icon: Icon,
  label,
  onPress,
  isActive = false,
  testID,
  nativeID,
  accessibilityLabel,
}: SidebarHeaderRowProps) {
  const { theme } = useUnistyles();

  return (
    <View style={styles.container}>
      <Pressable
        onPress={onPress}
        testID={testID}
        nativeID={nativeID}
        accessible
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        style={({ hovered }) => [styles.button, (hovered || isActive) && styles.buttonHovered]}
      >
        {({ hovered }) => {
          const isHighlighted = hovered || isActive;
          const iconColor = isHighlighted ? theme.colors.foreground : theme.colors.foregroundMuted;
          return (
            <>
              <Icon size={theme.iconSize.md} color={iconColor} />
              <Text style={[styles.label, isHighlighted && styles.labelHighlighted]}>{label}</Text>
            </>
          );
        }}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    height: {
      xs: HEADER_INNER_HEIGHT_MOBILE,
      md: HEADER_INNER_HEIGHT,
    },
    paddingHorizontal: theme.spacing[2],
    justifyContent: "center",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    userSelect: "none",
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  buttonHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  label: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  labelHighlighted: {
    color: theme.colors.foreground,
  },
}));

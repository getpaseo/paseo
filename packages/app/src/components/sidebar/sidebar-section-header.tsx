import { useMemo } from "react";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { Pressable, Text } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { DensityIcon } from "@/components/ui/density-icon";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import { density, densityFontSize } from "@/styles/density";
import type { Theme } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

/**
 * A muted section title that collapses the rows under it. The chevron shows on hover
 * where hover exists and always where it does not, so touch users still see the toggle.
 */
interface SidebarSectionHeaderProps {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  testID: string;
  densityAware?: boolean;
}

export function SidebarSectionHeader({
  title,
  collapsed,
  onToggle,
  testID,
  densityAware = false,
}: SidebarSectionHeaderProps) {
  const isCompact = useIsCompactFormFactor();
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  // react-native-web does not carry `accessibilityState.expanded` through to the DOM,
  // so the attribute a screen reader and the e2e suite read is set here.
  const ariaExpandedProps = isWeb ? ({ "aria-expanded": !collapsed } as const) : null;
  const Chevron = collapsed ? ThemedChevronRight : ThemedChevronDown;
  const chevron = densityAware ? (
    <DensityIcon icon={collapsed ? ChevronRight : ChevronDown} size="xs" color="foregroundMuted" />
  ) : (
    <Chevron size={12} uniProps={foregroundMutedColorMapping} />
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      {...ariaExpandedProps}
      onPress={onToggle}
      style={[styles.header, densityAware ? styles.densityHeader : null]}
      testID={testID}
    >
      {({ hovered }) => (
        <>
          <Text style={[styles.title, densityAware ? styles.densityTitle : null]}>{title}</Text>
          {hovered || isNative || isCompact ? chevron : null}
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    userSelect: "none",
  },
  densityHeader: {
    minHeight: density.rowHeight,
  },
  title: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  densityTitle: {
    fontSize: densityFontSize(theme, "sm"),
  },
}));

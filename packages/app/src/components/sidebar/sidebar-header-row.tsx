import {
  useCallback,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
  type Ref,
} from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HEADER_INNER_HEIGHT, HEADER_INNER_HEIGHT_MOBILE } from "@/constants/layout";
import { ICON_SIZE } from "@/styles/theme";
import type { Theme } from "@/styles/theme";
import { Shortcut } from "@/components/ui/shortcut";
import type { ShortcutKey } from "@/utils/format-shortcut";

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type SidebarHeaderRowVariant = "header" | "compact" | "inline";

export type SidebarRowIcon = ComponentType<{ size: number; color: string }>;

interface SidebarHeaderRowProps {
  icon: SidebarRowIcon | null;
  label: string;
  onPress: () => void;
  isActive?: boolean;
  testID?: string;
  nativeID?: string;
  accessibilityLabel?: string;
  /**
   * "header" (default): a sidebar-height row with its own bottom separator —
   * the lone header at the top of a sidebar (settings "Back to workspace").
   * "compact": a row with no separator, for entries that
   * sit in a header group whose wrapper owns the single divider.
   * "inline": a full-width row with no inset, for a row inside a padded container such as the
   * sidebar footer.
   */
  variant?: SidebarHeaderRowVariant;
  /** Shown in the right slot while the row is hovered, when `trailing` is not set. */
  shortcutKeys?: ShortcutKey[][] | null;
  /**
   * The right slot. A sibling of the row's button, never inside it (web cannot nest buttons). A
   * press on the slot presses the row; a button inside it presses on its own.
   */
  trailing?: ReactNode;
  rowRef?: Ref<View>;
  /** Trailing count. Zero, null and undefined render nothing. */
  badge?: number | null;
}

function resolveSidebarTrailing(input: {
  trailing?: ReactNode;
  badge: number | null;
  shortcutKeys: ShortcutKey[][] | null;
  isHovered: boolean;
}): ReactNode {
  const { trailing, badge, shortcutKeys, isHovered } = input;
  if (trailing !== undefined && trailing !== null) return trailing;
  if (!badge && !(shortcutKeys && isHovered)) return null;
  return (
    <>
      {badge ? <Text style={styles.badge}>{badge > 99 ? "99+" : badge}</Text> : null}
      {shortcutKeys && isHovered ? <Shortcut chord={shortcutKeys} /> : null}
    </>
  );
}

export function SidebarHeaderRow({
  icon: Icon,
  label,
  onPress,
  isActive = false,
  testID,
  nativeID,
  accessibilityLabel,
  variant = "header",
  shortcutKeys = null,
  trailing,
  rowRef,
  badge = null,
}: SidebarHeaderRowProps) {
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const ThemedIcon = useMemo(() => (Icon ? withUnistyles(Icon) : null), [Icon]);
  const isHighlighted = isHovered || isActive;
  const iconSize = variant === "header" ? ICON_SIZE.md : ICON_SIZE.sm;

  const right = resolveSidebarTrailing({ trailing, badge, shortcutKeys, isHovered });

  return (
    <View ref={rowRef} collapsable={false} style={getContainerStyle(variant)}>
      <View
        style={[styles.row, isHighlighted && styles.rowHighlighted]}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        <Pressable
          onPress={onPress}
          testID={testID}
          nativeID={nativeID}
          accessible
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel ?? label}
          accessibilityState={isActive ? SELECTED_STATE : undefined}
          aria-selected={isActive}
          style={styles.button}
        >
          {ThemedIcon ? (
            <ThemedIcon
              size={iconSize}
              uniProps={isHighlighted ? foregroundColorMapping : foregroundMutedColorMapping}
            />
          ) : (
            <View style={variant === "header" ? styles.iconSpacer : styles.iconSpacerCompact} />
          )}
          <Text style={[styles.label, isHighlighted && styles.labelHighlighted]}>{label}</Text>
        </Pressable>
        {right === null ? null : (
          <Pressable onPress={onPress} accessible={false} focusable={false} style={styles.trailing}>
            {right}
          </Pressable>
        )}
      </View>
    </View>
  );
}

const SELECTED_STATE = { selected: true } as const;

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
  containerCompact: {
    paddingHorizontal: theme.spacing[2],
    justifyContent: "center",
    userSelect: "none",
  },
  containerInline: {
    width: "100%",
    justifyContent: "center",
    userSelect: "none",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    // Same row geometry as the settings sidebar items. Shorter than the header
    // strip so the hover highlight clears the strip's bottom separator.
    minHeight: 28,
    borderRadius: theme.borderRadius.lg,
  },
  rowHighlighted: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  button: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 28,
    paddingVertical: theme.spacing[1],
    // Match the project rows' inner padding so the icons align on one vertical
    // edge with the list below.
    paddingHorizontal: theme.spacing[2],
  },
  iconSpacer: { width: ICON_SIZE.md, height: ICON_SIZE.md },
  iconSpacerCompact: { width: ICON_SIZE.sm, height: ICON_SIZE.sm },
  label: {
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  labelHighlighted: {
    color: theme.colors.foreground,
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingRight: theme.spacing[2],
  },
  badge: {
    marginLeft: "auto",
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
}));

function getContainerStyle(variant: SidebarHeaderRowVariant) {
  switch (variant) {
    case "header":
      return styles.container;
    case "compact":
      return styles.containerCompact;
    case "inline":
      return styles.containerInline;
  }
}

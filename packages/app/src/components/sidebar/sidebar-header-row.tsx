import { useCallback, useMemo } from "react";
import {
  Pressable,
  Text,
  View,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { LucideIcon } from "lucide-react-native";
import { HEADER_INNER_HEIGHT, HEADER_INNER_HEIGHT_MOBILE } from "@/constants/layout";
import { ICON_SIZE } from "@/styles/theme";
import type { Theme } from "@/styles/theme";
import { Shortcut } from "@/components/ui/shortcut";
import type { ShortcutKey } from "@/utils/format-shortcut";

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type SidebarHeaderRowVariant = "header" | "compact";

interface SidebarHeaderRowAction {
  icon: LucideIcon;
  onPress: () => void;
  accessibilityLabel: string;
  testID?: string;
}

interface SidebarHeaderRowProps {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  isActive?: boolean;
  testID?: string;
  nativeID?: string;
  accessibilityLabel?: string;
  /**
   * "header" (default): a sidebar-height row with its own bottom separator —
   * the lone header at the top of a sidebar (settings "Back to workspace").
   * "compact": a workspace-row-height row with no separator, for entries that
   * sit in a header group whose wrapper owns the single divider.
   */
  variant?: SidebarHeaderRowVariant;
  shortcutKeys?: ShortcutKey[][] | null;
  trailingAction?: SidebarHeaderRowAction | null;
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
  trailingAction = null,
}: SidebarHeaderRowProps) {
  const ThemedIcon = useMemo(() => withUnistyles(Icon), [Icon]);
  const ThemedTrailingIcon = useMemo(
    () => (trailingAction ? withUnistyles(trailingAction.icon) : null),
    [trailingAction],
  );

  const containerStyle = useMemo(
    () => (variant === "compact" ? styles.containerCompact : styles.container),
    [variant],
  );

  const buttonStyle = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.button,
      variant === "compact" && styles.buttonCompact,
      trailingAction ? styles.buttonWithTrailingAction : null,
      (Boolean(hovered) || isActive) && styles.buttonHovered,
    ],
    [isActive, trailingAction, variant],
  );

  const handleTrailingPress = useCallback(
    (event: GestureResponderEvent) => {
      // Trailing action is a sibling of the row press target, but still stop
      // propagation so nested gesture handlers never treat this as a row press.
      event.stopPropagation();
      trailingAction?.onPress();
    },
    [trailingAction],
  );

  const renderChildren = useCallback(
    (state: PressableStateCallbackType & { hovered?: boolean }) => {
      const isHighlighted = Boolean(state.hovered) || isActive;
      return (
        <>
          <ThemedIcon
            size={ICON_SIZE.sm}
            uniProps={isHighlighted ? foregroundColorMapping : foregroundMutedColorMapping}
          />
          <SidebarHeaderRowLabel label={label} isHighlighted={isHighlighted} />
          {shortcutKeys && Boolean(state.hovered) && !trailingAction ? (
            <Shortcut chord={shortcutKeys} style={styles.shortcut} />
          ) : null}
        </>
      );
    },
    [ThemedIcon, isActive, label, shortcutKeys, trailingAction],
  );

  return (
    <View style={containerStyle}>
      <View style={styles.row}>
        <Pressable
          onPress={onPress}
          testID={testID}
          nativeID={nativeID}
          accessible
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel ?? label}
          style={buttonStyle}
        >
          {renderChildren}
        </Pressable>
        {trailingAction && ThemedTrailingIcon ? (
          <Pressable
            onPress={handleTrailingPress}
            accessibilityRole="button"
            accessibilityLabel={trailingAction.accessibilityLabel}
            testID={trailingAction.testID}
            hitSlop={8}
            style={styles.trailingAction}
          >
            {({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => (
              <ThemedTrailingIcon
                size={ICON_SIZE.sm}
                uniProps={
                  Boolean(hovered) || isActive
                    ? foregroundColorMapping
                    : foregroundMutedColorMapping
                }
              />
            )}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function SidebarHeaderRowLabel({
  label,
  isHighlighted,
}: {
  label: string;
  isHighlighted: boolean;
}) {
  const labelStyle = useMemo(
    () => [styles.label, isHighlighted && styles.labelHighlighted],
    [isHighlighted],
  );
  return <Text style={labelStyle}>{label}</Text>;
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
  containerCompact: {
    paddingHorizontal: theme.spacing[2],
    justifyContent: "center",
    userSelect: "none",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    // Match the sidebar workspace-row shape (height, padding, radius) so the
    // compact header entries sit tight against the workspace list below.
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    flex: 1,
    minWidth: 0,
  },
  buttonWithTrailingAction: {
    // Keep room for the trailing action without shifting the label under it.
    paddingRight: theme.spacing[1],
  },
  // Compact header entries (New workspace / History) sit tighter than the
  // workspace-row shape the base button mirrors.
  buttonCompact: {
    minHeight: 32,
    paddingVertical: theme.spacing[1.5],
    // Match the project rows' inner padding so the icons align on one vertical
    // edge with the workspace list below (base button uses a wider spacing[3]).
    paddingHorizontal: theme.spacing[2],
  },
  buttonHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  label: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  labelHighlighted: {
    color: theme.colors.foreground,
  },
  shortcut: {
    marginLeft: "auto",
  },
  trailingAction: {
    minWidth: 28,
    minHeight: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
}));

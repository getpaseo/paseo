import { useMemo, type ReactNode } from "react";
import {
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import type { ShortcutKey } from "@/utils/format-shortcut";

/** Shared chrome at the boundary between a workspace pane's tabs and content. */
export function PaneContentToolbar({
  children,
  style,
  testID,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <View style={[styles.toolbar, style]} testID={testID}>
      {children}
    </View>
  );
}

/** A consistently spaced group of controls within any workspace toolbar or tab track. */
export function ToolbarControls({
  children,
  style,
  ...props
}: ViewProps & { children: ReactNode }) {
  return (
    <View {...props} style={[styles.controls, style]}>
      {children}
    </View>
  );
}

interface ToolbarButtonCommonProps extends Omit<
  PressableProps,
  "accessibilityLabel" | "accessibilityRole" | "children" | "style"
> {
  children: ReactNode;
  label: string;
  selected?: boolean;
  compact?: boolean;
  shortcut?: ShortcutKey[][] | null;
  tooltipSide?: "left" | "right" | "top" | "bottom";
  style?: StyleProp<ViewStyle>;
}

type ToolbarButtonProps = ToolbarButtonCommonProps &
  (
    | { kind?: "action"; onPress: NonNullable<PressableProps["onPress"]> }
    | { kind: "menu"; onPress?: never }
  );

/**
 * The icon action used by pane toolbars and tab tracks. It owns the hitbox,
 * interaction states, tooltip, and action/menu trigger composition.
 */
export function ToolbarButton({
  children,
  label,
  selected = false,
  compact = false,
  shortcut,
  tooltipSide = "bottom",
  style,
  kind = "action",
  onPress,
  disabled,
  testID,
  ...props
}: ToolbarButtonProps) {
  const buttonStyle = useMemo(
    () => (state: { hovered?: boolean; pressed: boolean; open?: boolean }) => [
      compact ? styles.buttonCompact : styles.button,
      style,
      (selected || Boolean(state.hovered) || state.pressed || Boolean(state.open)) &&
        styles.buttonActive,
      disabled && styles.buttonDisabled,
    ],
    [compact, disabled, selected, style],
  );
  const accessibilityState = useMemo(
    () => ({ disabled: Boolean(disabled), selected }),
    [disabled, selected],
  );
  const tooltip = (
    <TooltipContent side={tooltipSide} align="center" offset={8}>
      <View style={styles.tooltipRow}>
        <Text style={styles.tooltipText}>{label}</Text>
        {shortcut ? <Shortcut chord={shortcut} /> : null}
      </View>
    </TooltipContent>
  );

  if (kind === "menu") {
    return (
      <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild triggerRefProp="triggerRef">
          <DropdownMenuTrigger
            {...props}
            disabled={disabled}
            testID={testID}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={accessibilityState}
            style={buttonStyle}
          >
            {children}
          </DropdownMenuTrigger>
        </TooltipTrigger>
        {tooltip}
      </Tooltip>
    );
  }

  return (
    <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        {...props}
        disabled={disabled}
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={accessibilityState}
        onPress={onPress}
        style={buttonStyle}
      >
        {children}
      </TooltipTrigger>
      {tooltip}
    </Tooltip>
  );
}

export function paneContentToolbarIconSize(isCompact: boolean): number {
  return isCompact ? 18 : 14;
}

/** @deprecated Use `ToolbarButton`; retained while remaining pane toolbars migrate. */
export function paneContentToolbarIconButtonStyle(
  { hovered, pressed }: { hovered?: boolean; pressed: boolean },
  selected = false,
  isCompact = false,
) {
  return [
    isCompact ? styles.buttonCompact : styles.button,
    (selected || Boolean(hovered) || pressed) && styles.buttonActive,
  ];
}

const styles = StyleSheet.create((theme) => ({
  toolbar: {
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    backgroundColor: theme.colors.surface0,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    flexShrink: 0,
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 1,
  },
  button: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
    flexShrink: 0,
    outlineWidth: 0,
    outlineColor: "transparent",
  },
  buttonCompact: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
    flexShrink: 0,
    outlineWidth: 0,
    outlineColor: "transparent",
  },
  buttonActive: {
    backgroundColor: theme.colors.surface2,
  },
  buttonDisabled: {
    opacity: theme.opacity[50],
  },
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
}));

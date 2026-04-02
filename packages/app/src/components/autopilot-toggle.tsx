import { Pressable, Platform } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ShieldCheck } from "lucide-react-native";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Text } from "react-native";

interface AutopilotToggleProps {
  /** Whether autopilot is currently active (most permissive mode). */
  isActive: boolean;
  onToggle: () => void;
  disabled?: boolean;
  /** Provider ID used to label the tooltip. */
  provider?: string;
}

/**
 * Autopilot toggle — mirrors the VSCode Copilot shield icon.
 *
 * - Active (blue shield): agent executes all tool calls autonomously without prompting.
 * - Inactive (muted shield): agent uses the provider default safe mode.
 */
export function AutopilotToggle({ isActive, onToggle, disabled = false }: AutopilotToggleProps) {
  const { theme } = useUnistyles();

  const activeColor = theme.colors.palette.blue[500];
  const inactiveColor = theme.colors.foregroundMuted;
  const iconColor = isActive ? activeColor : inactiveColor;

  const tooltipLabel = isActive
    ? "Autopilot: ON — all tools run automatically without prompting"
    : "Autopilot: OFF — tools require approval before running";

  const button = (
    <Pressable
      disabled={disabled}
      onPress={onToggle}
      style={({ pressed, hovered }) => [
        styles.button,
        hovered && !disabled && styles.buttonHovered,
        pressed && !disabled && styles.buttonPressed,
        isActive && styles.buttonActive,
        disabled && styles.buttonDisabled,
      ]}
      accessibilityRole="button"
      accessibilityLabel={tooltipLabel}
      accessibilityState={{ checked: isActive }}
      // eslint-disable-next-line react-native/no-inline-styles
      aria-checked={isActive}
      testID="autopilot-toggle"
    >
      <ShieldCheck size={16} color={iconColor} />
    </Pressable>
  );

  if (Platform.OS !== "web") {
    return button;
  }

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltipLabel}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  button: {
    height: 28,
    width: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius["2xl"],
    backgroundColor: "transparent",
  },
  buttonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  buttonPressed: {
    backgroundColor: theme.colors.surface0,
  },
  buttonActive: {
    // subtle blue tint behind the icon when active, matching VSCode style
    backgroundColor: `${theme.colors.palette.blue[500]}1a`,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  tooltipText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
}));

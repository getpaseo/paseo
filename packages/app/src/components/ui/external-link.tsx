import { useCallback, type ReactNode } from "react";
import { Pressable, Text } from "react-native";
import { ArrowUpRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";

export interface ExternalLinkProps {
  href: string;
  label?: string;
  children?: ReactNode;
  onError?: (error: unknown) => void;
  tooltip?: ReactNode;
  testID?: string;
  accessibilityLabel?: string;
}

/**
 * Inline "Docs ↗" affordance — muted text + arrow-top-right icon, opens the
 * URL via the platform's external opener. Wrap in a Tooltip when there's a
 * one-line hint worth surfacing on hover/tap.
 */
export function ExternalLink({
  href,
  label,
  children,
  onError,
  tooltip,
  testID,
  accessibilityLabel,
}: ExternalLinkProps) {
  const handlePress = useCallback(() => {
    void openExternalUrl(href).catch(onError ?? console.error);
  }, [href, onError]);

  const trigger = (
    <Pressable
      onPress={handlePress}
      hitSlop={8}
      accessibilityRole="link"
      accessibilityLabel={accessibilityLabel ?? label}
      testID={testID}
      style={styles.trigger}
    >
      <Text style={styles.label}>{children ?? label}</Text>
      <ThemedArrowUpRight size={12} uniProps={iconColor} />
    </Pressable>
  );

  if (!tooltip) {
    return trigger;
  }

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="top" align="end" offset={6}>
        <Text style={styles.tooltipText}>{tooltip}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const iconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedArrowUpRight = withUnistyles(ArrowUpRight);

const styles = StyleSheet.create((theme) => ({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    maxWidth: 280,
    lineHeight: theme.fontSize.base * 1.4,
  },
}));

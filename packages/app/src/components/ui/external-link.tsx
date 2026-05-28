import { useCallback, type ReactNode } from "react";
import { Pressable, Text } from "react-native";
import { ArrowUpRight } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { openExternalUrl } from "@/utils/open-external-url";

interface ExternalLinkProps {
  href: string;
  label: string;
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
  tooltip,
  testID,
  accessibilityLabel,
}: ExternalLinkProps) {
  const { theme } = useUnistyles();
  const handlePress = useCallback(() => {
    void openExternalUrl(href);
  }, [href]);

  const trigger = (
    <Pressable
      onPress={handlePress}
      hitSlop={8}
      accessibilityRole="link"
      accessibilityLabel={accessibilityLabel ?? label}
      testID={testID}
      style={styles.trigger}
    >
      <Text style={styles.label}>{label}</Text>
      <ArrowUpRight size={12} color={theme.colors.foregroundMuted} />
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

const styles = StyleSheet.create((theme) => ({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    maxWidth: 280,
    lineHeight: theme.fontSize.sm * 1.4,
  },
}));

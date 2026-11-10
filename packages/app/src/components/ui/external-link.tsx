import { useCallback, type ReactNode } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
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
 * one-line hint worth surfacing on hover. A native tap opens the URL.
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
    >
      {({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => (
        <ExternalLinkLabel hovered={hovered}>{children ?? label}</ExternalLinkLabel>
      )}
    </Pressable>
  );

  if (!tooltip) {
    return trigger;
  }

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="top" align="end" offset={6}>
        <Text style={styles.tooltipText}>{tooltip}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * What an external link looks like: muted text and an outward arrow, both turning foreground on
 * hover. For a pressable that owns its own hover, such as a settings row that opens a page.
 */
export function ExternalLinkLabel({
  hovered = false,
  children,
}: {
  hovered?: boolean;
  children?: ReactNode;
}) {
  return (
    <View style={styles.trigger}>
      {children ? <Text style={[styles.label, hovered && styles.hovered]}>{children}</Text> : null}
      <ThemedArrowUpRight size={12} uniProps={hovered ? hoveredIconColor : iconColor} />
    </View>
  );
}

const iconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const hoveredIconColor = (theme: Theme) => ({ color: theme.colors.foreground });
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
  hovered: {
    color: theme.colors.foreground,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    maxWidth: 280,
    lineHeight: theme.fontSize.base * 1.4,
  },
}));

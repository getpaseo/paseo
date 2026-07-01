import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ProviderUsageCard } from "./card";
import { providerUsageCopy } from "./copy";
import type { ProviderUsage, ProviderUsageView } from "./types";

function matchProvider(
  providers: ProviderUsage[],
  activeProviderId: string | null | undefined,
): ProviderUsage | null {
  if (!activeProviderId) return null;
  const target = activeProviderId.toLowerCase();
  return providers.find((usage) => usage.providerId.toLowerCase() === target) ?? null;
}

// Renders the active agent's provider usage inside the context-meter tooltip.
// Returns nothing when the active provider has no usage entry, so the meter's
// own context section stays the whole tooltip.
export function ProviderUsageTooltipSection({
  view,
  activeProviderId,
}: {
  view: ProviderUsageView;
  activeProviderId: string | null | undefined;
}) {
  if (view.kind === "loading") {
    return (
      <>
        <View style={styles.divider} />
        <Text style={styles.detail}>{providerUsageCopy.tooltipLoading}</Text>
      </>
    );
  }

  if (view.kind === "error") {
    return (
      <>
        <View style={styles.divider} />
        <Text style={styles.error}>{view.message}</Text>
      </>
    );
  }

  const usage = matchProvider(view.payload.providers, activeProviderId);
  if (!usage) return null;

  return (
    <>
      <View style={styles.divider} />
      <ProviderUsageCard usage={usage} compact />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  divider: {
    height: 1,
    // Same token the popover draws its own outline with, so the rule reads as the
    // popover's edge. `border` is invisible here (equals the popover background).
    backgroundColor: theme.colors.borderAccent,
    marginVertical: theme.spacing[2],
    // Cancel the tooltip content's horizontal padding so the rule spans edge to edge.
    marginHorizontal: -theme.spacing[2],
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * 1.4,
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * 1.4,
  },
}));

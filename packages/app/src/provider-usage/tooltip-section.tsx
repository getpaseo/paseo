import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { findActiveProviderSessionWindow, findActiveProviderUsage } from "./active-provider";
import { ProviderUsageCard } from "./card";
import { ProviderUsageWindowBar } from "./window-bar";
import type { ProviderUsageView } from "./types";

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
  const { t } = useTranslation();
  if (view.kind === "loading") {
    return (
      <>
        <View style={styles.divider} />
        <Text style={styles.detail}>{t("providerUsage.tooltipLoading")}</Text>
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

  const usage = findActiveProviderUsage(view.payload.providers, activeProviderId);
  if (!usage) return null;

  return (
    <>
      <View style={styles.divider} />
      <ProviderUsageCard usage={usage} compact />
    </>
  );
}

// Compact composer layouts show the active provider's session limit inline so
// users do not need to open the context-window tooltip to compare the two.
export function ProviderUsageMobileSession({
  view,
  activeProviderId,
}: {
  view: ProviderUsageView;
  activeProviderId: string | null | undefined;
}) {
  if (view.kind === "loading") {
    return (
      <View
        style={styles.mobileSession}
        testID="provider-usage-mobile-session-placeholder"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <View style={styles.mobileSessionPlaceholderRow}>
          <View style={styles.mobileSessionPlaceholderLabel} />
          <View style={styles.mobileSessionPlaceholderValue} />
        </View>
        <View style={styles.mobileSessionPlaceholderTrack} />
      </View>
    );
  }

  if (view.kind !== "ready") return null;

  const sessionWindow = findActiveProviderSessionWindow(view.payload.providers, activeProviderId);
  if (!sessionWindow) return null;

  return (
    <View style={styles.mobileSession} testID="provider-usage-mobile-session">
      <ProviderUsageWindowBar window={sessionWindow} />
    </View>
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
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  mobileSession: {
    width: "100%",
  },
  mobileSessionPlaceholderRow: {
    height: theme.fontSize.xs * 1.4,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  mobileSessionPlaceholderLabel: {
    width: 44,
    height: theme.fontSize.xs,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
  mobileSessionPlaceholderValue: {
    width: 96,
    height: theme.fontSize.xs,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
  mobileSessionPlaceholderTrack: {
    height: 4,
    marginTop: 3,
    borderRadius: 2,
    backgroundColor: theme.colors.surface3,
  },
}));

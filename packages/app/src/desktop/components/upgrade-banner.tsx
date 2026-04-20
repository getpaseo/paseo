import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ArrowRight, Zap } from "lucide-react-native";
import { openExternalUrl } from "@/utils/open-external-url";
import { useOrganizations } from "@/desktop/hooks/use-organizations";
import { useActiveOrgId } from "@/stores/active-org-store";

// Any plan that isn't the free tier unlocks everything — hide upgrade UI.
function useIsOnPaidPlan(): boolean {
  const { organizations } = useOrganizations();
  const activeOrgId = useActiveOrgId();
  const activeOrg = organizations.find((o) => o.id === activeOrgId) ?? organizations[0] ?? null;
  const planId = activeOrg?.planId;
  return !!planId && planId.toLowerCase() !== "free";
}

const AUTH_SERVER_URL = "https://auth.hubcode.ai";
const BILLING_URL = `${AUTH_SERVER_URL}/dashboard/billing`;

// In dev, use localhost
function getBillingUrl(): string {
  if (__DEV__) {
    return "http://localhost:3002/dashboard/billing";
  }
  return BILLING_URL;
}

// ---------------------------------------------------------------------------
// Full banner — for settings, org pages
// ---------------------------------------------------------------------------

interface UpgradeBannerProps {
  title?: string;
  description?: string;
  compact?: boolean;
}

export function UpgradeBanner({
  title = "Upgrade to Pro",
  description = "Unlock unlimited projects, 20 members per org, and priority support.",
  compact = false,
}: UpgradeBannerProps) {
  const { theme } = useUnistyles();
  const isPaid = useIsOnPaidPlan();
  if (isPaid) return null;

  if (compact) {
    return (
      <Pressable
        style={({ hovered }) => [styles.compactBanner, hovered && styles.compactBannerHovered]}
        onPress={() => openExternalUrl(getBillingUrl())}
      >
        <Zap size={14} color={theme.colors.accent} />
        <Text style={styles.compactText}>{title}</Text>
        <ArrowRight size={12} color={theme.colors.foregroundMuted} />
      </Pressable>
    );
  }

  return (
    <View style={styles.banner}>
      <View style={styles.bannerContent}>
        <View style={styles.bannerHeader}>
          <Zap size={16} color={theme.colors.accent} />
          <Text style={styles.bannerTitle}>{title}</Text>
        </View>
        <Text style={styles.bannerDescription}>{description}</Text>
      </View>
      <Pressable
        style={({ hovered }) => [styles.upgradeButton, hovered && styles.upgradeButtonHovered]}
        onPress={() => openExternalUrl(getBillingUrl())}
      >
        <Text style={styles.upgradeButtonText}>Upgrade</Text>
        <ArrowRight size={14} color={theme.colors.accentForeground} />
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Inline limit hint — shown near limits
// ---------------------------------------------------------------------------

interface LimitHintProps {
  current: number;
  limit: number;
  noun: string; // "members", "organizations", "projects"
}

export function UpgradeLimitHint({ current, limit, noun }: LimitHintProps) {
  const { theme } = useUnistyles();
  const isPaid = useIsOnPaidPlan();
  const atLimit = current >= limit;
  const nearLimit = current >= limit - 1;

  if (isPaid) return null;
  if (!nearLimit) return null;

  return (
    <Pressable
      style={({ hovered }) => [
        styles.limitHint,
        atLimit && styles.limitHintAtLimit,
        hovered && styles.limitHintHovered,
      ]}
      onPress={() => openExternalUrl(getBillingUrl())}
    >
      <Text style={[styles.limitText, atLimit && styles.limitTextAtLimit]}>
        {atLimit
          ? `${noun} limit reached (${current}/${limit})`
          : `${current}/${limit} ${noun} used`}
        {" — "}
        <Text style={styles.limitUpgradeLink}>Upgrade to Pro</Text>
      </Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create((theme) => ({
  // Full banner
  banner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    gap: theme.spacing[4],
  },
  bannerContent: {
    flex: 1,
    gap: theme.spacing[1],
  },
  bannerHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  bannerTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  bannerDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * 1.4,
  },
  upgradeButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.accent,
    borderRadius: theme.borderRadius.base,
  },
  upgradeButtonHovered: {
    opacity: 0.9,
  },
  upgradeButtonText: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  // Compact banner
  compactBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  compactBannerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  compactText: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  // Limit hint
  limitHint: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    marginTop: theme.spacing[2],
  },
  limitHintAtLimit: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.base,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  limitHintHovered: {
    opacity: 0.8,
  },
  limitText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  limitTextAtLimit: {
    color: theme.colors.foreground,
  },
  limitUpgradeLink: {
    color: theme.colors.accent,
    fontWeight: theme.fontWeight.medium,
  },
}));

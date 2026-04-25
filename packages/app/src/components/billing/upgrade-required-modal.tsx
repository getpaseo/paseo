// Single source-of-truth modal for plan-limit denials. Wherever a feature
// is gated, the calling code:
//   1. checks the user's plan via `usePlanLimits` + `checkFlag` / `checkCount`.
//   2. if denied, opens this modal with a `feature` prop describing what
//      they tried to do and what plan unlocks it.
//
// The visual is intentionally chunky and conversion-oriented: clear
// headline, "X/Y reached" pill when relevant, comparison of what they get
// at each upgrade tier, and a primary CTA that routes to /dashboard/billing.

import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Sparkles, Zap, Crown, Check, X } from "lucide-react-native";
import { router } from "expo-router";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { authServerBaseUrl } from "@/desktop/auth/web-auth-api";
import { openExternalUrl } from "@/utils/open-external-url";
import {
  planDisplayName,
  recommendedUpgrade,
  type PlanLimitsBundle,
} from "@/hooks/use-plan-limits";

export interface UpgradeRequiredModalProps {
  visible: boolean;
  onClose: () => void;
  /** What the user tried to do (e.g. "Invite member", "Activate skill"). */
  featureLabel: string;
  /** One-line explanation that appears under the headline. */
  description?: string;
  /** Current usage / limit pair when the gate is a counter. */
  usage?: { current: number; limit: number | "unlimited" };
  /** The user's resolved plan. Drives which tier is recommended. */
  bundle: PlanLimitsBundle | null;
  /** Optional override: which tier we recommend (else auto from bundle). */
  recommended?: "plan_pro" | "plan_enterprise";
}

const TIER_HIGHLIGHTS: Record<
  "plan_pro" | "plan_enterprise",
  { perks: string[]; price: string; period: string }
> = {
  plan_pro: {
    perks: [
      "Hubcode curated combos (Pro tier)",
      "Org chat & messaging",
      "Unlimited skills, MCPs and integrations",
      "4 members per organization",
      "50 GB attachments storage",
      "1 year of message retention",
      "24h support SLA",
    ],
    price: "$20",
    period: "/month",
  },
  plan_enterprise: {
    perks: [
      "Everything in Pro, plus:",
      "20 members per organization · 3 organizations",
      "Up to 20 concurrent shared sessions",
      "Audit log",
      "SSO / SAML",
      "200 GB attachments storage · unlimited retention",
      "4h dedicated support SLA",
    ],
    price: "$250",
    period: "/month",
  },
};

export function UpgradeRequiredModal({
  visible,
  onClose,
  featureLabel,
  description,
  usage,
  bundle,
  recommended,
}: UpgradeRequiredModalProps) {
  const { theme } = useUnistyles();
  const currentPlanId = bundle?.planId ?? "plan_free";
  const targetPlan = recommended ?? recommendedUpgrade(currentPlanId).id;
  const tier = TIER_HIGHLIGHTS[targetPlan];
  const Icon = targetPlan === "plan_enterprise" ? Crown : Sparkles;

  const usageBadge =
    usage !== undefined ? (
      <View style={styles.usagePill}>
        <Text style={styles.usagePillText}>
          {usage.current}
          {" / "}
          {usage.limit === "unlimited" ? "∞" : usage.limit} reached
        </Text>
      </View>
    ) : null;

  const handleUpgrade = () => {
    onClose();
    // Web/Electron: route to in-app billing screen. The screen itself
    // handles Stripe checkout creation.
    try {
      router.push("/dashboard/billing" as never);
    } catch {
      // Fallback: open the auth-server billing page in the user's browser.
      void openExternalUrl(`${authServerBaseUrl()}/dashboard/billing`).catch(() => {});
    }
  };

  return (
    <AdaptiveModalSheet visible={visible} onClose={onClose} title="">
      <View style={styles.root}>
        <View style={styles.header}>
          <View style={styles.iconWrap}>
            <Icon size={28} color={theme.colors.brandMagenta} />
          </View>
          <Pressable onPress={onClose} style={styles.closeButton} hitSlop={8}>
            <X size={18} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>

        <View style={styles.bodyTop}>
          <Text style={styles.eyebrow}>Upgrade to {planDisplayName(targetPlan)}</Text>
          <Text style={styles.title}>{featureLabel}</Text>
          {description ? <Text style={styles.description}>{description}</Text> : null}
          {usageBadge}
        </View>

        <View style={styles.tierCard}>
          <View style={styles.tierHeaderRow}>
            <View>
              <Text style={styles.tierName}>{planDisplayName(targetPlan)}</Text>
              <Text style={styles.tierSubName}>
                You're on the {planDisplayName(currentPlanId)} plan
              </Text>
            </View>
            <View style={styles.priceBlock}>
              <Text style={styles.priceValue}>{tier.price}</Text>
              <Text style={styles.pricePeriod}>{tier.period}</Text>
            </View>
          </View>
          <View style={styles.perksList}>
            {tier.perks.map((perk) => (
              <View key={perk} style={styles.perkRow}>
                <Check size={14} color={theme.colors.primary} />
                <Text style={styles.perkText}>{perk}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={styles.actionsRow}>
          <Pressable onPress={onClose} style={styles.secondaryAction}>
            <Text style={styles.secondaryActionText}>Maybe later</Text>
          </Pressable>
          <Pressable onPress={handleUpgrade} style={styles.primaryAction}>
            <Zap size={14} color="#fff" />
            <Text style={styles.primaryActionText}>Upgrade now</Text>
          </Pressable>
        </View>

        <Text style={styles.disclaimer}>Cancel any time. Yearly billing saves about 17%.</Text>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
    gap: theme.spacing[4],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: theme.spacing[4],
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  closeButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  bodyTop: {
    gap: theme.spacing[2],
  },
  eyebrow: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.brandMagenta,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  title: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  description: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    lineHeight: theme.fontSize.sm * 1.5,
  },
  usagePill: {
    alignSelf: "flex-start",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.destructive
      ? `${theme.colors.destructive}15`
      : "rgba(220,38,38,0.12)",
    borderRadius: 999,
    marginTop: theme.spacing[1],
  },
  usagePillText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.destructive ?? "#dc2626",
  },
  tierCard: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[3],
  },
  tierHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  tierName: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  tierSubName: {
    marginTop: 2,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  priceBlock: {
    flexDirection: "row",
    alignItems: "flex-end",
  },
  priceValue: {
    fontSize: 28,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
    lineHeight: 30,
  },
  pricePeriod: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    marginBottom: 4,
  },
  perksList: {
    gap: theme.spacing[1],
  },
  perkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  perkText: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  actionsRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  secondaryAction: {
    flex: 1,
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryActionText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  primaryAction: {
    flex: 2,
    flexDirection: "row",
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.brandMagenta,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  primaryActionText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.bold,
    color: "#fff",
  },
  disclaimer: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
}));

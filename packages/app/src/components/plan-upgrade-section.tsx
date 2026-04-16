import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ArrowRight, Zap, Check } from "lucide-react-native";
import { settingsStyles } from "@/styles/settings";
import { openExternalUrl } from "@/utils/open-external-url";

function getBillingUrl(): string {
  if (__DEV__) {
    return "http://localhost:3002/dashboard/billing";
  }
  return "https://auth.hubcode.ai/dashboard/billing";
}

const PRO_FEATURES = [
  "Unlimited projects",
  "Up to 20 members per org",
  "Up to 5 organizations",
  "10 concurrent sessions",
  "Priority support",
  "API access",
];

export function PlanUpgradeSection() {
  const { theme } = useUnistyles();

  return (
    <View style={settingsStyles.section}>
      <Text style={settingsStyles.sectionTitle}>Plan</Text>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Free plan</Text>
            <Text style={settingsStyles.rowHint}>1 organization, 3 members, 5 projects</Text>
          </View>
        </View>
        <View style={[settingsStyles.rowBorder, styles.proSection]}>
          <View style={styles.proHeader}>
            <Zap size={16} color={theme.colors.accent} />
            <Text style={styles.proTitle}>Hubcode Pro</Text>
            <Text style={styles.proPrice}>$19/mo</Text>
          </View>
          <View style={styles.featureList}>
            {PRO_FEATURES.map((feature) => (
              <View key={feature} style={styles.featureRow}>
                <Check size={14} color={theme.colors.accent} />
                <Text style={styles.featureText}>{feature}</Text>
              </View>
            ))}
          </View>
          <Pressable
            style={({ hovered }) => [styles.upgradeButton, hovered && styles.upgradeButtonHovered]}
            onPress={() => openExternalUrl(getBillingUrl())}
          >
            <Text style={styles.upgradeButtonText}>Upgrade to Pro</Text>
            <ArrowRight size={14} color={theme.colors.accentForeground} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  proSection: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  proHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  proTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  proPrice: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  featureList: {
    gap: theme.spacing[2],
  },
  featureRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  featureText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  upgradeButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    backgroundColor: theme.colors.accent,
    borderRadius: theme.borderRadius.base,
  },
  upgradeButtonHovered: {
    opacity: 0.9,
  },
  upgradeButtonText: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
}));

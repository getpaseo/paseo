// Shown when a Free-tier user has selected a Hubcode combo. The combo is
// usable but rate-limited; this banner nudges them to upgrade for the
// full Hubcode experience without hard-blocking the model picker.

import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Sparkles, Zap } from "lucide-react-native";
import { useHubcodeModels } from "@/hooks/use-hubcode-models";
import { useUpgradeModal } from "./upgrade-modal-provider";

interface Props {
  /** The provider currently driving the active agent. */
  activeProvider: string | null | undefined;
}

export function HubcodeRateLimitBanner({ activeProvider }: Props) {
  const { bundle } = useHubcodeModels();
  const { triggerUpgrade } = useUpgradeModal();

  if (activeProvider !== "hubcode") return null;
  if (!bundle?.requiresUpgrade) return null;

  return (
    <Pressable
      onPress={() =>
        triggerUpgrade({
          featureLabel: "Run Hubcode at full speed",
          description:
            "Free Hubcode combos run on a low rate limit. Upgrade to Pro to use Hubcode at full capacity.",
          recommended: "plan_pro",
        })
      }
      style={styles.root}
    >
      <Zap size={13} color="#f59e0b" />
      <Text style={styles.text}>This model has a low rate limit on Free.</Text>
      <View style={styles.upgradePill}>
        <Sparkles size={10} color="#fff" />
        <Text style={styles.upgradeText}>Upgrade for full access</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: theme.spacing[2],
    paddingVertical: 6,
    paddingHorizontal: theme.spacing[3],
    borderRadius: 999,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: "#f59e0b",
  },
  text: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  upgradePill: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 4,
    backgroundColor: theme.colors.brandMagenta,
    paddingVertical: 2,
    paddingHorizontal: theme.spacing[2],
    borderRadius: 999,
  },
  upgradeText: {
    fontSize: 10,
    fontWeight: theme.fontWeight.bold,
    color: "#fff",
  },
}));

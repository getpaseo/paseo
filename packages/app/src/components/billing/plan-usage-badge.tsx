// Inline "X / Y used" badge for plan-gated counters. Drops in next to
// section headers (e.g. "Installed skills", "Members", "Active shares")
// so users see how close they are to their plan limit *before* they hit
// the gate. When at/over the limit the badge gets a lock icon and tap
// opens the upgrade modal.
//
// Reads `usePlanLimits()` for the limit, takes `current` from the caller
// (the screen already has the count it's rendering). Renders nothing if
// the limit is unlimited — we don't want to nag Pro/Enterprise users.

import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Lock } from "lucide-react-native";
import { usePlanLimits, type PlanLimitsBundle } from "@/hooks/use-plan-limits";
import { useUpgradeModal } from "./upgrade-modal-provider";

interface PlanUsageBadgeProps {
  /** Which counter feature this badge tracks. */
  limitKey: keyof PlanLimitsBundle["limits"];
  /** Current usage. The screen owns the count. */
  current: number;
  /** Short label used in the upgrade modal (e.g. "Activate more skills"). */
  upgradeFeatureLabel?: string;
}

export function PlanUsageBadge({ limitKey, current, upgradeFeatureLabel }: PlanUsageBadgeProps) {
  const { theme } = useUnistyles();
  const { bundle } = usePlanLimits();
  const { triggerUpgrade } = useUpgradeModal();
  const limit = bundle?.limits[limitKey];

  if (!bundle || !limit || limit.isUnlimited) return null;

  const max = limit.numeric;
  const atLimit = current >= max;
  const nearLimit = !atLimit && current >= Math.max(1, Math.floor(max * 0.8));

  const onPress = () => {
    if (!atLimit) return;
    triggerUpgrade({
      featureLabel: upgradeFeatureLabel ?? `Increase ${limitKey.replace(/_/g, " ")}`,
      usage: { current, limit: max },
    });
  };

  const Pill = atLimit ? Pressable : View;

  return (
    <Pill
      onPress={atLimit ? onPress : undefined}
      style={[styles.root, atLimit && styles.atLimit, nearLimit && styles.nearLimit]}
    >
      {atLimit ? <Lock size={11} color={theme.colors.destructive ?? "#dc2626"} /> : null}
      <Text style={[styles.text, atLimit && styles.atLimitText, nearLimit && styles.nearLimitText]}>
        {current} / {max}
      </Text>
    </Pill>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 2,
    paddingHorizontal: theme.spacing[2],
    borderRadius: 999,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  text: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
  },
  nearLimit: {
    borderColor: "#f59e0b",
  },
  nearLimitText: {
    color: "#f59e0b",
  },
  atLimit: {
    borderColor: theme.colors.destructive ?? "#dc2626",
    backgroundColor: theme.colors.destructive
      ? `${theme.colors.destructive}12`
      : "rgba(220,38,38,0.1)",
  },
  atLimitText: {
    color: theme.colors.destructive ?? "#dc2626",
  },
}));

// Free-tier session countdown banner. Drop this into any screen that
// renders a long-running agent conversation — it watches the user's
// `max_session_duration_minutes` plan limit, shows a pill in the
// corner with the remaining time, and opens the upgrade modal when
// the countdown hits zero.
//
// The component is a pure preview of the cap. Hard enforcement still
// lives on the daemon side (it cuts off the agent at the 60-min mark
// for Free users); this banner just gives the user a heads-up so the
// cutoff doesn't feel arbitrary.
//
// Usage:
//   <FreeSessionCountdownBanner sessionStartedAt={agent.startedAt ?? Date.now()} />
//
// If the user is on a paid plan (unlimited session duration) the banner
// renders nothing — we don't want to nag people who are paying.

import { useEffect, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Clock, Sparkles } from "lucide-react-native";
import { usePlanLimits, useSessionTimeRemaining } from "@/hooks/use-plan-limits";
import { useUpgradeModal } from "./upgrade-modal-provider";

interface Props {
  /** Epoch ms when the session started. Pass the agent's createdAt. */
  sessionStartedAt: number | null;
}

export function FreeSessionCountdownBanner({ sessionStartedAt }: Props) {
  const { theme } = useUnistyles();
  const { bundle } = usePlanLimits();
  const { triggerUpgrade } = useUpgradeModal();
  const { hasLimit, totalMinutes, secondsRemaining, expired } = useSessionTimeRemaining(
    bundle,
    sessionStartedAt,
  );
  // Fire the upgrade modal exactly once when the countdown hits zero.
  // The ref guards against re-firing on every render after expiry.
  const firedRef = useRef(false);

  useEffect(() => {
    if (!expired || firedRef.current) return;
    firedRef.current = true;
    triggerUpgrade({
      featureLabel: "Run longer agent sessions",
      description:
        "Free agent sessions end after the time cap. Upgrade to Pro for unlimited session length.",
      usage: { current: totalMinutes, limit: totalMinutes },
      recommended: "plan_pro",
    });
  }, [expired, totalMinutes, triggerUpgrade]);

  if (!hasLimit || !sessionStartedAt) return null;

  const minutes = Math.floor(secondsRemaining / 60);
  const seconds = secondsRemaining % 60;
  const danger = secondsRemaining <= 5 * 60; // last 5 minutes get loud
  const warning = !danger && secondsRemaining <= 15 * 60;

  return (
    <Pressable
      onPress={() =>
        triggerUpgrade({
          featureLabel: "Run longer agent sessions",
          description: "Upgrade to Pro for unlimited agent session duration.",
          recommended: "plan_pro",
        })
      }
      style={[styles.root, warning && styles.warning, danger && styles.danger]}
    >
      <Clock
        size={13}
        color={
          danger
            ? "#dc2626"
            : warning
              ? "#f59e0b"
              : theme.colors.foregroundMuted
        }
      />
      <Text
        style={[styles.text, warning && styles.warningText, danger && styles.dangerText]}
      >
        {minutes}:{seconds.toString().padStart(2, "0")} left on Free
      </Text>
      <View style={styles.upgradePill}>
        <Sparkles size={10} color="#fff" />
        <Text style={styles.upgradeText}>Upgrade</Text>
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
    borderColor: theme.colors.border,
  },
  text: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
  },
  warning: {
    borderColor: "#f59e0b",
  },
  warningText: {
    color: "#f59e0b",
  },
  danger: {
    borderColor: "#dc2626",
    backgroundColor: "rgba(220,38,38,0.08)",
  },
  dangerText: {
    color: "#dc2626",
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

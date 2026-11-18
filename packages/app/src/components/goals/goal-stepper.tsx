import type { ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { GoalStep, GoalStepState } from "@/goals/goal-phase";

/** Planning → Plan review → Working → Review → Integrating → Done, as six segments. */
export function GoalStepper({ steps }: { steps: readonly GoalStep[] }): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const activeIndex = steps.findIndex(
    (step) => step.state === "current" || step.state === "stopped",
  );
  const active = steps[activeIndex] ?? steps[steps.length - 1];

  return (
    <View style={styles.container} testID="goal-stepper" accessibilityRole="progressbar">
      <View style={styles.segments}>
        {steps.map((step) => (
          <View key={step.id} style={styles.step}>
            <View
              style={[
                styles.segment,
                step.state === "done" && styles.segmentDone,
                step.state === "current" && styles.segmentCurrent,
                step.state === "stopped" && styles.segmentStopped,
              ]}
            />
            {isCompact ? null : (
              <Text style={[styles.label, labelStyle(step.state)]} numberOfLines={1}>
                {t(`goals.steps.${step.id}`)}
              </Text>
            )}
          </View>
        ))}
      </View>
      {isCompact && active ? (
        <Text style={styles.compactLabel}>
          {t("goals.stepOf", {
            n: activeIndex < 0 ? steps.length : activeIndex + 1,
            total: steps.length,
          })}
          {" · "}
          {t(`goals.steps.${active.id}`)}
        </Text>
      ) : null}
    </View>
  );
}

function labelStyle(state: GoalStepState) {
  if (state === "current") {
    return styles.labelCurrent;
  }
  if (state === "stopped") {
    return styles.labelStopped;
  }
  return null;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
  },
  segments: {
    flexDirection: "row",
    gap: theme.spacing[1],
  },
  step: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1.5],
  },
  segment: {
    height: 4,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
  segmentDone: {
    backgroundColor: theme.colors.statusSuccess,
  },
  segmentCurrent: {
    backgroundColor: theme.colors.foreground,
  },
  segmentStopped: {
    backgroundColor: theme.colors.statusDanger,
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  labelCurrent: {
    color: theme.colors.foreground,
  },
  labelStopped: {
    color: theme.colors.statusDanger,
  },
  compactLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));

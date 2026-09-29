import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronRight, X } from "@/components/icons/ui-icons";
import type {
  BrowserActivityControlRequest,
  BrowserActivityEvent,
  BrowserActivityStep,
  BrowserHandoff,
} from "@getpaseo/protocol/browser-activity/rpc-schemas";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import {
  browserActivityStatusBucket,
  describeBrowserActivityStep,
  describeNextBrowserActivityStep,
  formatBrowserActivityConfidence,
  isBrowserRunActive,
  summarizeBrowserActivity,
} from "@/desktop/browser/activity";

interface BrowserActivityBarProps {
  activity: BrowserActivityEvent;
  onControl: (action: "pause" | "resume") => void;
  onDismiss: () => void;
}

const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const SHEET_SNAP_POINTS = ["50%", "90%"];
const STEP_MARKERS: Record<BrowserActivityStep["status"], string> = {
  pending: "○",
  active: "●",
  done: "✓",
  failed: "✕",
};

export function BrowserActivityBar({ activity, onControl, onDismiss }: BrowserActivityBarProps) {
  const { t } = useTranslation();
  const [stepsOpen, setStepsOpen] = useState(false);
  const active = isBrowserRunActive(activity);
  const takenOver = activity.phase === "paused" || activity.pauseRequested;
  const summary = summarizeBrowserActivity(activity, t);
  const phase =
    active && activity.phase !== "paused"
      ? t(`workspace.browser.activity.phase.${activity.phase}`)
      : null;
  const confidence = formatBrowserActivityConfidence(activity.action);
  const meta = [phase, confidence].filter(Boolean).join(" · ");
  const next = describeNextBrowserActivityStep(activity, t);
  const bucket = browserActivityStatusBucket(activity);
  // Steps carry no ids; a step's position in the run is its identity.
  const stepRows = useMemo(() => {
    const steps =
      activity.kind === "goal" && activity.action && activity.phase !== "verifying"
        ? [...activity.steps, activity.action]
        : activity.steps;
    return steps.map((step, position) => ({ step, position }));
  }, [activity]);

  const openSteps = useCallback(() => setStepsOpen(true), []);
  const closeSteps = useCallback(() => setStepsOpen(false), []);
  const handleControl = useCallback(
    () => onControl(takenOver ? "resume" : "pause"),
    [onControl, takenOver],
  );
  const controlLabel = takenOver
    ? t("workspace.browser.activity.resume")
    : t("workspace.browser.activity.takeOver");
  const sheetHeader = useMemo(
    () => ({ title: t("workspace.browser.activity.title"), subtitle: activity.label }),
    [activity.label, t],
  );
  const sheetFooter = useMemo(
    () =>
      active ? (
        <Button variant="default" onPress={handleControl}>
          {controlLabel}
        </Button>
      ) : undefined,
    [active, controlLabel, handleControl],
  );

  let dotStyle = styles.dotDone;
  if (bucket === "running") dotStyle = styles.dotRunning;
  else if (bucket === "needs_input") dotStyle = styles.dotPaused;
  else if (bucket === "failed") dotStyle = styles.dotFailed;

  return (
    <View style={styles.bar} testID="browser-activity-bar">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={summary}
        accessibilityHint={t("workspace.browser.activity.openSteps")}
        accessibilityLiveRegion="polite"
        hitSlop={8}
        onPress={openSteps}
        style={styles.summary}
        testID="browser-activity-summary"
      >
        <View style={[styles.dot, dotStyle]} />
        <Text numberOfLines={1} style={styles.summaryText}>
          {summary}
        </Text>
        {meta ? (
          <Text aria-hidden={true} numberOfLines={1} style={styles.meta}>
            {meta}
          </Text>
        ) : null}
        <ThemedChevronRight size={14} uniProps={mutedColor} />
      </Pressable>
      {active ? (
        <Button
          size="xs"
          variant="outline"
          onPress={handleControl}
          testID="browser-activity-control"
        >
          {controlLabel}
        </Button>
      ) : (
        <Button
          size="xs"
          variant="ghost"
          leftIcon={X}
          accessibilityLabel={t("workspace.browser.activity.dismiss")}
          onPress={onDismiss}
        />
      )}
      <AdaptiveModalSheet
        header={sheetHeader}
        visible={stepsOpen}
        onClose={closeSteps}
        snapPoints={SHEET_SNAP_POINTS}
        testID="browser-activity-sheet"
        footer={sheetFooter}
      >
        <View style={styles.section}>
          <Text style={styles.label}>{t("workspace.browser.activity.now")}</Text>
          <Text style={styles.value}>{summary}</Text>
          {meta ? <Text style={styles.meta}>{meta}</Text> : null}
        </View>
        {next ? (
          <View style={styles.section}>
            <Text style={styles.label}>{t("workspace.browser.activity.next")}</Text>
            <Text style={styles.value}>{next}</Text>
          </View>
        ) : null}
        <View style={styles.section} accessibilityRole="list">
          <Text style={styles.label}>{t("workspace.browser.activity.steps")}</Text>
          {stepRows.length === 0 ? (
            <Text style={styles.meta}>{t("workspace.browser.activity.noSteps")}</Text>
          ) : null}
          {stepRows.map(({ step, position }) => {
            const description = describeBrowserActivityStep(step);
            const status = t(`workspace.browser.activity.stepStatus.${step.status}`);
            return (
              <View
                key={position}
                accessible={true}
                accessibilityLabel={`${position + 1}. ${status}: ${description}`}
                style={styles.stepRow}
              >
                <Text style={step.status === "failed" ? styles.markerFailed : styles.marker}>
                  {STEP_MARKERS[step.status]}
                </Text>
                <Text style={step.status === "pending" ? styles.stepPending : styles.stepText}>
                  {description}
                </Text>
              </View>
            );
          })}
        </View>
      </AdaptiveModalSheet>
    </View>
  );
}

type BrowserHandoffAction = Extract<
  BrowserActivityControlRequest["action"],
  "finish_handoff" | "cancel_handoff"
>;

interface BrowserHandoffBarProps {
  handoff: BrowserHandoff;
  pendingAction: BrowserHandoffAction | null;
  onEnd: (action: BrowserHandoffAction) => void;
}

/** The user controls the tab; the agent waits until Done or Cancel. */
export function BrowserHandoffBar({ handoff, pendingAction, onEnd }: BrowserHandoffBarProps) {
  const { t } = useTranslation();
  const finish = useCallback(() => onEnd("finish_handoff"), [onEnd]);
  const cancel = useCallback(() => onEnd("cancel_handoff"), [onEnd]);
  const isPending = pendingAction !== null;

  return (
    <View style={styles.bar} testID="browser-handoff-bar">
      <View
        accessible={true}
        accessibilityLabel={`${t("workspace.browser.handoff.youHaveControl")}: ${handoff.reason}`}
        accessibilityLiveRegion="polite"
        style={styles.summary}
      >
        <View style={[styles.dot, styles.dotPaused]} />
        <Text numberOfLines={2} style={styles.summaryText}>
          {handoff.reason}
        </Text>
        <Text aria-hidden={true} numberOfLines={1} style={styles.meta}>
          {t("workspace.browser.handoff.youHaveControl")}
        </Text>
      </View>
      <Button
        size="xs"
        variant="ghost"
        disabled={isPending}
        loading={pendingAction === "cancel_handoff"}
        onPress={cancel}
        testID="browser-handoff-cancel"
      >
        {t("workspace.browser.handoff.cancel")}
      </Button>
      <Button
        size="xs"
        variant="outline"
        disabled={isPending}
        loading={pendingAction === "finish_handoff"}
        onPress={finish}
        testID="browser-handoff-done"
      >
        {t("workspace.browser.handoff.done")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  summary: {
    flex: 1,
    minWidth: 0,
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  dot: { width: 8, height: 8, borderRadius: theme.borderRadius.full },
  dotRunning: { backgroundColor: theme.colors.statusDotRunning },
  dotPaused: { backgroundColor: theme.colors.statusDotWarning },
  dotFailed: { backgroundColor: theme.colors.statusDotDanger },
  dotDone: { backgroundColor: theme.colors.statusDotSuccess },
  summaryText: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  meta: { flexShrink: 0, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  section: { gap: theme.spacing[1], paddingBottom: theme.spacing[4] },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  value: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  stepRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  marker: { width: 16, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  markerFailed: { width: 16, color: theme.colors.statusDanger, fontSize: theme.fontSize.base },
  stepText: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.base },
  stepPending: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
}));

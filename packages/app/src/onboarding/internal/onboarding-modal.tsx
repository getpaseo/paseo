import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check } from "lucide-react-native";
import {
  AdaptiveModalSheet,
  FULL_SHEET_SNAP_POINTS,
  SheetFooter,
} from "@/components/adaptive-modal-sheet";
import { PaseoLogo } from "@/components/icons/paseo-logo";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { ScrollView } from "@/components/ui/scroll-view";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useProjectSuggestions, type ProjectSuggestionsController } from "@/project-suggestions";
import type { Theme } from "@/styles/theme";
import type { OnboardingModel, OnboardingState, OnboardingStepId } from "./model";
import { useOrchestrationSetup, type OrchestrationSetupController } from "./orchestration-setup";
import { OnboardingStepContent } from "./steps";

type OpenState = Extract<OnboardingState, { status: "open" }>;

const ThemedCheck = withUnistyles(Check);
const accentForegroundMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });

export function OnboardingModal({ model, state }: { model: OnboardingModel; state: OpenState }) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const step = state.steps[state.stepIndex];
  const isFirst = state.stepIndex === 0;
  const isLast = state.stepIndex === state.steps.length - 1;
  // Held here so Continue can add the checked folders; reading history from the first step means
  // the Projects step rarely waits.
  const projectSuggestions = useProjectSuggestions(state.serverId);
  const { addChecked } = projectSuggestions;
  const orchestration = useOrchestrationSetup(state.serverId);
  const { apply: applyOrchestration } = orchestration;

  const handleComplete = useCallback(() => {
    void model.complete();
  }, [model]);
  const handleBack = useCallback(() => model.back(), [model]);
  const { visit } = state;
  // A step's own work runs before it moves on; from the last step, moving on finishes setup.
  const handleAdvance = useCallback(() => model.next(visit), [model, visit]);
  const handleAddSuggestions = useCallback(() => {
    void (async () => {
      if (await addChecked()) handleAdvance();
    })();
  }, [addChecked, handleAdvance]);
  const handleApplyOrchestration = useCallback(() => {
    void (async () => {
      if (await applyOrchestration()) handleAdvance();
    })();
  }, [applyOrchestration, handleAdvance]);
  const primary = usePrimaryAction({
    step,
    isLast,
    projectSuggestions,
    orchestration,
    onAdvance: handleAdvance,
    onAddSuggestions: handleAddSuggestions,
    onApplyOrchestration: handleApplyOrchestration,
  });

  // The compact sheet stacks a title row, the step and the actions. The desktop card gives the
  // step rail the full height instead: the brand tops the rail, the actions close the step pane,
  // and the sheet floats its close button.
  const compactHeader = useMemo(
    () => ({
      title: t("onboarding.setup.title"),
      leading: <PaseoLogo size={LOGO_SIZE} />,
      subtitle: (
        <Text style={styles.stepCounter}>
          {t("onboarding.setup.stepCounter", {
            current: state.stepIndex + 1,
            total: state.steps.length,
          })}
        </Text>
      ),
    }),
    [state.stepIndex, state.steps.length, t],
  );

  const actions = (
    <>
      <View>
        {isLast ? null : (
          <Button variant="outline" onPress={handleComplete}>
            {t("onboarding.setup.skip")}
          </Button>
        )}
      </View>
      <View style={styles.footerActions}>
        {isFirst ? null : (
          <Button variant="secondary" onPress={handleBack}>
            {t("common.actions.back")}
          </Button>
        )}
        <Button variant="default" onPress={primary.onPress} loading={primary.busy}>
          {primary.label}
        </Button>
      </View>
    </>
  );

  return (
    <AdaptiveModalSheet
      visible
      onClose={handleComplete}
      header={isCompact ? compactHeader : undefined}
      footer={isCompact ? actions : undefined}
      scrollable={false}
      snapPoints={FULL_SHEET_SNAP_POINTS}
      desktopMaxWidth={880}
      desktopHeight={640}
      contentStyle={styles.content}
      testID="onboarding-modal"
    >
      <View style={styles.body}>
        {isCompact ? null : <StepRail state={state} onSelect={model.goTo} />}
        <View style={styles.pane}>
          <ScrollView style={styles.paneScroll}>
            {/* Padding lives on a wrapper: the ScrollView's contentContainerStyle skips Unistyles. */}
            <View style={styles.paneContent}>
              <View style={styles.stepHeader}>
                <Text style={styles.stepTitle} accessibilityRole="header">
                  {t(`onboarding.setup.steps.${step}.title`)}
                </Text>
                <Text style={styles.stepDescription}>
                  {t(`onboarding.setup.steps.${step}.description`)}
                </Text>
              </View>
              <OnboardingStepContent
                step={step}
                serverId={state.serverId}
                projectSuggestions={projectSuggestions}
                orchestration={orchestration}
              />
            </View>
          </ScrollView>
          {isCompact ? null : <SheetFooter>{actions}</SheetFooter>}
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

/**
 * The footer's main button. On Projects, with folders checked, it adds them and moves on only once
 * every one was added. On Orchestration it applies the switches and moves on once they all took.
 * Otherwise it moves on. Moving on from the last step finishes setup, so that step's work still
 * runs first; Orchestration is last in the compact layout.
 */
function usePrimaryAction(input: {
  step: OnboardingStepId;
  isLast: boolean;
  projectSuggestions: ProjectSuggestionsController;
  orchestration: OrchestrationSetupController;
  onAdvance: () => void;
  onAddSuggestions: () => void;
  onApplyOrchestration: () => void;
}): { label: string; busy: boolean; onPress: () => void } {
  const { t } = useTranslation();
  const {
    step,
    isLast,
    projectSuggestions,
    orchestration,
    onAdvance,
    onAddSuggestions,
    onApplyOrchestration,
  } = input;
  const { checkedCount, isAdding } = projectSuggestions;
  const advanceLabel = isLast ? t("onboarding.setup.finish") : t("onboarding.setup.continue");
  // Rows leave the list as they are added, so the count can reach zero while adding.
  if (step === "projects" && (isAdding || checkedCount > 0)) {
    return {
      label: isAdding
        ? t("onboarding.setup.steps.projects.suggestions.adding")
        : t("onboarding.setup.steps.projects.suggestions.addSelected", { count: checkedCount }),
      busy: isAdding,
      onPress: onAddSuggestions,
    };
  }
  if (step === "orchestration") {
    return { label: advanceLabel, busy: orchestration.isApplying, onPress: onApplyOrchestration };
  }
  return { label: advanceLabel, busy: false, onPress: onAdvance };
}

function StepRail({
  state,
  onSelect,
}: {
  state: OpenState;
  onSelect: (step: OnboardingStepId) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.rail}>
      <View style={styles.railBrand}>
        <PaseoLogo size={LOGO_SIZE} />
        <Text style={styles.railTitle} numberOfLines={1}>
          {t("onboarding.setup.title")}
        </Text>
      </View>
      <View style={styles.railSteps}>
        {state.steps.map((step, index) => (
          <StepRailItem
            key={step}
            step={step}
            number={index + 1}
            current={index === state.stepIndex}
            done={index < state.stepIndex}
            onSelect={onSelect}
          />
        ))}
      </View>
    </View>
  );
}

function StepRailItem({
  step,
  number,
  current,
  done,
  onSelect,
}: {
  step: OnboardingStepId;
  number: number;
  current: boolean;
  done: boolean;
  onSelect: (step: OnboardingStepId) => void;
}) {
  const { t } = useTranslation();
  const label = t(`onboarding.setup.steps.${step}.label`);
  const handlePress = useCallback(() => onSelect(step), [onSelect, step]);
  const accessibilityState = useMemo(() => ({ selected: current }), [current]);
  const itemStyle = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.railItem,
      hovered && !current && styles.railItemHovered,
      current && styles.railItemCurrent,
    ],
    [current],
  );
  return (
    <PressHighlight
      style={itemStyle}
      onPress={handlePress}
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={accessibilityState}
      aria-selected={current}
    >
      <View style={done || current ? styles.railBadgeActive : styles.railBadge}>
        {done ? (
          <ThemedCheck size={12} strokeWidth={3} uniProps={accentForegroundMapping} />
        ) : (
          <Text style={current ? styles.railBadgeTextActive : styles.railBadgeText}>{number}</Text>
        )}
      </View>
      <Text style={current ? styles.railLabelCurrent : styles.railLabel} numberOfLines={1}>
        {label}
      </Text>
    </PressHighlight>
  );
}

const BADGE_SIZE = 20;
const LOGO_SIZE = 20;

const styles = StyleSheet.create((theme) => ({
  content: {
    padding: 0,
    gap: 0,
  },
  body: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
  },
  rail: {
    width: 200,
    padding: theme.spacing[3],
    borderRightWidth: theme.borderWidth[1],
    borderRightColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface1,
  },
  // Inset like a rail item, so the logo sits on the badges' column.
  railBrand: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    marginBottom: theme.spacing[4],
  },
  railTitle: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  railSteps: {
    gap: theme.spacing[1],
  },
  railItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
  },
  railItemHovered: {
    backgroundColor: theme.colors.surface2,
  },
  railItemCurrent: {
    backgroundColor: theme.colors.surface2,
  },
  railBadge: {
    width: BADGE_SIZE,
    height: BADGE_SIZE,
    borderRadius: BADGE_SIZE / 2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  railBadgeActive: {
    width: BADGE_SIZE,
    height: BADGE_SIZE,
    borderRadius: BADGE_SIZE / 2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  railBadgeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  railBadgeTextActive: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.base,
  },
  railLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  railLabelCurrent: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  pane: {
    flex: 1,
    minHeight: 0,
  },
  paneScroll: {
    flex: 1,
    minHeight: 0,
  },
  paneContent: {
    padding: theme.spacing[6],
    gap: theme.spacing[6],
  },
  stepHeader: {
    gap: theme.spacing[2],
  },
  stepTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.medium,
  },
  stepDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.5,
  },
  stepCounter: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  footerActions: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
}));

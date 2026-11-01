import { useCallback, useMemo, useState, useSyncExternalStore, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Goal } from "@getpaseo/protocol/goal/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { useIsCompactFormFactor } from "@/constants/layout";
import { deriveGoalTitle } from "@/goals/goal-chat-prefill";
import { goalFormMemoryFromConfig } from "@/goals/goal-form-memory";
import {
  shortCommit,
  type GoalFormBaseCommit,
  type GoalFormField,
  type GoalFormIssue,
  type GoalFormModel,
  type GoalFormPrefill,
  type GoalFormSnapshot,
  type GoalFormState,
} from "@/goals/goal-form-model";
import { settingsSummaryText } from "@/goals/goal-labels";
import { basename } from "@/goals/goal-projects";
import { GOAL_PRESET_IDS, type GoalSettingsChoice } from "@/goals/goal-settings";
import {
  useGoalFormCwdCheck,
  useGoalFormHosts,
  useGoalFormModel,
  useGoalFormProjectOptions,
  useGoalFormProviderOptions,
} from "@/goals/use-goal-form-model";
import { useGoalMutations } from "@/hooks/use-goal-mutations";
import { useHostFeature } from "@/runtime/host-features";
import { useGoalFormMemoryStore } from "@/stores/goal-form-memory-store";
import { toErrorMessage } from "@/utils/error-messages";
import { GoalFormAdvanced } from "./goal-form-advanced";
import { ProviderSelect } from "./goal-form-fields";
import { GoalHostField, GoalProjectField } from "./goal-project-field";

/**
 * Mount only while open: the caller renders this conditionally, so every open
 * starts from the prefill (docs/forms.md, fresh mount per open).
 */
export function GoalFormSheet({
  serverId,
  prefill,
  onClose,
  onCreated,
}: {
  serverId: string;
  prefill?: GoalFormPrefill;
  onClose: () => void;
  /** Gets the host the goal was created on, which you may have changed in the form. */
  onCreated?: (goal: Goal, serverId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  // A host without `goalBudgets` would drop the caps silently, so the inputs stay hidden there.
  const budgetSupported = useHostFeature(serverId, "goalBudgets");
  // An older daemon would drop thinking settings, so the pickers appear only with `goalThinking`.
  const thinkingSupported = useHostFeature(serverId, "goalThinking");
  // An older daemon's schema rejects `auto`, so it is offered only with `goalConfigEdit`.
  const autoPermissionSupported = useHostFeature(serverId, "goalConfigEdit");
  // COMPAT(goalUserWait): added in v0.13.14, remove gate after 2027-10-28.
  const userWaitSupported = useHostFeature(serverId, "goalUserWait");
  const [snapshot] = useState(() =>
    buildSnapshot({
      serverId,
      prefill,
      budgetSupported,
      thinkingSupported,
      userWaitSupported,
      autoPermissionSupported,
    }),
  );
  const model = useGoalFormModel(snapshot);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const goalServerId = state.serverId;
  const { createGoal, isCreating } = useGoalMutations({ serverId: goalServerId });
  useGoalFormHosts(model);
  useGoalFormProjectOptions({ model, serverId: goalServerId });
  useGoalFormCwdCheck({
    model,
    serverId: goalServerId,
    cwd: state.values.cwd,
    enabled: state.values.managed,
  });
  const providersSnapshot = useGoalFormProviderOptions({
    model,
    serverId: goalServerId,
    enabled: state.values.managed,
  });
  const { createInput } = state;

  const handleSubmit = useCallback(async () => {
    if (!createInput) {
      model.attemptSubmit();
      return;
    }
    model.setSubmitError(null);
    try {
      const goal = await createGoal(createInput);
      if (createInput.config) {
        useGoalFormMemoryStore
          .getState()
          .remember(
            goalServerId,
            goalFormMemoryFromConfig(createInput.config, state.values.settings),
          );
      }
      onClose();
      if (goal) {
        onCreated?.(goal, goalServerId);
      }
    } catch (error) {
      model.setSubmitError(toErrorMessage(error));
    }
  }, [createGoal, createInput, goalServerId, model, onClose, onCreated, state.values.settings]);

  const handleSubmitPress = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  const header = useMemo<SheetHeader>(() => ({ title: t("goals.form.title") }), [t]);

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          style={styles.footerButton}
          variant="secondary"
          onPress={onClose}
          disabled={isCreating}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={handleSubmitPress}
          loading={isCreating}
          testID="goal-form-submit"
        >
          {t("goals.form.create")}
        </Button>
      </View>
    ),
    [handleSubmitPress, isCreating, onClose, t],
  );

  const setTitle = useCallback((value: string) => model.setValue("title", value), [model]);
  const setObjective = useCallback((value: string) => model.setValue("objective", value), [model]);
  const setCriteriaText = useCallback(
    (value: string) => model.setValue("criteriaText", value),
    [model],
  );
  const setManaged = useCallback((value: boolean) => model.setValue("managed", value), [model]);
  const titlePlaceholder =
    deriveGoalTitle(state.values.objective) || t("goals.form.titlePlaceholder");

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      footer={footer}
      testID="goal-form-sheet"
      desktopMaxWidth={720}
      desktopResizable
      desktopResizeInitialWidth={720}
      desktopResizeMaxWidth={960}
    >
      {state.hosts.length > 1 && !state.originAgentId ? (
        <GoalHostField model={model} state={state} size={controlSize} />
      ) : null}
      {state.values.managed ? (
        <GoalProjectField
          model={model}
          state={state}
          size={controlSize}
          error={issueMessage(t, state.visibleIssues, "cwd", state.values.cwd)}
        />
      ) : null}
      <Field
        label={t("goals.form.objectiveLabel")}
        error={issueMessage(t, state.visibleIssues, "title")}
      >
        <FormTextInput
          size={controlSize}
          testID="goal-objective-input"
          accessibilityLabel={t("goals.form.objectiveLabel")}
          initialValue={state.values.objective}
          onChangeText={setObjective}
          placeholder={t("goals.form.objectivePlaceholder")}
          style={styles.multilineInput}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
        />
      </Field>
      <Field
        label={t("goals.form.criteriaLabel")}
        error={issueMessage(t, state.visibleIssues, "criteria")}
      >
        <FormTextInput
          size={controlSize}
          testID="goal-criteria-input"
          accessibilityLabel={t("goals.form.criteriaLabel")}
          initialValue={state.values.criteriaText}
          onChangeText={setCriteriaText}
          placeholder={t("goals.form.criteriaPlaceholder")}
          style={styles.multilineInput}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
        />
      </Field>
      <Field label={t("goals.form.titleLabel")}>
        <FormTextInput
          size={controlSize}
          testID="goal-title-input"
          accessibilityLabel={t("goals.form.titleLabel")}
          initialValue={state.values.title}
          onChangeText={setTitle}
          placeholder={titlePlaceholder}
        />
      </Field>
      <Field label={t("goals.form.managedLabel")}>
        <Switch
          value={state.values.managed}
          onValueChange={setManaged}
          accessibilityLabel={t("goals.form.managedLabel")}
          testID="goal-managed-switch"
        />
      </Field>
      {state.values.managed ? (
        <ManagedGoalFields
          model={model}
          state={state}
          serverId={goalServerId}
          providersLoading={providersSnapshot.isLoading || providersSnapshot.isFetching}
          size={controlSize}
        />
      ) : null}
      <Outcome state={state} />
      {state.submitError ? <Text style={styles.submitError}>{state.submitError}</Text> : null}
    </AdaptiveModalSheet>
  );
}

function buildSnapshot(input: {
  serverId: string;
  prefill: GoalFormPrefill | undefined;
  budgetSupported: boolean;
  thinkingSupported: boolean;
  userWaitSupported: boolean;
  autoPermissionSupported: boolean;
}): GoalFormSnapshot {
  // Read once: the form starts from your last goal and never rebuilds when memory changes.
  const memoryByServer = useGoalFormMemoryStore.getState().byServer;
  return {
    serverId: input.serverId,
    prefill: input.prefill,
    memoryByServer,
    personalSettings: memoryByServer[input.serverId]?.settings ?? null,
    budgetSupported: input.budgetSupported,
    thinkingSupported: input.thinkingSupported,
    userWaitSupported: input.userWaitSupported,
    autoPermissionSupported: input.autoPermissionSupported,
  };
}

function issueMessage(
  t: TFunction,
  issues: readonly GoalFormIssue[],
  field: GoalFormField,
  cwd = "",
): string | null {
  const issue = issues.find((candidate) => candidate.field === field);
  if (!issue) {
    return null;
  }
  if (issue.code === "excludesRole") {
    return t("goals.form.errors.excludesRole", { provider: issue.provider });
  }
  if (issue.code === "notGitRepo") {
    // The folder's name, not its path: a long path would push the reason out of the one-line error.
    return t("goals.form.errors.notGitRepo", { folder: basename(cwd) });
  }
  switch (field) {
    case "title":
      return t("goals.form.errors.titleRequired");
    case "criteria":
      return t("goals.form.errors.criteriaRequired");
    case "cwd":
      return t("goals.form.errors.projectRequired");
    default:
      return t("goals.form.errors.providerRequired");
  }
}

function ManagedGoalFields({
  model,
  state,
  serverId,
  providersLoading,
  size,
}: {
  model: GoalFormModel;
  state: GoalFormState;
  serverId: string;
  providersLoading: boolean;
  size: FieldControlSize;
}): ReactElement {
  const { t } = useTranslation();
  const { values } = state;
  const setLead = useCallback((value: string) => model.setValue("leadProvider", value), [model]);
  const setDefault = useCallback(
    (value: string) => model.setValue("defaultProvider", value),
    [model],
  );
  const setTestCommand = useCallback(
    (value: string) => model.setValue("testCommand", value),
    [model],
  );
  const toggleAdvanced = useCallback(
    () => model.setAdvancedExpanded(!state.advancedExpanded),
    [model, state.advancedExpanded],
  );
  const advancedAccessibilityState = useMemo(
    () => ({ expanded: state.advancedExpanded }),
    [state.advancedExpanded],
  );

  return (
    <>
      {state.originAgentId ? <Text style={styles.note}>{t("goals.form.postsBack")}</Text> : null}
      {state.baseCommit ? <BuildsOnNote model={model} baseCommit={state.baseCommit} /> : null}
      <ProviderSelect
        label={t("goals.form.leadProviderLabel")}
        value={values.leadProvider}
        onChange={setLead}
        options={state.providerOptions}
        serverId={serverId}
        loading={providersLoading}
        size={size}
        testID="goal-lead-provider"
      />
      <ProviderSelect
        label={t("goals.form.defaultProviderLabel")}
        value={values.defaultProvider}
        onChange={setDefault}
        options={state.providerOptions}
        serverId={serverId}
        loading={providersLoading}
        size={size}
        testID="goal-default-provider"
      />
      <Field label={t("goals.form.testCommandLabel")} hint={t("goals.form.testCommandHint")}>
        <FormTextInput
          size={size}
          testID="goal-test-command-input"
          accessibilityLabel={t("goals.form.testCommandLabel")}
          initialValue={values.testCommand}
          onChangeText={setTestCommand}
          placeholder={t("goals.form.optional")}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
      <StylePicker model={model} state={state} size={size} />
      <View style={styles.disclosure}>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={state.advancedExpanded ? ChevronDown : ChevronRight}
          onPress={toggleAdvanced}
          accessibilityState={advancedAccessibilityState}
          testID="goal-advanced-toggle"
        >
          {t("goals.form.advanced")}
        </Button>
      </View>
      {state.advancedExpanded ? (
        <GoalFormAdvanced
          model={model}
          state={state}
          serverId={serverId}
          providersLoading={providersLoading}
          size={size}
        />
      ) : null}
      <View style={styles.summary} testID="goal-settings-summary">
        <Text style={styles.summaryLabel}>{t("goals.form.summaryLabel")}</Text>
        <Text style={styles.summaryText}>{settingsSummaryText(t, state.summary)}</Text>
      </View>
    </>
  );
}

/** Which goal and commit the new goal builds on, with a way back to the project's HEAD. */
function BuildsOnNote({
  model,
  baseCommit,
}: {
  model: GoalFormModel;
  baseCommit: GoalFormBaseCommit;
}): ReactElement {
  const { t } = useTranslation();
  const clear = useCallback(() => model.clearBaseCommit(), [model]);
  const params = {
    title: baseCommit.goalTitle,
    commit: shortCommit(baseCommit.commit),
    branch: baseCommit.branch ?? "",
  };
  return (
    <View style={styles.buildsOn} testID="goal-form-builds-on">
      <Text style={styles.note}>
        {baseCommit.branch
          ? t("goals.form.buildsOnBranch", params)
          : t("goals.form.buildsOn", params)}
      </Text>
      <View style={styles.disclosure}>
        <Button variant="ghost" size="xs" onPress={clear} testID="goal-form-builds-on-clear">
          {t("goals.form.startFromHead")}
        </Button>
      </View>
    </View>
  );
}

/** Careful, Balanced, Turbo, your own last settings, and Custom once you edit any of them. */
function StylePicker({
  model,
  state,
  size,
}: {
  model: GoalFormModel;
  state: GoalFormState;
  size: FieldControlSize;
}): ReactElement {
  const { t } = useTranslation();
  const hasPersonal = state.personalSettings !== null;
  const isCustom = state.settingsChoice === "custom";
  const options = useMemo<SegmentedControlOption<GoalSettingsChoice>[]>(() => {
    const choices: GoalSettingsChoice[] = [...GOAL_PRESET_IDS];
    if (hasPersonal) {
      choices.push("mine");
    }
    if (isCustom) {
      choices.push("custom");
    }
    return choices.map((choice) => ({
      value: choice,
      label: t(`goals.form.presets.${choice}`),
      disabled: choice === "custom",
      testID: `goal-preset-${choice}`,
    }));
  }, [hasPersonal, isCustom, t]);
  const handleChange = useCallback(
    (choice: GoalSettingsChoice) => {
      if (choice !== "custom") {
        model.chooseSettings(choice);
      }
    },
    [model],
  );
  return (
    <Field
      label={t("goals.form.styleLabel")}
      hint={t(`goals.form.presetHints.${state.settingsChoice}`)}
    >
      <SegmentedControl
        options={options}
        value={state.settingsChoice}
        onValueChange={handleChange}
        size={size}
        testID="goal-preset"
      />
    </Field>
  );
}

function Outcome({ state }: { state: GoalFormState }): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.summary} testID="goal-outcome">
      <Text style={styles.summaryLabel}>{t("goals.form.outcomeLabel")}</Text>
      {state.outcome.map((step) => (
        <Text key={step} style={styles.summaryText}>
          {t(`goals.form.outcome.${step}`)}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  multilineInput: {
    minHeight: 96,
  },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  disclosure: {
    alignItems: "flex-start",
  },
  buildsOn: {
    gap: theme.spacing[1],
  },
  summary: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  summaryLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  summaryText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  footer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
  submitError: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
}));

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { Goal, GoalConfig } from "@getpaseo/protocol/goal/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import type { GoalBudgetKey, GoalNumberSetting, GoalPermissionPolicy } from "@/goals/goal-settings";
import {
  openGoalSettingsForm,
  type GoalSettingsEditField,
  type GoalSettingsFormModel,
  type GoalSettingsFormSnapshot,
  type GoalSettingsFormState,
} from "@/goals/goal-settings-form-model";
import { useGoalMutations } from "@/hooks/use-goal-mutations";
import { useHostFeature } from "@/runtime/host-features";
import { toErrorMessage } from "@/utils/error-messages";
import { SwitchSetting } from "./goal-form-fields";
import {
  GoalBudgetField,
  GoalNumberSettingField,
  GoalPermissionPolicyField,
  GoalSettingsGroup,
} from "./goal-settings-fields";

/** One model per mount (docs/forms.md); the goal's later configs arrive through applyConfig. */
function useGoalSettingsFormModel(
  snapshot: GoalSettingsFormSnapshot,
  config: GoalConfig,
): GoalSettingsFormModel {
  const [model] = useState(() => openGoalSettingsForm(snapshot));
  useEffect(() => () => model.close(), [model]);
  useEffect(() => {
    model.applyConfig(config);
  }, [config, model]);
  return model;
}

/**
 * Changes a managed goal's settings after it was created. Mount only while open, so every open
 * starts from the goal's current settings. Offered on hosts with `goalConfigEdit`.
 */
export function GoalSettingsSheet({
  serverId,
  goal,
  config,
  onClose,
}: {
  serverId: string;
  goal: Goal;
  config: GoalConfig;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const size: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  // An older daemon drops the caps silently, as on create.
  const budgetSupported = useHostFeature(serverId, "goalBudgets");
  const autoPermissionSupported = useHostFeature(serverId, "goalConfigEdit");
  // COMPAT(goalUserWait): added in v0.13.14, remove gate after 2027-10-28.
  const userWaitSupported = useHostFeature(serverId, "goalUserWait");
  const [snapshot] = useState<GoalSettingsFormSnapshot>(() => ({
    config,
    budgetSupported,
    autoPermissionSupported,
    userWaitSupported,
  }));
  const model = useGoalSettingsFormModel(snapshot, config);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const { updateConfig, isUpdatingConfig } = useGoalMutations({ serverId });
  const { canSave, changes } = state;

  const handleSave = useCallback(() => {
    if (!canSave || isUpdatingConfig) {
      return;
    }
    model.setSubmitError(null);
    updateConfig({ goalId: goal.id, changes })
      .then(() => {
        toast.show(t("goals.actions.settingsSaved"), { testID: "goal-settings-saved-toast" });
        return onClose();
      })
      .catch((error: unknown) => {
        const message = toErrorMessage(error);
        model.setSubmitError(message);
        toast.error(message);
      });
  }, [canSave, changes, goal.id, isUpdatingConfig, model, onClose, t, toast, updateConfig]);

  const header = useMemo<SheetHeader>(() => ({ title: t("goals.actions.settingsTitle") }), [t]);
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          style={styles.footerButton}
          variant="secondary"
          onPress={onClose}
          disabled={isUpdatingConfig}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={handleSave}
          disabled={!canSave}
          loading={isUpdatingConfig}
          testID="goal-settings-save"
        >
          {t("goals.actions.settingsSave")}
        </Button>
      </View>
    ),
    [canSave, handleSave, isUpdatingConfig, onClose, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      footer={footer}
      testID="goal-settings-sheet"
      desktopResizable
      desktopResizeInitialWidth={720}
      desktopResizeMaxWidth={960}
    >
      <Text style={styles.hint} testID="goal-settings-hint">
        {t("goals.actions.settingsHint")}
      </Text>
      <GoalSettingsFields model={model} state={state} size={size} />
      {state.submitError ? (
        <Text style={styles.error} testID="goal-settings-error">
          {state.submitError}
        </Text>
      ) : null}
    </AdaptiveModalSheet>
  );
}

interface FieldsProps {
  model: GoalSettingsFormModel;
  state: GoalSettingsFormState;
  size: FieldControlSize;
}

function GoalSettingsFields({ model, state, size }: FieldsProps): ReactElement {
  const { t } = useTranslation();
  const { settings, budget } = state.values;
  const setNumber = useCallback(
    (key: GoalNumberSetting, value: number) => model.setSetting(key, value),
    [model],
  );
  const setBudget = useCallback(
    (key: GoalBudgetKey, value: number | null) => model.setBudget(key, value),
    [model],
  );
  const setPermission = useCallback(
    (value: GoalPermissionPolicy) => model.setSetting("onPermissionRequest", value),
    [model],
  );
  const setRequireApproval = useCallback(
    (value: boolean) => model.setSetting("requireHumanApproval", value),
    [model],
  );
  const setAutoApprove = useCallback(
    (value: boolean) => model.setSetting("autoApprovePlan", value),
    [model],
  );
  const setNotifyLead = useCallback(
    (value: boolean) => model.setSetting("notifyLead", value),
    [model],
  );
  const errorOf = useCallback(
    (field: GoalSettingsEditField): string | null => {
      const issue = state.issues.find((candidate) => candidate.field === field);
      return issue ? t("goals.form.numberField.range", { min: issue.min, max: issue.max }) : null;
    },
    [state.issues, t],
  );
  const number = (setting: GoalNumberSetting) => (
    <GoalNumberSettingField
      setting={setting}
      value={settings[setting]}
      onChange={setNumber}
      error={errorOf(setting)}
      size={size}
    />
  );

  return (
    <View style={styles.container}>
      <GoalSettingsGroup title={t("goals.form.sections.safety")}>
        <GoalPermissionPolicyField
          value={settings.onPermissionRequest}
          options={state.policyOptions}
          onChange={setPermission}
          size={size}
        />
        <SwitchSetting
          label={t("goals.form.settings.requireHumanApproval.label")}
          hint={t("goals.form.settings.requireHumanApproval.hint")}
          value={settings.requireHumanApproval}
          onChange={setRequireApproval}
          testID="goal-require-approval-switch"
        />
        <SwitchSetting
          label={t("goals.form.settings.autoApprovePlan.label")}
          hint={t("goals.form.settings.autoApprovePlan.hint")}
          value={settings.autoApprovePlan}
          onChange={setAutoApprove}
          testID="goal-auto-approve-switch"
        />
        {number("maxReworkRounds")}
        <SwitchSetting
          label={t("goals.form.settings.notifyLead.label")}
          hint={t("goals.form.settings.notifyLead.hint")}
          value={settings.notifyLead}
          onChange={setNotifyLead}
          testID="goal-notify-lead-switch"
        />
        <TestCommandField model={model} initialValue={state.values.testCommand} size={size} />
      </GoalSettingsGroup>
      <GoalSettingsGroup title={t("goals.form.sections.team")}>
        {number("maxParallel")}
        {number("maxAttempts")}
        {number("maxTasks")}
        {number("maxRuns")}
      </GoalSettingsGroup>
      <GoalSettingsGroup title={t("goals.form.sections.time")}>
        {number("runTimeoutMinutes")}
        {number("goalTimeoutMinutes")}
        {number("retryBackoffSeconds")}
        {state.userWaitSupported ? number("userWaitMinutes") : null}
      </GoalSettingsGroup>
      {state.budgetSupported ? (
        <GoalSettingsGroup title={t("goals.form.sections.budget")}>
          <GoalBudgetField
            budgetKey="maxTotalTokens"
            value={budget.maxTotalTokens}
            onChange={setBudget}
            error={errorOf("maxTotalTokens")}
            size={size}
          />
          <GoalBudgetField
            budgetKey="maxCostUsd"
            value={budget.maxCostUsd}
            onChange={setBudget}
            error={errorOf("maxCostUsd")}
            size={size}
          />
        </GoalSettingsGroup>
      ) : null}
    </View>
  );
}

function TestCommandField({
  model,
  initialValue,
  size,
}: {
  model: GoalSettingsFormModel;
  initialValue: string;
  size: FieldControlSize;
}): ReactElement {
  const { t } = useTranslation();
  const handleChange = useCallback((value: string) => model.setTestCommand(value), [model]);
  return (
    <Field label={t("goals.form.testCommandLabel")} hint={t("goals.form.testCommandHint")}>
      <FormTextInput
        size={size}
        testID="goal-settings-test-command"
        accessibilityLabel={t("goals.form.testCommandLabel")}
        initialValue={initialValue}
        onChangeText={handleChange}
        placeholder={t("goals.form.optional")}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </Field>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[6],
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.palette.red[300],
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
}));

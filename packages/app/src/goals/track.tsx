import { useCallback, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import type { AgentGoal } from "@getpaseo/protocol/agent-types";
import { Pause, Play, Target, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { formatGoalDuration, goalActions, goalStatusKey, type GoalAction } from "./presentation";

export function GoalTrack({
  goal,
  onAction,
}: {
  goal: AgentGoal | null;
  onAction: (action: GoalAction) => Promise<void>;
}): ReactElement | null {
  const { t } = useTranslation();
  const [pendingAction, setPendingAction] = useState<GoalAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleAction = useCallback(
    (action: GoalAction) => {
      setPendingAction(action);
      setError(null);
      void onAction(action)
        .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
        .finally(() => setPendingAction(null));
    },
    [onAction],
  );

  if (!goal) return null;

  return (
    <View style={styles.root} testID="goal-track">
      <View style={styles.row}>
        <View style={styles.summary}>
          <ThemedTarget size={ICON_SIZE.xs} uniProps={iconForegroundMutedMapping} />
          <Text style={styles.status} numberOfLines={1}>
            {t(goalStatusKey(goal.status))}
          </Text>
          <Text style={styles.objective} numberOfLines={1} testID="goal-track-objective">
            {goal.objective}
          </Text>
          <Text style={styles.duration}>· {formatGoalDuration(goal.timeUsedSeconds)}</Text>
        </View>
        <View style={styles.actions}>
          {goalActions(goal).map((action) => (
            <GoalActionButton
              key={action}
              action={action}
              label={t(`goals.actions.${action}`)}
              pendingAction={pendingAction}
              onAction={handleAction}
            />
          ))}
        </View>
      </View>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert" testID="goal-track-error">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function GoalActionButton({
  action,
  label,
  pendingAction,
  onAction,
}: {
  action: GoalAction;
  label: string;
  pendingAction: GoalAction | null;
  onAction: (action: GoalAction) => void;
}): ReactElement {
  const handlePress = useCallback(() => onAction(action), [action, onAction]);
  let icon = ThemedTrash2;
  if (action === "pause") icon = ThemedPause;
  if (action === "resume") icon = ThemedPlay;
  return (
    <Button
      size="xs"
      variant="ghost"
      leftIcon={icon}
      disabled={pendingAction !== null}
      loading={pendingAction === action}
      accessibilityLabel={label}
      testID={`goal-track-${action}`}
      onPress={handlePress}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    paddingHorizontal: theme.spacing[2],
  },
  row: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  summary: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  status: {
    flexShrink: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  objective: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  duration: {
    flexShrink: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
  },
  error: {
    paddingBottom: theme.spacing[1],
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
}));

const ThemedTarget = withUnistyles(Target);
const ThemedPause = withUnistyles(Pause);
const ThemedPlay = withUnistyles(Play);
const ThemedTrash2 = withUnistyles(Trash2);
const iconForegroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { ChangeSet, ChangeSetStatus, Goal } from "@getpaseo/protocol/goal/types";
import { SettingsCard, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { visibleChangeSets } from "@/goals/goal-tasks";
import { useGoalMutations } from "@/hooks/use-goal-mutations";
import { settingsStyles } from "@/styles/settings";
import { toErrorMessage } from "@/utils/error-messages";
import { GoalFeedbackSheet } from "./goal-feedback-sheet";

const CHANGE_SET_BADGE: Record<ChangeSetStatus, StatusBadgeVariant> = {
  captured: "muted",
  in_review: "muted",
  awaiting_human: "warning",
  approved: "success",
  integrating: "muted",
  integrated: "success",
  changes_requested: "warning",
  conflicted: "warning",
  test_failed: "error",
  superseded: "muted",
  rejected: "error",
};

const FILES_COLLAPSED = 5;

/** Each change a task produced, with Approve and Request changes on the ones held for you. */
export function GoalChangeSetList({
  serverId,
  goal,
}: {
  serverId: string;
  goal: Goal;
}): ReactElement | null {
  const { t } = useTranslation();
  const changeSets = useMemo(() => visibleChangeSets(goal), [goal]);
  const { approveChangeSet, requestChanges, pendingChangeSetId } = useGoalMutations({ serverId });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [requesting, setRequesting] = useState<ChangeSet | null>(null);

  const setError = useCallback((changeSetId: string, message: string | null) => {
    setErrors((current) => {
      const { [changeSetId]: _previous, ...rest } = current;
      return message ? { ...rest, [changeSetId]: message } : rest;
    });
  }, []);

  const handleApprove = useCallback(
    (changeSet: ChangeSet) => {
      setError(changeSet.id, null);
      approveChangeSet({ goalId: goal.id, changeSetId: changeSet.id }).catch((error: unknown) =>
        setError(changeSet.id, toErrorMessage(error)),
      );
    },
    [approveChangeSet, goal.id, setError],
  );

  const handleSend = useCallback(
    (findings: string) => {
      if (!requesting) {
        return;
      }
      const changeSetId = requesting.id;
      setError(changeSetId, null);
      requestChanges({ goalId: goal.id, changeSetId, findings })
        .then(() => setRequesting(null))
        .catch((error: unknown) => setError(changeSetId, toErrorMessage(error)));
    },
    [goal.id, requestChanges, requesting, setError],
  );
  const closeSheet = useCallback(() => setRequesting(null), []);
  const requestCopy = useMemo(
    () => ({
      title: t("goals.detail.requestChangesTitle"),
      label: t("goals.detail.requestChangesLabel"),
      placeholder: t("goals.detail.requestChangesPlaceholder"),
      send: t("goals.detail.requestChangesSend"),
    }),
    [t],
  );

  if (changeSets.length === 0) {
    return null;
  }

  return (
    <SettingsSection title={t("goals.detail.changeSets")}>
      <SettingsCard testID="goal-change-sets">
        {changeSets.map((changeSet) => (
          <ChangeSetRow
            key={changeSet.id}
            goal={goal}
            changeSet={changeSet}
            isPending={pendingChangeSetId === changeSet.id}
            error={errors[changeSet.id] ?? null}
            onApprove={handleApprove}
            onRequestChanges={setRequesting}
          />
        ))}
      </SettingsCard>
      {requesting ? (
        <GoalFeedbackSheet
          copy={requestCopy}
          subject={taskTitle(goal, requesting)}
          isRequired
          testID="goal-request-changes"
          isSending={pendingChangeSetId === requesting.id}
          error={errors[requesting.id] ?? null}
          onSend={handleSend}
          onClose={closeSheet}
        />
      ) : null}
    </SettingsSection>
  );
}

function taskTitle(goal: Goal, changeSet: ChangeSet): string {
  return goal.tasks.find((task) => task.id === changeSet.taskId)?.title ?? changeSet.taskId;
}

function ChangeSetRow({
  goal,
  changeSet,
  isPending,
  error,
  onApprove,
  onRequestChanges,
}: {
  goal: Goal;
  changeSet: ChangeSet;
  isPending: boolean;
  error: string | null;
  onApprove: (changeSet: ChangeSet) => void;
  onRequestChanges: (changeSet: ChangeSet) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const isHeld = changeSet.status === "awaiting_human";
  const files = showAll ? changeSet.files : changeSet.files.slice(0, FILES_COLLAPSED);
  const hiddenCount = changeSet.files.length - FILES_COLLAPSED;
  const note = changeSet.error ?? changeSet.findings ?? changeSet.testSummary;
  const handleApprove = useCallback(() => onApprove(changeSet), [changeSet, onApprove]);
  const handleRequest = useCallback(
    () => onRequestChanges(changeSet),
    [changeSet, onRequestChanges],
  );
  const toggleFiles = useCallback(() => setShowAll((value) => !value), []);
  const fileSummary =
    changeSet.files.length === 0
      ? t("goals.detail.noFiles")
      : t("goals.detail.files", { n: changeSet.files.length });

  return (
    <View style={styles.row} testID={`goal-change-set-${changeSet.id}`}>
      <View style={styles.header}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{taskTitle(goal, changeSet)}</Text>
          <Text style={settingsStyles.rowHint}>{[fileSummary, changeSet.branch].join(" · ")}</Text>
        </View>
        <StatusBadge
          label={t(`goals.changeSetStatus.${changeSet.status}`)}
          variant={CHANGE_SET_BADGE[changeSet.status]}
        />
      </View>
      {files.length > 0 ? (
        <View style={styles.files}>
          {files.map((file) => (
            <View key={file.path} style={styles.file}>
              <Text style={styles.fileStatus}>{file.status}</Text>
              <Text style={styles.filePath} numberOfLines={1}>
                {file.path}
              </Text>
            </View>
          ))}
          {hiddenCount > 0 ? (
            <View style={styles.inlineAction}>
              <Button variant="ghost" size="xs" onPress={toggleFiles}>
                {showAll
                  ? t("goals.detail.showFewerFiles")
                  : t("goals.detail.showAllFiles", { n: changeSet.files.length })}
              </Button>
            </View>
          ) : null}
        </View>
      ) : null}
      {note ? (
        <Text style={settingsStyles.rowHint} numberOfLines={6}>
          {note}
        </Text>
      ) : null}
      {isHeld ? (
        <View style={styles.actions}>
          <Button
            variant="secondary"
            size="sm"
            onPress={handleApprove}
            loading={isPending}
            testID={`goal-change-set-approve-${changeSet.id}`}
          >
            {t("goals.detail.approveChange")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onPress={handleRequest}
            disabled={isPending}
            testID={`goal-change-set-request-${changeSet.id}`}
          >
            {t("goals.detail.requestChanges")}
          </Button>
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[3],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
  },
  files: {
    gap: theme.spacing[1],
  },
  file: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  fileStatus: {
    width: 16,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  filePath: {
    flex: 1,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  inlineAction: {
    alignItems: "flex-start",
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
}));

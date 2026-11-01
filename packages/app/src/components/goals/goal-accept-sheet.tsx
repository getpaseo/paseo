import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { MAX_ACCEPT_NOTE_CHARS, type Goal } from "@getpaseo/protocol/goal/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  acceptCriterionIds,
  acceptGroups,
  acceptNoteState,
  type AcceptGroup,
} from "@/goals/goal-accept";
import { useGoalDecisionMutations } from "@/hooks/use-goal-decision-mutations";
import { toErrorMessage } from "@/utils/error-messages";

/**
 * What an Accept sheet was opened for. Anything that takes Accept away (a recovery started
 * elsewhere, archive, the goal reopened or accepted) changes it, so the open sheet closes.
 */
function acceptSheetKey(goal: Goal): string {
  return [goal.status, goal.recovery?.id ?? "", goal.archivedAt ?? ""].join(":");
}

/**
 * Accept as is, with the sheet it opens. Render it only when `canAccept` holds for the goal on
 * its host: a failed goal whose work all merged but whose criteria were not all verified.
 */
export function GoalAcceptButton({
  serverId,
  goal,
}: {
  serverId: string;
  goal: Goal;
}): ReactElement {
  const { t } = useTranslation();
  const key = acceptSheetKey(goal);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = useCallback(() => setOpenFor(key), [key]);
  const close = useCallback(() => setOpenFor(null), []);
  return (
    <>
      <Button size="sm" variant="outline" onPress={open} testID="goal-accept">
        {t("goals.accept.button")}
      </Button>
      {openFor === key ? <GoalAcceptSheet serverId={serverId} goal={goal} onClose={close} /> : null}
    </>
  );
}

/** What the sheet reads once, when it opens: later pushes do not move what you confirm. */
interface AcceptSeed {
  groups: AcceptGroup[];
  criterionIds: string[];
  /** One id per open: a retry after an error, or a second tap, is the same accept to the host. */
  eventId: string;
}

/**
 * Completes a failed goal with its unverified criteria waived, after you say why. Mount only
 * while open, so every open lists the goal's current criteria.
 */
function GoalAcceptSheet({
  serverId,
  goal,
  onClose,
}: {
  serverId: string;
  goal: Goal;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const { acceptGoal, isAcceptingGoal } = useGoalDecisionMutations({ serverId });
  const [seed] = useState<AcceptSeed>(() => ({
    groups: acceptGroups(goal),
    criterionIds: acceptCriterionIds(goal),
    eventId: crypto.randomUUID(),
  }));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const noteState = acceptNoteState(note);

  // A host error is about what was sent; changing the note makes it stale.
  const changeNote = useCallback((text: string) => {
    setError(null);
    setNote(text);
  }, []);
  const handleConfirm = useCallback(() => {
    if (isAcceptingGoal || !acceptNoteState(note).canConfirm) {
      return;
    }
    setError(null);
    acceptGoal({
      goalId: goal.id,
      criterionIds: seed.criterionIds,
      note: note.trim(),
      eventId: seed.eventId,
    })
      .then(onClose)
      .catch((cause: unknown) => setError(toErrorMessage(cause)));
  }, [acceptGoal, goal.id, isAcceptingGoal, note, onClose, seed]);

  const header = useMemo<SheetHeader>(
    () => ({
      title: t("goals.accept.sheetTitle"),
      subtitle: (
        <Text style={styles.subtitle} numberOfLines={1}>
          {goal.title}
        </Text>
      ),
    }),
    [goal.title, t],
  );
  const canConfirm = noteState.canConfirm && !isAcceptingGoal;
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button style={styles.footerButton} variant="secondary" onPress={onClose}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          style={styles.footerButton}
          variant="destructive"
          onPress={handleConfirm}
          disabled={!canConfirm}
          loading={isAcceptingGoal}
          testID="goal-accept-confirm"
        >
          {t("goals.accept.confirm")}
        </Button>
      </View>
    ),
    [canConfirm, handleConfirm, isAcceptingGoal, onClose, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      footer={footer}
      testID="goal-accept-sheet"
    >
      <View style={styles.body}>
        {/* Nothing to waive when every criterion was verified; the goal still completes. */}
        <Text style={styles.message} testID="goal-accept-explain">
          {t(seed.groups.length > 0 ? "goals.accept.explain" : "goals.accept.explainNothingWaived")}
        </Text>
        {seed.groups.map((group) => (
          <View key={group.kind} style={styles.group} testID={`goal-accept-group-${group.kind}`}>
            <Text style={styles.groupLabel}>{t(`goals.accept.${group.kind}`)}</Text>
            {group.criteria.map((criterion) => (
              <Text key={criterion.id} style={styles.criterion}>
                {t("goals.failure.listItem", { text: criterion.text })}
              </Text>
            ))}
          </View>
        ))}
        <Field
          label={t("goals.accept.noteLabel")}
          error={
            noteState.tooLong ? t("goals.accept.noteTooLong", { max: MAX_ACCEPT_NOTE_CHARS }) : null
          }
        >
          <FormTextInput
            size={size}
            testID="goal-accept-note"
            accessibilityLabel={t("goals.accept.noteLabel")}
            initialValue=""
            onChangeText={changeNote}
            style={styles.input}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
          />
        </Field>
        {/* The host's answer to Confirm; a note problem shows under the field instead. */}
        {error ? (
          <Text style={styles.error} testID="goal-accept-error">
            {error}
          </Text>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
  },
  message: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  group: {
    gap: theme.spacing[1],
  },
  groupLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  criterion: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  input: {
    minHeight: 96,
  },
  footer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
}));

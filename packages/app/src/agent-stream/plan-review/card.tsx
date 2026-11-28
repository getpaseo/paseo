import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Ellipsis, MessageSquarePlus, Trash2 } from "lucide-react-native";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { PlanCard } from "@/components/plan-card";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { TOUCH_TARGET } from "@/components/ui/control-geometry";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import type { MenuTriggerState } from "@/components/ui/menu";
import { useIsCompactFormFactor } from "@/constants/layout";
import { openPlanReview, type PlanComment } from "./model";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { PlanReviewSource } from "./source";
import type { PendingPermission } from "@/types/shared";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const OverflowIcon = withUnistyles(Ellipsis);
const overflowIconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function ACPPlanReviewCard({
  permission,
  client,
  model,
}: {
  permission: PendingPermission;
  client: DaemonClient | null;
  model: ReturnType<typeof openPlanReview>;
}) {
  const { t } = useTranslation();
  const planValue = permission.request.metadata?.planText;
  const plan = typeof planValue === "string" ? planValue : "";
  const draft = useSyncExternalStore(model.subscribe, model.getState);
  const { hasPlan, lines } = model;
  const commentInput = useRef<EditingTextInputHandle>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const focusComment = useCallback(() => setFocusRequest((value) => value + 1), []);
  useEffect(() => {
    if (focusRequest > 0) commentInput.current?.focus();
  }, [focusRequest]);
  const isCompact = useIsCompactFormFactor();
  const size = isCompact ? "md" : "sm";
  const mutation = useMutation({
    mutationFn: async (response: AgentPermissionResponse) => {
      if (!client) throw new Error(t("common.errors.daemonClientUnavailable"));
      await client.respondToPermissionAndWait(
        permission.agentId,
        permission.request.id,
        response,
        15000,
      );
    },
  });
  const pending = mutation.isPending;
  const { hasFeedback } = draft;
  const lineTarget = hasPlan && draft.commentTarget === "lines";
  const inputLabel = lineTarget ? t("planReview.comment") : t("planReview.feedback");
  const rangeLabel = t("planReview.lineRange", { start: draft.start, end: draft.end });
  const wholePlanLabel = t("planReview.wholePlan");
  const targetOptions = useMemo<SegmentedControlOption<"plan" | "lines">[]>(() => {
    const options: SegmentedControlOption<"plan" | "lines">[] = [
      { value: "plan", label: wholePlanLabel, disabled: pending },
    ];
    if (hasPlan) options.push({ value: "lines", label: rangeLabel, disabled: pending });
    return options;
  }, [hasPlan, pending, rangeLabel, wholePlanLabel]);
  let error: string | null = null;
  if (draft.error) error = t(`planReview.${draft.error}`, { count: lines.length });
  else if (mutation.isError) error = t("planReview.responseFailed");

  const { mutate } = mutation;
  const requestChanges = useCallback(() => {
    const response = model.requestChanges();
    if (response) mutate(response);
  }, [model, mutate]);
  const approve = useCallback(
    () => mutate({ behavior: "allow", selectedActionId: "approve" }),
    [mutate],
  );
  const abandon = useCallback(
    () => mutate({ behavior: "deny", selectedActionId: "abandon" }),
    [mutate],
  );
  const setText = useCallback((value: string) => model.setField("text", value), [model]);
  const setFeedback = useCallback((value: string) => model.setField("feedback", value), [model]);
  const selectTarget = useCallback(
    (target: "plan" | "lines") => {
      model.setCommentTarget(target);
      focusComment();
    },
    [model, focusComment],
  );

  const actionsDisabled = pending || !client;
  const approveDisabled = actionsDisabled || !hasPlan || hasFeedback;
  const footer = useMemo(
    () => (
      <View style={styles.form}>
        {!hasPlan ? <Text style={styles.label}>{t("planReview.missingPlan")}</Text> : null}
        {draft.comments.map((comment) => (
          <PlanCommentRow
            key={comment.id}
            comment={comment}
            model={model}
            pending={pending}
            size={size}
          />
        ))}
        <View style={isCompact ? styles.compactBar : styles.bar} testID="plan-review-bar">
          <SegmentedControl
            options={targetOptions}
            value={lineTarget ? "lines" : "plan"}
            onValueChange={selectTarget}
            size={size}
            style={styles.target}
            testID="plan-review-target"
          />
          <View style={[styles.row, isCompact ? null : styles.desktopComposer]}>
            <View style={[styles.input, isCompact ? null : styles.desktopInput]}>
              <FormTextInput
                ref={commentInput}
                key={lineTarget ? `lines-${draft.nextId}` : "plan"}
                accessibilityLabel={inputLabel}
                placeholder={isCompact ? inputLabel : undefined}
                initialValue={lineTarget ? draft.text : draft.feedback}
                editable={!pending}
                onChangeText={lineTarget ? setText : setFeedback}
                onSubmitEditing={lineTarget ? model.addComment : requestChanges}
                size={size}
                testID="plan-review-comment"
              />
            </View>
            {lineTarget ? (
              <Button
                size={size}
                variant="outline"
                leftIcon={isCompact ? MessageSquarePlus : undefined}
                accessibilityLabel={t("planReview.addComment")}
                onPress={model.addComment}
                disabled={pending}
                testID="plan-review-add-comment"
              >
                {isCompact ? null : t("planReview.addComment")}
              </Button>
            ) : null}
          </View>
          <PlanReviewActions
            isCompact={isCompact}
            pending={pending}
            disabled={actionsDisabled}
            approveDisabled={approveDisabled}
            requestChanges={requestChanges}
            approve={approve}
            abandon={abandon}
          />
        </View>
        {hasPlan && hasFeedback ? (
          <Text style={styles.label} testID="plan-review-approval-hint">
            {t("planReview.feedbackBeforeApproval")}
          </Text>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error} testID="plan-review-error">
            {error}
          </Text>
        ) : null}
      </View>
    ),
    [
      hasPlan,
      hasFeedback,
      draft,
      model,
      pending,
      size,
      isCompact,
      inputLabel,
      t,
      targetOptions,
      selectTarget,
      lineTarget,
      setText,
      setFeedback,
      requestChanges,
      actionsDisabled,
      approveDisabled,
      abandon,
      approve,
      error,
    ],
  );
  const content = useMemo(
    () =>
      hasPlan ? (
        <PlanReviewSource model={model} disabled={pending} onComment={focusComment} />
      ) : null,
    [hasPlan, model, pending, focusComment],
  );

  return (
    <PlanCard
      title={t("agentStream.permission.plan")}
      text={plan}
      outcome="pending"
      content={content}
      footer={footer}
      testID="permission-plan-card"
      disableOuterSpacing
    />
  );
}

function PlanReviewActions({
  isCompact,
  pending,
  disabled,
  approveDisabled,
  requestChanges,
  approve,
  abandon,
}: {
  isCompact: boolean;
  pending: boolean;
  disabled: boolean;
  approveDisabled: boolean;
  requestChanges: () => void;
  approve: () => void;
  abandon: () => void;
}) {
  const { t } = useTranslation();
  const overflowStyle = useCallback(
    ({ hovered, pressed, open }: MenuTriggerState) => [
      styles.overflow,
      (hovered || pressed || open) && styles.overflowActive,
      disabled && styles.overflowDisabled,
    ],
    [disabled],
  );

  return (
    <View style={[styles.row, isCompact ? styles.compactActions : styles.actions]}>
      {!isCompact ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onPress={abandon}
          testID="plan-review-abandon"
        >
          {t("planReview.abandon")}
        </Button>
      ) : null}
      <Button
        size="sm"
        style={isCompact ? styles.compactAction : undefined}
        textStyle={isCompact ? styles.compactActionText : undefined}
        variant="outline"
        disabled={disabled}
        onPress={requestChanges}
        testID="plan-review-request-changes"
      >
        {t(pending ? "planReview.submitting" : "planReview.requestChanges")}
      </Button>
      <Button
        size="sm"
        style={isCompact ? styles.compactAction : undefined}
        textStyle={isCompact ? styles.compactActionText : undefined}
        disabled={approveDisabled}
        onPress={approve}
        testID="plan-review-approve"
      >
        {t("planReview.approve")}
      </Button>
      {isCompact ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            accessibilityRole="button"
            accessibilityLabel={t("workspace.git.actions.moreActions")}
            disabled={disabled}
            style={overflowStyle}
            testID="plan-review-more-actions"
          >
            <OverflowIcon size={ICON_SIZE.md} uniProps={overflowIconColor} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              destructive
              disabled={disabled}
              onSelect={abandon}
              testID="plan-review-abandon"
            >
              {t("planReview.abandon")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </View>
  );
}

function PlanCommentRow({
  comment,
  model,
  pending,
  size,
}: {
  comment: PlanComment;
  model: ReturnType<typeof openPlanReview>;
  pending: boolean;
  size: "sm" | "md";
}) {
  const { t } = useTranslation();
  const label = t("planReview.lineRange", { start: comment.start, end: comment.end });
  const edit = useCallback(
    (text: string) => model.editComment(comment.id, text),
    [model, comment.id],
  );
  const remove = useCallback(() => model.removeComment(comment.id), [model, comment.id]);
  const isCompact = size === "md";
  return (
    <View style={isCompact ? styles.savedComment : styles.bar}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.row, isCompact ? null : styles.desktopComposer]}>
        <View style={[styles.input, isCompact ? null : styles.desktopInput]}>
          <FormTextInput
            accessibilityLabel={label}
            initialValue={comment.text}
            editable={!pending}
            onChangeText={edit}
            size={size}
          />
        </View>
        <Button
          size={size}
          variant="ghost"
          leftIcon={isCompact ? Trash2 : undefined}
          accessibilityLabel={t("planReview.removeComment")}
          onPress={remove}
          disabled={pending}
        >
          {isCompact ? null : t("planReview.removeComment")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  form: { gap: theme.spacing[2] },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  bar: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[2] },
  compactBar: { gap: theme.spacing[2] },
  target: { alignSelf: "flex-start", maxWidth: "100%" },
  savedComment: { gap: theme.spacing[1] },
  desktopComposer: { flexGrow: 1, flexShrink: 1 },
  input: { flex: 1, minWidth: 0 },
  desktopInput: { flexBasis: 120 },
  actions: {
    flexWrap: "wrap",
    flexShrink: 1,
    maxWidth: "100%",
    justifyContent: "flex-end",
    marginLeft: "auto",
  },
  compactActions: { alignItems: "stretch" },
  compactAction: { flex: 1, minWidth: TOUCH_TARGET, minHeight: TOUCH_TARGET },
  compactActionText: { flexShrink: 1, textAlign: "center" },
  overflow: {
    width: TOUCH_TARGET,
    minHeight: TOUCH_TARGET,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
  },
  overflowActive: { backgroundColor: theme.colors.interactionHighlight },
  overflowDisabled: { opacity: theme.opacity[50] },
  label: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));

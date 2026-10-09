import { useCallback, useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { Send } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useMenuContext } from "@/components/ui/menu";
import { Button } from "@/components/ui/button";
import { buttonControlHeight } from "@/components/ui/control-geometry";
import { useIsCompactFormFactor } from "@/constants/layout";
import { SPACING } from "@/styles/theme";
import { FloatingActionButton } from "@/components/ui/floating-action-button";
import {
  WorkspaceTabPresentationResolver,
  WorkspaceTabIcon,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import type { FeedbackRecipient, ReviewFeedbackState, createReviewFeedback } from "./index";

type FeedbackModel = ReturnType<typeof createReviewFeedback>;
interface ReviewFeedbackActionProps {
  bottomOffset: number;
  model: FeedbackModel;
  state: ReviewFeedbackState;
  serverId: string;
  workspaceId: string;
}

export function ReviewFeedbackAction({
  enabled,
  hasDiff,
  ...props
}: Omit<ReviewFeedbackActionProps, "workspaceId"> & {
  workspaceId?: string | null;
  enabled: boolean | undefined;
  hasDiff: boolean;
}) {
  if (enabled === false || !hasDiff) return null;
  return <OpenReviewFeedbackAction {...props} workspaceId={props.workspaceId ?? ""} />;
}

function OpenReviewFeedbackAction({
  model,
  state,
  serverId,
  workspaceId,
  bottomOffset,
}: ReviewFeedbackActionProps) {
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open) model.closeMenu();
    },
    [model],
  );
  const noteStyle = useMemo(
    () => [
      styles.note,
      !isCompact && styles.centered,
      {
        bottom:
          bottom +
          bottomOffset +
          (isCompact ? 88 : buttonControlHeight.sm + SPACING[4] + SPACING[2]),
      },
    ],
    [bottom, bottomOffset, isCompact],
  );
  const sending = state.phase.kind === "sending";
  const label = t(sending ? "review.feedback.sending" : "review.feedback.send", {
    count: state.phase.kind === "sending" ? state.phase.commentCount : state.sendableCommentCount,
  });
  const unavailableNotice =
    state.disabledReason && state.commentCount > 0 ? (
      <Text style={styles.text}>{t(`review.feedback.${state.disabledReason}`)}</Text>
    ) : null;
  let notice: ReactNode = unavailableNotice;
  if (state.phase.kind === "failed")
    notice = <Text style={styles.error}>{state.phase.message}</Text>;
  else if (state.phase.kind === "sent")
    notice = (
      <>
        <SentNotice
          recipient={state.phase.recipient}
          serverId={serverId}
          workspaceId={workspaceId}
        />
        {unavailableNotice}
      </>
    );
  return (
    <>
      {state.commentCount > 0 ? (
        <DropdownMenu
          open={state.phase.kind === "choosing"}
          onOpenChange={onOpenChange}
          compactMode="sheet"
        >
          <FeedbackTrigger
            model={model}
            label={label}
            disabled={!state.canSend}
            bottomInset={bottom + bottomOffset}
          />
          <DropdownMenuContent
            side="top"
            align="center"
            sheetTitle={t("review.feedback.chooseAgent")}
          >
            {state.recipients.map((recipient) => (
              <RecipientOption
                key={recipient.tab.key}
                recipient={recipient}
                model={model}
                serverId={serverId}
                workspaceId={workspaceId}
              />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {notice ? (
        <View style={noteStyle} accessibilityRole="alert">
          {notice}
        </View>
      ) : null}
    </>
  );
}

function FeedbackTrigger({
  model,
  label,
  disabled,
  bottomInset,
}: {
  model: FeedbackModel;
  label: string;
  disabled: boolean;
  bottomInset: number;
}) {
  const { triggerRef } = useMenuContext("FeedbackTrigger");
  const isCompact = useIsCompactFormFactor();
  const press = useCallback(() => {
    void model.press();
  }, [model]);
  if (!isCompact) {
    return (
      <View
        pointerEvents="box-none"
        style={[styles.wideAction, { bottom: bottomInset + SPACING[4] }]}
      >
        <Button
          ref={triggerRef}
          variant="default"
          size="sm"
          leftIcon={Send}
          accessibilityLabel={label}
          disabled={disabled}
          onPress={press}
        >
          {label}
        </Button>
      </View>
    );
  }
  return (
    <FloatingActionButton
      ref={triggerRef}
      icon={Send}
      label={label}
      accessibilityLabel={label}
      disabled={disabled}
      bottomInset={bottomInset}
      onPress={press}
    />
  );
}

function RecipientOption({
  recipient,
  model,
  serverId,
  workspaceId,
}: {
  recipient: FeedbackRecipient;
  model: FeedbackModel;
  serverId: string;
  workspaceId: string;
}) {
  const choose = useCallback(() => {
    void model.send(recipient.agentId);
  }, [model, recipient.agentId]);
  const render = useCallback(
    (presentation: WorkspaceTabPresentation) => (
      <RecipientRow presentation={presentation} onSelect={choose} />
    ),
    [choose],
  );
  return (
    <WorkspaceTabPresentationResolver
      tab={recipient.tab}
      serverId={serverId}
      workspaceId={workspaceId}
    >
      {render}
    </WorkspaceTabPresentationResolver>
  );
}

function RecipientRow({
  presentation,
  onSelect,
}: {
  presentation: WorkspaceTabPresentation;
  onSelect: () => void;
}) {
  const leading = useMemo(
    () => <WorkspaceTabIcon presentation={presentation} backdrop="surface0" />,
    [presentation],
  );
  return (
    <DropdownMenuItem leading={leading} onSelect={onSelect}>
      {presentation.label}
    </DropdownMenuItem>
  );
}

function SentNotice({
  recipient,
  serverId,
  workspaceId,
}: {
  recipient: FeedbackRecipient;
  serverId: string;
  workspaceId: string;
}) {
  const { t } = useTranslation();
  const render = useCallback(
    (presentation: WorkspaceTabPresentation) => (
      <Text style={styles.text}>
        {t("review.feedback.sent", { recipient: presentation.label })}
      </Text>
    ),
    [t],
  );
  return (
    <WorkspaceTabPresentationResolver
      tab={recipient.tab}
      serverId={serverId}
      workspaceId={workspaceId}
    >
      {render}
    </WorkspaceTabPresentationResolver>
  );
}

const styles = StyleSheet.create((theme) => ({
  wideAction: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  centered: { alignItems: "center" },
  note: {
    position: "absolute",
    right: theme.spacing[4],
    left: theme.spacing[4],
    alignItems: "flex-end",
  },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
}));

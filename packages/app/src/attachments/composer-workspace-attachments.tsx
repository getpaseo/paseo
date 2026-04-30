import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { CircleDot } from "lucide-react-native";
import type {
  ComposerAttachment,
  UserComposerAttachment,
  WorkspaceComposerAttachment,
} from "@/attachments/types";
import { AttachmentPill } from "@/components/attachment-pill";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { AgentAttachment } from "@server/shared/messages";
import { useClearReviewDraft } from "@/review/store";

interface WorkspaceAttachmentBindingInput {
  normalAttachments: UserComposerAttachment[];
  workspaceAttachments: readonly WorkspaceComposerAttachment[];
  onOpenWorkspaceAttachment?: (attachment: WorkspaceComposerAttachment) => void;
}

interface RemoveWorkspaceAttachmentInput {
  selectedAttachments: readonly ComposerAttachment[];
  index: number;
}

interface OpenWorkspaceAttachmentInput {
  attachment: ComposerAttachment;
}

interface CompleteSubmitInput {
  result: "noop" | "queued" | "submitted" | "failed";
  outgoingAttachments: readonly ComposerAttachment[];
}

interface ComposerWorkspaceAttachmentBinding {
  selectedAttachments: ComposerAttachment[];
  buildOutgoingAttachments: (normalAttachments: UserComposerAttachment[]) => ComposerAttachment[];
  removeAttachment: (input: RemoveWorkspaceAttachmentInput) => boolean;
  openAttachment: (input: OpenWorkspaceAttachmentInput) => boolean;
  clearSentAttachments: (attachments: readonly ComposerAttachment[]) => void;
  completeSubmit: (input: CompleteSubmitInput) => void;
  resetSuppression: () => void;
}

function getAttachmentKey(attachment: WorkspaceComposerAttachment): string {
  return JSON.stringify({
    type: "review",
    cwd: attachment.attachment.cwd,
    mode: attachment.attachment.mode,
    baseRef: attachment.attachment.baseRef ?? null,
    reviewDraftKey: attachment.reviewDraftKey,
    comments: attachment.attachment.comments.map((comment) => ({
      filePath: comment.filePath,
      side: comment.side,
      lineNumber: comment.lineNumber,
      body: comment.body,
    })),
  });
}

function isWorkspaceAttachment(
  attachment: ComposerAttachment | undefined,
): attachment is WorkspaceComposerAttachment {
  return attachment?.kind === "review";
}

function userAttachmentsOnly(attachments: readonly ComposerAttachment[]): UserComposerAttachment[] {
  return attachments.filter(
    (attachment): attachment is UserComposerAttachment => attachment.kind !== "review",
  );
}

function toSubmitAttachment(attachment: ComposerAttachment): AgentAttachment | null {
  return isWorkspaceAttachment(attachment) ? attachment.attachment : null;
}

function renderPill(args: RenderWorkspaceAttachmentPillArgs): ReactElement {
  return (
    <WorkspaceAttachmentPill
      key={`workspace:${args.attachment.attachment.cwd}:${args.attachment.attachment.mode}`}
      {...args}
      attachment={args.attachment}
    />
  );
}

function useWorkspaceAttachmentBinding({
  normalAttachments,
  workspaceAttachments,
  onOpenWorkspaceAttachment,
}: WorkspaceAttachmentBindingInput): ComposerWorkspaceAttachmentBinding {
  const clearReviewDraft = useClearReviewDraft();
  const [suppressedKeys, setSuppressedKeys] = useState<readonly string[]>([]);
  const workspaceAttachmentKeys = useMemo(
    () => workspaceAttachments.map(getAttachmentKey),
    [workspaceAttachments],
  );
  const activeWorkspaceAttachments = useMemo(
    () =>
      workspaceAttachments.filter(
        (attachment, index) => !suppressedKeys.includes(workspaceAttachmentKeys[index] ?? ""),
      ),
    [suppressedKeys, workspaceAttachmentKeys, workspaceAttachments],
  );

  const selectedAttachments = useMemo<ComposerAttachment[]>(
    () =>
      activeWorkspaceAttachments.length > 0
        ? [...normalAttachments, ...activeWorkspaceAttachments]
        : normalAttachments,
    [activeWorkspaceAttachments, normalAttachments],
  );

  useEffect(() => {
    setSuppressedKeys((current) =>
      current.filter((suppressedKey) => workspaceAttachmentKeys.includes(suppressedKey)),
    );
  }, [workspaceAttachmentKeys]);

  const buildOutgoingAttachments = useCallback(
    (attachments: UserComposerAttachment[]): ComposerAttachment[] =>
      activeWorkspaceAttachments.length > 0
        ? [...attachments, ...activeWorkspaceAttachments]
        : attachments,
    [activeWorkspaceAttachments],
  );

  const suppressWorkspaceAttachment = useCallback((attachment: WorkspaceComposerAttachment) => {
    const key = getAttachmentKey(attachment);
    setSuppressedKeys((current) => (current.includes(key) ? current : [...current, key]));
  }, []);

  const clearSentAttachments = useCallback(
    (attachments: readonly ComposerAttachment[]) => {
      for (const attachment of attachments) {
        if (isWorkspaceAttachment(attachment)) {
          clearReviewDraft({ key: attachment.reviewDraftKey });
        }
      }
    },
    [clearReviewDraft],
  );

  const removeAttachment = useCallback(
    ({ selectedAttachments: current, index }: RemoveWorkspaceAttachmentInput) => {
      const selected = current[index];
      if (isWorkspaceAttachment(selected)) {
        suppressWorkspaceAttachment(selected);
        return true;
      }
      return false;
    },
    [suppressWorkspaceAttachment],
  );

  const openAttachment = useCallback(
    ({ attachment }: OpenWorkspaceAttachmentInput) => {
      if (!isWorkspaceAttachment(attachment)) {
        return false;
      }
      onOpenWorkspaceAttachment?.(attachment);
      return true;
    },
    [onOpenWorkspaceAttachment],
  );

  const resetSuppression = useCallback(() => {
    setSuppressedKeys([]);
  }, []);

  const completeSubmit = useCallback(
    ({ result, outgoingAttachments }: CompleteSubmitInput) => {
      if (result === "submitted") {
        clearSentAttachments(outgoingAttachments);
      }
      if (result === "queued" || result === "submitted") {
        resetSuppression();
      }
    },
    [clearSentAttachments, resetSuppression],
  );

  return {
    selectedAttachments,
    buildOutgoingAttachments,
    removeAttachment,
    openAttachment,
    clearSentAttachments,
    completeSubmit,
    resetSuppression,
  };
}

interface RenderWorkspaceAttachmentPillArgs {
  attachment: WorkspaceComposerAttachment;
  index: number;
  disabled: boolean;
  onOpen: (attachment: ComposerAttachment) => void;
  onRemove: (index: number) => void;
}

interface WorkspaceAttachmentPillProps extends Omit<
  RenderWorkspaceAttachmentPillArgs,
  "attachment"
> {
  attachment: WorkspaceComposerAttachment;
}

function WorkspaceAttachmentPill({
  attachment,
  index,
  disabled,
  onOpen,
  onRemove,
}: WorkspaceAttachmentPillProps) {
  const label =
    attachment.commentCount === 1
      ? "Review · 1 comment"
      : `Review · ${attachment.commentCount} comments`;
  const handleOpen = useCallback(() => {
    onOpen(attachment);
  }, [onOpen, attachment]);
  const handleRemove = useCallback(() => {
    onRemove(index);
  }, [onRemove, index]);
  return (
    <AttachmentPill
      testID="composer-review-attachment-pill"
      onOpen={handleOpen}
      onRemove={handleRemove}
      openAccessibilityLabel="Open review attachment"
      removeAccessibilityLabel="Remove review attachment"
      disabled={disabled}
    >
      <View style={styles.pillBody}>
        <View style={styles.pillIcon}>
          <ThemedCircleDot size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
        </View>
        <Text style={styles.pillText} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </AttachmentPill>
  );
}

export const composerWorkspaceAttachment = {
  is: isWorkspaceAttachment,
  renderPill,
  toSubmitAttachment,
  userAttachmentsOnly,
  useBinding: useWorkspaceAttachmentBinding,
};

const styles = StyleSheet.create((theme: Theme) => ({
  pillBody: {
    minHeight: 48,
    maxWidth: 260,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  pillIcon: {
    width: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  pillText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
})) as unknown as Record<string, object>;

const ThemedCircleDot = withUnistyles(CircleDot);
const iconForegroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

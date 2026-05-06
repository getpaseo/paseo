import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MessageSquareCode, MousePointer2 } from "lucide-react-native";
import type {
  ComposerAttachment,
  UserComposerAttachment,
  WorkspaceComposerAttachment,
} from "@/attachments/types";
import { AttachmentPill } from "@/components/attachment-pill";
import { useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import {
  isWorkspaceAttachment,
  userAttachmentsOnly,
  workspaceAttachmentToSubmitAttachment,
} from "@/attachments/workspace-attachment-utils";
import { ICON_SIZE, type Theme } from "@/styles/theme";
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
  if (attachment.kind === "browser_element") {
    return JSON.stringify({
      type: "browser_element",
      url: attachment.attachment.url,
      selector: attachment.attachment.selector,
      tag: attachment.attachment.tag,
      text: attachment.attachment.text,
      html: attachment.attachment.outerHTML,
    });
  }
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

function renderPill(args: RenderWorkspaceAttachmentPillArgs): ReactElement {
  return (
    <WorkspaceAttachmentPill
      key={`workspace:${getAttachmentKey(args.attachment)}`}
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
  const setWorkspaceAttachments = useWorkspaceAttachmentsStore(
    (state) => state.setWorkspaceAttachments,
  );
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
    setSuppressedKeys((current) => {
      const next = current.filter((suppressedKey) =>
        workspaceAttachmentKeys.includes(suppressedKey),
      );
      return next.length === current.length ? current : next;
    });
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
        if (attachment.kind === "review") {
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
        if (selected.kind === "browser_element") {
          const selectedKey = getAttachmentKey(selected);
          const { attachmentsByScope } = useWorkspaceAttachmentsStore.getState();
          for (const [scopeKey, attachments] of Object.entries(attachmentsByScope)) {
            const nextAttachments = attachments.filter(
              (attachment) => getAttachmentKey(attachment) !== selectedKey,
            );
            if (nextAttachments.length !== attachments.length) {
              setWorkspaceAttachments({ scopeKey, attachments: nextAttachments });
            }
          }
          return true;
        }
        suppressWorkspaceAttachment(selected);
        return true;
      }
      return false;
    },
    [setWorkspaceAttachments, suppressWorkspaceAttachment],
  );

  const openAttachment = useCallback(
    ({ attachment }: OpenWorkspaceAttachmentInput) => {
      if (!isWorkspaceAttachment(attachment) || attachment.kind !== "review") {
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
  let label: string;
  if (attachment.kind === "browser_element") {
    label = `Element · ${attachment.attachment.tag}`;
  } else {
    label =
      attachment.commentCount === 1
        ? "Review · 1 comment"
        : `Review · ${attachment.commentCount} comments`;
  }
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
      openAccessibilityLabel={
        attachment.kind === "browser_element"
          ? "Open browser element attachment"
          : "Open review attachment"
      }
      removeAccessibilityLabel={
        attachment.kind === "browser_element"
          ? "Remove browser element attachment"
          : "Remove review attachment"
      }
      disabled={disabled}
    >
      <View style={styles.pillBody}>
        <View style={styles.pillIcon}>
          {attachment.kind === "browser_element" ? (
            <ThemedMousePointer2 size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
          ) : (
            <ThemedMessageSquareCode size={ICON_SIZE.sm} uniProps={iconForegroundMutedMapping} />
          )}
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
  toSubmitAttachment: workspaceAttachmentToSubmitAttachment,
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

const ThemedMousePointer2 = withUnistyles(MousePointer2);
const ThemedMessageSquareCode = withUnistyles(MessageSquareCode);
const iconForegroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

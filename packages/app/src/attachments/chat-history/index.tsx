import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ArrowUpRight } from "lucide-react-native";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import { getAgentAttachmentPillContent } from "@/attachments/attachment-pill-content";
import { AttachmentFrame, AttachmentLabel, AttachmentPill } from "@/components/attachment-pill";
import { AdaptiveModalSheet, FULL_SHEET_SNAP_POINTS } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { navigateToAgent } from "@/utils/navigate-to-agent";

interface ChatHistoryAttachmentProps {
  attachment: Extract<AgentAttachment, { type: "text" }>;
  onRemove?: () => void;
  disabled?: boolean;
  testID?: string;
}

export function ChatHistoryAttachment({
  attachment,
  onRemove,
  disabled = false,
  testID,
}: ChatHistoryAttachmentProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const open = useCallback(() => setVisible(true), []);
  const close = useCallback(() => setVisible(false), []);
  const source = attachment.chatHistorySource;
  const openSource = useCallback(() => {
    if (!source) return;
    close();
    navigateToAgent({ serverId: source.serverId, agentId: source.agentId });
  }, [close, source]);
  const header = useMemo(
    () => ({
      title: t("message.chatHistory.title"),
      subtitle: source?.title ? (
        <Text style={styles.description} numberOfLines={1}>
          {source.title}
        </Text>
      ) : undefined,
    }),
    [source?.title, t],
  );
  const footer = useMemo(
    () =>
      source ? (
        <Button variant="outline" size="sm" leftIcon={ArrowUpRight} onPress={openSource}>
          {t("message.chatHistory.openSource")}
        </Button>
      ) : undefined,
    [source, openSource, t],
  );
  const history = useMemo(() => {
    const text = attachment.text;
    const bodyStart = text.indexOf("\n\n");
    return text.startsWith("<chat-history-summary>\n") &&
      text.endsWith("\n</chat-history-summary>") &&
      bodyStart !== -1
      ? text.slice(bodyStart + 2, -"\n</chat-history-summary>".length)
      : text;
  }, [attachment.text]);
  const content = getAgentAttachmentPillContent(attachment, t);
  const label = (
    <AttachmentLabel icon={content.icon} title={content.title} subtitle={content.subtitle} />
  );
  const openLabel = t("message.chatHistory.open");

  return (
    <>
      {onRemove ? (
        <AttachmentPill
          testID={testID}
          onOpen={open}
          onRemove={onRemove}
          disabled={disabled}
          openAccessibilityLabel={openLabel}
          removeAccessibilityLabel={t("message.chatHistory.remove")}
        >
          {label}
        </AttachmentPill>
      ) : (
        <AttachmentFrame testID={testID} onPress={open} accessibilityLabel={openLabel}>
          {label}
        </AttachmentFrame>
      )}
      <AdaptiveModalSheet
        visible={visible}
        onClose={close}
        header={header}
        snapPoints={FULL_SHEET_SNAP_POINTS}
        desktopMaxWidth={720}
        desktopHeight="75%"
        testID="chat-history-preview"
        contentStyle={styles.content}
        footer={footer}
      >
        <Text style={styles.description}>{t("message.chatHistory.description")}</Text>
        <Text selectable testID="chat-history-content" style={styles.history}>
          {history}
        </Text>
      </AdaptiveModalSheet>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.spacing[4] },
  description: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  history: {
    fontSize: theme.fontSize.content,
    lineHeight: theme.fontSize.content * 1.6,
    color: theme.colors.foreground,
  },
}));

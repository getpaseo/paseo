import { memo, useCallback } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { ArrowUpRight } from "lucide-react-native";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import { extractChatHistoryBody } from "@getpaseo/protocol/chat-history";
import { AssistantMessage, UserMessage } from "@/components/message";
import { Button } from "@/components/ui/button";
import { navigateToAgent } from "@/utils/navigate-to-agent";

type HistoryAttachment = Extract<AgentAttachment, { type: "text" }>;

export const ChatHistoryTranscript = memo(function ChatHistoryTranscript({
  attachment,
  occurrenceKey,
}: {
  attachment: HistoryAttachment;
  occurrenceKey: string;
}) {
  const { t } = useTranslation();
  const source = attachment.chatHistorySource;
  const openSource = useCallback(() => {
    if (source) navigateToAgent({ serverId: source.serverId, agentId: source.agentId });
  }, [source]);

  return (
    <View testID="chat-history-transcript" style={styles.container}>
      <View style={styles.source}>
        <View style={styles.sourceLabel}>
          <Text style={styles.caption}>{t("message.chatHistory.title")}</Text>
          {source?.title ? (
            <Text numberOfLines={1} style={styles.caption}>
              {source.title}
            </Text>
          ) : null}
        </View>
        {source ? (
          <Button variant="ghost" size="sm" leftIcon={ArrowUpRight} onPress={openSource}>
            {t("message.chatHistory.openSource")}
          </Button>
        ) : null}
      </View>
      {attachment.chatHistoryEntries ? (
        attachment.chatHistoryEntries.map((entry) => {
          if (entry.role === "user") {
            return <UserMessage key={entry.id} message={entry.text} disableOuterSpacing />;
          }
          if (entry.role === "assistant") {
            return (
              <AssistantMessage
                key={entry.id}
                occurrenceKey={`${occurrenceKey}:${entry.id}`}
                message={entry.text}
                renderFullContent
                phase="complete"
                spacing="compactBoth"
              />
            );
          }
          return (
            <Text key={entry.id} selectable style={styles.activity}>
              {entry.text}
            </Text>
          );
        })
      ) : (
        <Text selectable style={styles.legacy}>
          {extractChatHistoryBody(attachment.text)}
        </Text>
      )}
      <View style={styles.boundary}>
        <View style={styles.rule} />
        <Text style={styles.caption}>{t("message.chatHistory.forkBoundary")}</Text>
        <View style={styles.rule} />
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[3], paddingBottom: theme.spacing[4] },
  source: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  sourceLabel: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  caption: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  activity: {
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.6,
    color: theme.colors.foregroundMuted,
  },
  legacy: {
    fontSize: theme.fontSize.content,
    lineHeight: theme.fontSize.content * 1.6,
    color: theme.colors.foreground,
  },
  boundary: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  rule: { height: 1, flex: 1, backgroundColor: theme.colors.border },
}));

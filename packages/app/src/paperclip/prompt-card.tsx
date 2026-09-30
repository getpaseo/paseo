import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "@/components/icons/ui-icons";
import { useSessionStore } from "@/stores/session-store";
import { summarizePaperclipPrompt, type PaperclipPromptSummary } from "./prompt";

/** The Paperclip task behind a user message, when the adapter sent it; null otherwise. */
export function usePaperclipPromptSummary(input: {
  serverId: string | undefined;
  agentId: string | undefined;
  message: string;
}): PaperclipPromptSummary | null {
  const agent = useSessionStore((state) =>
    input.serverId && input.agentId
      ? state.sessions[input.serverId]?.agents.get(input.agentId)
      : undefined,
  );
  return summarizePaperclipPrompt({
    message: input.message,
    agentLabels: agent?.labels,
    agentTitle: agent?.title,
  });
}

/** An adapter heartbeat collapsed to its task; the full instructions open on press. */
export function PaperclipPromptCard({
  summary,
  onExpand,
}: {
  summary: PaperclipPromptSummary;
  onExpand: () => void;
}) {
  const { t } = useTranslation();
  const heading = summary.issueKey
    ? t("message.paperclipPrompt.title", { key: summary.issueKey })
    : t("message.paperclipPrompt.untitled");
  return (
    <View style={styles.container}>
      <Pressable
        onPress={onExpand}
        accessibilityRole="button"
        accessibilityLabel={t("message.paperclipPrompt.show")}
        style={styles.card}
        testID="paperclip-prompt-card"
      >
        <View style={styles.text}>
          <Text style={styles.heading}>{heading}</Text>
          {summary.title ? (
            <Text style={styles.title} numberOfLines={1}>
              {summary.title}
            </Text>
          ) : null}
        </View>
        <ChevronRight size={14} color={styles.chevron.color} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    alignItems: "flex-end",
    marginVertical: theme.spacing[2],
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    maxWidth: 560,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  text: {
    flexShrink: 1,
    gap: 2,
  },
  heading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
  title: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  chevron: {
    color: theme.colors.foregroundMuted,
  },
}));

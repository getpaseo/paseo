import { useCallback, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { z } from "zod";
import type { AgentTimelineEntryPayloadSchema } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

type TimelineEntry = z.infer<typeof AgentTimelineEntryPayloadSchema>;

const TAIL_ENTRIES = 12;
const PREVIEW_STALE_MS = 60_000;
const PREVIEW_MAX_CHARS = 280;

/** The newest assistant text in a timeline tail, flattened to one line for a preview. */
export function lastAssistantText(entries: readonly TimelineEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const item = entries[index]?.item;
    if (item?.type !== "assistant_message") continue;
    const text = item.text.replace(/\s+/g, " ").trim();
    if (text)
      return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}…` : text;
  }
  return null;
}

function useLastAgentReply(serverId: string, agentId: string | null): string | null {
  const client = useHostRuntimeClient(serverId);
  const query = useFetchQuery({
    queryKey: ["leitstandLastReply", serverId, agentId],
    enabled: Boolean(client && agentId),
    dataShape: "value",
    staleTimeMs: PREVIEW_STALE_MS,
    queryFn: async () => {
      const payload = await client!.fetchAgentTimeline(agentId!, {
        direction: "tail",
        limit: TAIL_ENTRIES,
        projection: "projected",
      });
      return lastAssistantText(payload.entries);
    },
  });
  return query.data ?? null;
}

/** What the agent said last, so the row explains itself without opening the session. */
export function InboxReplyPreview({
  serverId,
  agentId,
  fallback,
  style,
}: {
  serverId: string;
  agentId: string | null;
  fallback: string;
  style: object;
}) {
  const reply = useLastAgentReply(serverId, agentId);
  return (
    <Text style={style} numberOfLines={2}>
      {reply ?? fallback}
    </Text>
  );
}

/** Answering here counts as replying: the row leaves Needs you once the agent picks it up. */
export function InboxReplyInput({
  serverId,
  agentId,
  testID,
}: {
  serverId: string;
  agentId: string;
  testID: string;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const inputRef = useRef<EditingTextInputHandle>(null);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "error">("idle");

  const send = useCallback(async () => {
    const message = text.trim();
    if (!client || !message || state === "sending") return;
    setState("sending");
    try {
      await client.sendAgentMessage(agentId, message);
      inputRef.current?.reset();
      setText("");
      setState("idle");
    } catch {
      setState("error");
    }
  }, [agentId, client, state, text]);

  return (
    <View style={styles.reply}>
      <EditingTextInput
        ref={inputRef}
        testID={`${testID}-reply`}
        accessibilityLabel={t("leitstand.inbox.reply.placeholder")}
        placeholder={t("leitstand.inbox.reply.placeholder")}
        placeholderTextColor={styles.placeholder.color}
        onChangeText={setText}
        onSubmitEditing={send}
        returnKeyType="send"
        style={styles.input}
      />
      <Button
        variant="secondary"
        size="sm"
        onPress={send}
        disabled={!text.trim() || state === "sending"}
        testID={`${testID}-reply-send`}
      >
        {state === "sending" ? t("leitstand.inbox.reply.sending") : t("leitstand.inbox.reply.send")}
      </Button>
      {state === "error" ? (
        <Text style={styles.error}>{t("leitstand.inbox.reply.failed")}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  reply: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  input: {
    flex: 1,
    minHeight: 32,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  placeholder: {
    color: theme.colors.foregroundMuted,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
}));

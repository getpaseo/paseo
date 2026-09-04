import type { PluginSurfaceProps, PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/react-native";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { CardActions } from "./card";
import { cardTitle } from "./card";
import type { InboxCard } from "./lanes";
import { PermissionControls } from "./permission-card";
import { ActionButton, QuestionControls } from "./question-card";
import { itemToPeekRow, type PeekRow } from "./timeline-text";
import type { PaseoApi, PermissionResponse } from "./types";

const ROLE_LABEL: Record<PeekRow["role"], string> = {
  you: "You",
  agent: "Agent",
  tool: "Tool",
  thinking: "Thinking",
  system: "System",
};

interface KeyedRow extends PeekRow {
  key: string;
}

function usePeekStyles(theme: PluginTheme) {
  return useMemo(
    () =>
      StyleSheet.create({
        container: { gap: 12, maxHeight: 560 },
        subtitle: { color: theme.colors.foregroundMuted, fontSize: 12 },
        scroll: { maxHeight: 320 },
        rows: { gap: 8 },
        row: { gap: 2 },
        role: { color: theme.colors.foregroundMuted, fontSize: 11 },
        speech: { color: theme.colors.foreground, fontSize: 13, lineHeight: 18 },
        aside: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 },
        thinking: {
          color: theme.colors.foregroundMuted,
          fontSize: 13,
          lineHeight: 18,
          fontStyle: "italic",
        },
        request: { borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 12 },
        replyRow: { flexDirection: "row", gap: 8, alignItems: "center" },
        input: {
          flex: 1,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 7,
          color: theme.colors.foreground,
          fontSize: 13,
        },
      }),
    [theme],
  );
}

function rowStyle(styles: ReturnType<typeof usePeekStyles>, role: PeekRow["role"]) {
  if (role === "thinking") return styles.thinking;
  if (role === "agent" || role === "you") return styles.speech;
  return styles.aside;
}

export function PeekModal({
  card,
  theme,
  paseo,
  navigation,
  actions,
  onClose,
}: {
  card: InboxCard | null;
  theme: PluginTheme;
  paseo: PaseoApi;
  navigation: PluginSurfaceProps["navigation"];
  actions: CardActions;
  onClose(): void;
}) {
  const styles = usePeekStyles(theme);
  const [reply, setReply] = useState("");
  const rows = useQuery({
    queryKey: ["inbox", "peek", card?.agent.id, card?.agent.updatedAt],
    enabled: card !== null,
    queryFn: async (): Promise<KeyedRow[]> => {
      if (!card) return [];
      const page = await paseo.agents
        .ref(card.agent.id)
        .timeline.refetch({ direction: "tail", limit: 40, projection: "projected" });
      const keyed: KeyedRow[] = [];
      for (const entry of page.entries) {
        const row = itemToPeekRow(entry.item);
        if (row) keyed.push({ ...row, key: `${entry.seqStart}-${entry.seqEnd}` });
      }
      return keyed.slice(-20);
    },
  });

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) onClose();
    },
    [onClose],
  );
  const sendReply = useCallback(() => {
    const text = reply.trim();
    if (!card || !text) return;
    actions.onReply(card.agent.id, text);
    setReply("");
  }, [actions, card, reply]);
  const respond = useCallback(
    (response: PermissionResponse) => {
      if (!card?.request) return;
      actions.onRespond(card.requestAgentId, card.request.id, response);
    },
    [actions, card],
  );
  const openAgent = useCallback(() => {
    if (!card || !navigation) return;
    navigation.openAgent({ agentId: card.agent.id });
    onClose();
  }, [card, navigation, onClose]);

  return (
    <Modal
      title={card ? cardTitle(card) : "Kanban"}
      open={card !== null}
      onOpenChange={handleOpenChange}
    >
      <Modal.Content>
        {card ? (
          <View style={styles.container}>
            <Text style={styles.subtitle}>
              {card.agent.provider}
              {card.agent.model ? ` · ${card.agent.model}` : ""} · {card.agent.status}
            </Text>
            <ScrollView style={styles.scroll} contentContainerStyle={styles.rows}>
              {rows.isPending ? <Text style={styles.aside}>Loading…</Text> : null}
              {rows.data?.map((row) => (
                <View key={row.key} style={styles.row}>
                  <Text style={styles.role}>{ROLE_LABEL[row.role]}</Text>
                  <Text style={rowStyle(styles, row.role)}>{row.text}</Text>
                </View>
              ))}
            </ScrollView>
            {card.request && actions.canRespond ? (
              <View style={styles.request}>
                {card.reason === "question" ? (
                  <QuestionControls
                    request={card.request}
                    theme={theme}
                    disabled={actions.responding}
                    onRespond={respond}
                  />
                ) : (
                  <PermissionControls
                    request={card.request}
                    theme={theme}
                    disabled={actions.responding}
                    onRespond={respond}
                  />
                )}
              </View>
            ) : null}
            <View style={styles.replyRow}>
              <TextInput
                value={reply}
                onChangeText={setReply}
                onSubmitEditing={sendReply}
                placeholder={card.request ? "Reply instead…" : "Reply…"}
                placeholderTextColor={theme.colors.foregroundMuted}
                style={styles.input}
              />
              <ActionButton
                theme={theme}
                label="Send"
                primary
                onPress={sendReply}
                disabled={!reply.trim()}
              />
              {navigation ? (
                <ActionButton theme={theme} label="Open agent" onPress={openAgent} />
              ) : null}
            </View>
          </View>
        ) : null}
      </Modal.Content>
    </Modal>
  );
}

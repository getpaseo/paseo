import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/react-native";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { formatSince, type InboxCard } from "./lanes";
import { PermissionControls } from "./permission-card";
import { ActionButton, QuestionControls } from "./question-card";
import { describeRequest, describeToolCall, lastToolCall } from "./detail-text";
import { lastAssistantLine } from "./timeline-text";
import type { PaseoApi, PermissionResponse } from "./types";

export interface CardActions {
  canRespond: boolean;
  responding: boolean;
  onRespond(agentId: string, requestId: string, response: PermissionResponse): void;
  onReply(agentId: string, text: string): void;
  onMarkRead(agentId: string): void;
  onOpen(card: InboxCard): void;
}

export function laneColor(card: InboxCard, theme: PluginTheme): string {
  switch (card.reason) {
    case "question":
    case "permission":
      return theme.colors.statusWarning;
    case "error":
      return theme.colors.statusDanger;
    case "working":
      return theme.colors.accent;
    case "finished":
      return theme.colors.statusSuccess;
  }
}

export function cardTitle(card: InboxCard): string {
  return card.agent.title?.trim() || card.workspace?.name || card.agent.provider;
}

export function useLastAssistantLine(paseo: PaseoApi, card: InboxCard, enabled: boolean) {
  return useQuery({
    queryKey: ["inbox", "tail", card.agent.id, card.agent.updatedAt],
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const page = await paseo.agents
        .ref(card.agent.id)
        .timeline.refetch({ direction: "tail", limit: 12, projection: "projected" });
      return lastAssistantLine(page.entries.map((entry) => entry.item));
    },
  });
}

/**
 * Working cards poll the timeline tail. The daemon streams agent events only
 * for agents the app has opened, so a plugin cannot subscribe to an agent it
 * has not viewed; a short poll while the card is mounted is the alternative.
 */
export function useWorkingActivity(paseo: PaseoApi, card: InboxCard, enabled: boolean) {
  return useQuery({
    queryKey: ["inbox", "activity", card.agent.id],
    enabled,
    refetchInterval: enabled ? 4000 : false,
    queryFn: async () => {
      const page = await paseo.agents
        .ref(card.agent.id)
        .timeline.refetch({ direction: "tail", limit: 8, projection: "projected" });
      const item = lastToolCall(page.entries.map((entry) => entry.item));
      return item ? describeToolCall(item) : null;
    },
  });
}

function metaParts(card: InboxCard): string {
  const parts: string[] = [card.agent.provider];
  if (card.agent.model) parts.push(card.agent.model);
  if (card.workspace) parts.push(`${card.workspace.projectDisplayName} / ${card.workspace.name}`);
  const diff = card.workspace?.diffStat;
  if (diff && (diff.additions > 0 || diff.deletions > 0)) {
    parts.push(`+${diff.additions} −${diff.deletions}`);
  }
  if (card.subagentCount > 0) {
    parts.push(`${card.subagentCount} subagent${card.subagentCount === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

function useCardStyles(theme: PluginTheme, rule: string, focused: boolean) {
  return useMemo(
    () =>
      StyleSheet.create({
        shell: {
          flexDirection: "row",
          backgroundColor: theme.colors.surface1,
          borderColor: focused ? theme.colors.accent : theme.colors.border,
          borderWidth: 1,
          borderRadius: 10,
          overflow: "hidden",
        },
        rule: { width: 3, backgroundColor: rule },
        content: { flex: 1, padding: 12, gap: 10 },
        titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
        title: { flex: 1, color: theme.colors.foreground, fontSize: 14, fontWeight: "600" },
        metaRow: { flexDirection: "row", alignItems: "center", gap: 6 },
        meta: { flex: 1, color: theme.colors.foregroundMuted, fontSize: 12 },
        since: { color: theme.colors.foregroundMuted, fontSize: 12 },
        muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
        error: { color: theme.colors.statusDanger, fontSize: 13 },
        body: { color: theme.colors.foreground, fontSize: 13, lineHeight: 18 },
        finished: { gap: 8 },
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
    [focused, rule, theme],
  );
}

function finishedText(line: string | null | undefined, pending: boolean): string {
  if (line) return line;
  return pending ? "…" : "Finished.";
}

export function InboxCardView({
  card,
  theme,
  paseo,
  now,
  actions,
  focused = false,
}: {
  card: InboxCard;
  theme: PluginTheme;
  paseo: PaseoApi;
  now: number;
  actions: CardActions;
  focused?: boolean;
}) {
  const [reply, setReply] = useState("");
  const tail = useLastAssistantLine(paseo, card, card.reason === "finished");
  const activity = useWorkingActivity(paseo, card, card.reason === "working");
  const styles = useCardStyles(theme, laneColor(card, theme), focused);
  const since = formatSince(card.since, now);

  const open = useCallback(() => actions.onOpen(card), [actions, card]);
  const markRead = useCallback(() => actions.onMarkRead(card.agent.id), [actions, card.agent.id]);
  const respond = useCallback(
    (response: PermissionResponse) => {
      if (!card.request) return;
      actions.onRespond(card.requestAgentId, card.request.id, response);
    },
    [actions, card.request, card.requestAgentId],
  );
  const sendReply = useCallback(() => {
    const text = reply.trim();
    if (!text) return;
    actions.onReply(card.agent.id, text);
    setReply("");
  }, [actions, card.agent.id, reply]);

  let body: React.ReactNode = null;
  if (card.request && (card.reason === "question" || card.reason === "permission")) {
    if (!actions.canRespond) {
      body = (
        <Text style={styles.muted}>
          {describeRequest(card.request).headline}. Update the app to answer from here.
        </Text>
      );
    } else if (card.reason === "question") {
      body = (
        <QuestionControls
          request={card.request}
          theme={theme}
          disabled={actions.responding}
          onRespond={respond}
        />
      );
    } else {
      body = (
        <PermissionControls
          request={card.request}
          theme={theme}
          disabled={actions.responding}
          onRespond={respond}
        />
      );
    }
  } else if (card.reason === "error") {
    body = (
      <Text numberOfLines={3} style={styles.error}>
        {card.agent.lastError ?? "The agent stopped with an error."}
      </Text>
    );
  } else if (card.reason === "working") {
    body = (
      <Text numberOfLines={2} style={styles.body}>
        {activity.data ?? (activity.isPending ? "…" : "Thinking")}
        <Text style={styles.muted}> · {since || "a moment"}</Text>
      </Text>
    );
  } else {
    body = (
      <View style={styles.finished}>
        <Text numberOfLines={3} style={styles.body}>
          {finishedText(tail.data, tail.isPending)}
        </Text>
        <View style={styles.replyRow}>
          <TextInput
            value={reply}
            onChangeText={setReply}
            onSubmitEditing={sendReply}
            placeholder="Reply…"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.input}
          />
          <ActionButton theme={theme} label="Mark read" onPress={markRead} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.shell}>
      <View style={styles.rule} />
      <View style={styles.content}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${cardTitle(card)}`}
          onPress={open}
          style={styles.titleRow}
        >
          <Text numberOfLines={1} style={styles.title}>
            {cardTitle(card)}
          </Text>
          <Icon name="ChevronRight" size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
        {body}
        <View style={styles.metaRow}>
          <Text numberOfLines={1} style={styles.meta}>
            {metaParts(card)}
          </Text>
          {since ? <Text style={styles.since}>{since}</Text> : null}
        </View>
      </View>
    </View>
  );
}

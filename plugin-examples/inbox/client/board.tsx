import type { PluginSurfaceProps, PluginTheme, PluginWorkspacePanelProps } from "@getpaseo/plugin";
import { usePaseo } from "@getpaseo/plugin";
import { useToast } from "@getpaseo/plugin/react-native";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { type CardActions, InboxCardView } from "./card";
import { keyToAction, resolveKeyAction } from "./keyboard";
import { type InboxCard, type Lane, type Lanes, projectLanes } from "./lanes";
import { PeekModal } from "./peek-modal";
import { getInboxStore, type InboxSnapshot } from "./store";
import type { PaseoApi, PermissionResponse } from "./types";
import { isTextTarget, subscribeKeydown, type WebKeyEvent } from "./web";

const EMPTY: InboxSnapshot = {
  agents: new Map(),
  workspaces: new Map(),
  lanes: { needsYou: [], working: [], done: [] },
  loaded: false,
  pendingOpenAgentId: null,
};
const KEY_HINT = "j/k move · Enter open · 1-9 answer · y/n allow/deny";
const LANE_ORDER: readonly Lane[] = ["needsYou", "working", "done"];
const LANE_TITLE: Record<Lane, string> = {
  needsYou: "Needs you",
  working: "Working",
  done: "Done",
};
const NO_STORE_UNSUBSCRIBE = () => {};

function useInboxSnapshot(): InboxSnapshot {
  const store = getInboxStore();
  return useSyncExternalStore(
    (listener) => store?.subscribe(listener) ?? NO_STORE_UNSUBSCRIBE,
    () => store?.getSnapshot() ?? EMPTY,
    () => store?.getSnapshot() ?? EMPTY,
  );
}

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function useBoardStyles(theme: PluginTheme, compact: boolean) {
  return useMemo(() => {
    const padding = compact ? 12 : 20;
    return StyleSheet.create({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      loading: { color: theme.colors.foregroundMuted, padding },
      compactContent: { padding, gap: 8 },
      lanes: { flex: 1, flexDirection: "row", gap: 16, padding },
      lane: {
        flex: 1,
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingTop: 6,
      },
      laneContent: { paddingBottom: 12 },
      header: { flexDirection: "row", alignItems: "center", paddingVertical: 6 },
      headerTitle: {
        flex: 1,
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        fontWeight: "600",
        letterSpacing: 0.6,
        textTransform: "uppercase",
      },
      count: {
        minWidth: 22,
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 11,
        backgroundColor: theme.colors.surface2,
        alignItems: "center",
      },
      countText: { color: theme.colors.foreground, fontSize: 12 },
      empty: { color: theme.colors.foregroundMuted, fontSize: 13, paddingVertical: 8 },
      cards: { gap: 10 },
      hint: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        paddingHorizontal: padding,
        paddingBottom: 8,
        textAlign: "right",
      },
    });
  }, [compact, theme]);
}

type BoardStyles = ReturnType<typeof useBoardStyles>;

function collapseMarker(collapsed: boolean | null): string {
  if (collapsed === null) return "";
  return collapsed ? "  ▸" : "  ▾";
}

function LaneHeader({
  lane,
  count,
  styles,
  collapsed,
  onToggle,
}: {
  lane: Lane;
  count: number;
  styles: BoardStyles;
  collapsed: boolean | null;
  onToggle?: (lane: Lane) => void;
}) {
  const handlePress = useCallback(() => onToggle?.(lane), [lane, onToggle]);
  const content = (
    <View style={styles.header}>
      <Text style={styles.headerTitle}>
        {LANE_TITLE[lane]}
        {collapseMarker(collapsed)}
      </Text>
      <View style={styles.count}>
        <Text style={styles.countText}>{count}</Text>
      </View>
    </View>
  );
  if (!onToggle) return content;
  return (
    <Pressable accessibilityRole="button" onPress={handlePress}>
      {content}
    </Pressable>
  );
}

function LaneBody({
  cards,
  styles,
  theme,
  paseo,
  now,
  actions,
  focusedId,
}: {
  cards: InboxCard[];
  styles: BoardStyles;
  theme: PluginTheme;
  paseo: PaseoApi;
  now: number;
  actions: CardActions;
  focusedId: string | null;
}) {
  if (cards.length === 0) {
    return <Text style={styles.empty}>None</Text>;
  }
  return (
    <View style={styles.cards}>
      {cards.map((card) => (
        <InboxCardView
          key={card.agent.id}
          card={card}
          theme={theme}
          paseo={paseo}
          now={now}
          actions={actions}
          focused={card.agent.id === focusedId}
        />
      ))}
    </View>
  );
}

const INITIAL_COLLAPSED: Record<Lane, boolean> = { needsYou: false, working: true, done: true };

export function InboxBoard({
  theme,
  layout,
  navigation,
  workspaceId,
  keyboard = false,
}: Pick<PluginSurfaceProps, "theme" | "layout" | "navigation"> & {
  workspaceId?: string;
  /** Bind board shortcuts. Only the global surface does, so a panel never doubles them. */
  keyboard?: boolean;
}) {
  const paseo = usePaseo();
  const toast = useToast();
  const snapshot = useInboxSnapshot();
  const now = useNow();
  const styles = useBoardStyles(theme, layout.compact);
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<Lane, boolean>>(INITIAL_COLLAPSED);

  const [focusedId, setFocusedId] = useState<string | null>(null);

  const lanes: Lanes = useMemo(
    () =>
      workspaceId
        ? projectLanes(snapshot.agents.values(), snapshot.workspaces, { workspaceId })
        : snapshot.lanes,
    [snapshot, workspaceId],
  );
  const ordered = useMemo(() => LANE_ORDER.flatMap((lane) => lanes[lane]), [lanes]);
  const openCard = useMemo(
    () => ordered.find((card) => card.agent.id === openCardId) ?? null,
    [ordered, openCardId],
  );

  // A Command Center item asked for a specific card; open it once and clear the request.
  const store = getInboxStore();
  const pendingOpenAgentId = snapshot.pendingOpenAgentId;
  useEffect(() => {
    if (!pendingOpenAgentId || !store) return;
    setOpenCardId(pendingOpenAgentId);
    setFocusedId(pendingOpenAgentId);
    store.clearPendingOpen();
  }, [pendingOpenAgentId, store]);

  // Presence of the two host methods is the compatibility gate: an app bundle
  // that predates them renders the hand-off text instead of answer controls.
  const probe = paseo.agents.ref("__inbox_probe__");
  const canRespond =
    typeof probe.respondToPermission === "function" && typeof probe.clearAttention === "function";

  const respond = useMutation({
    mutationFn: async (input: {
      agentId: string;
      requestId: string;
      response: PermissionResponse;
    }) => {
      await paseo.agents.ref(input.agentId).respondToPermission(input.requestId, input.response);
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : "The answer did not reach the agent.");
    },
  });
  const reply = useMutation({
    mutationFn: async (input: { agentId: string; text: string }) => {
      await paseo.agents.ref(input.agentId).send(input.text);
    },
    onSuccess: () => setOpenCardId(null),
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : "The reply did not reach the agent.");
    },
  });
  const markRead = useMutation({
    mutationFn: async (agentId: string) => {
      await paseo.agents.ref(agentId).clearAttention();
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : "Could not clear attention.");
    },
  });

  const respondMutate = respond.mutate;
  const replyMutate = reply.mutate;
  const markReadMutate = markRead.mutate;
  const responding = respond.isPending;
  const actions: CardActions = useMemo(
    () => ({
      canRespond,
      responding,
      onRespond: (agentId, requestId, response) => respondMutate({ agentId, requestId, response }),
      onReply: (agentId, text) => replyMutate({ agentId, text }),
      onMarkRead: (agentId) => markReadMutate(agentId),
      onOpen: (card) => setOpenCardId(card.agent.id),
    }),
    [canRespond, markReadMutate, replyMutate, respondMutate, responding],
  );

  const toggleLane = useCallback(
    (lane: Lane) => setCollapsed((value) => ({ ...value, [lane]: !value[lane] })),
    [],
  );
  const closePeek = useCallback(() => setOpenCardId(null), []);

  const showsKeyHint = keyboard && layout.platform === "web" && !layout.compact;
  useEffect(() => {
    if (!keyboard || layout.platform !== "web") return;
    const handle = (event: WebKeyEvent) => {
      if (isTextTarget(event.target)) return;
      const action = keyToAction(event);
      if (!action) return;
      const effect = resolveKeyAction(action, { ordered, focusedId, openCardId });
      if (!effect) return;
      event.preventDefault();
      if (effect.kind === "focus") setFocusedId(effect.agentId);
      else if (effect.kind === "open") {
        setFocusedId(effect.agentId);
        setOpenCardId(effect.agentId);
      } else if (effect.kind === "close") setOpenCardId(null);
      else if (effect.card.request) {
        respondMutate({
          agentId: effect.card.requestAgentId,
          requestId: effect.card.request.id,
          response: effect.response,
        });
        setFocusedId(effect.nextFocusAgentId);
      }
    };
    return subscribeKeydown(handle);
  }, [focusedId, keyboard, layout.platform, openCardId, ordered, respondMutate]);

  let content: React.ReactNode;
  if (!snapshot.loaded) {
    content = <Text style={styles.loading}>Loading agents…</Text>;
  } else if (layout.compact) {
    content = (
      <ScrollView contentContainerStyle={styles.compactContent}>
        {LANE_ORDER.map((lane) => (
          <View key={lane}>
            <LaneHeader
              lane={lane}
              count={lanes[lane].length}
              styles={styles}
              collapsed={collapsed[lane]}
              onToggle={toggleLane}
            />
            {collapsed[lane] ? null : (
              <LaneBody
                cards={lanes[lane]}
                styles={styles}
                theme={theme}
                paseo={paseo}
                now={now}
                actions={actions}
                focusedId={focusedId}
              />
            )}
          </View>
        ))}
      </ScrollView>
    );
  } else {
    content = (
      <View style={styles.lanes}>
        {LANE_ORDER.map((lane) => (
          <View key={lane} style={styles.lane}>
            <LaneHeader lane={lane} count={lanes[lane].length} styles={styles} collapsed={null} />
            <ScrollView contentContainerStyle={styles.laneContent}>
              <LaneBody
                cards={lanes[lane]}
                styles={styles}
                theme={theme}
                paseo={paseo}
                now={now}
                actions={actions}
                focusedId={focusedId}
              />
            </ScrollView>
          </View>
        ))}
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {content}
      {showsKeyHint ? <Text style={styles.hint}>{KEY_HINT}</Text> : null}
      <PeekModal
        card={openCard}
        theme={theme}
        paseo={paseo}
        navigation={navigation}
        actions={actions}
        onClose={closePeek}
      />
    </View>
  );
}

export function InboxSurface(props: PluginSurfaceProps) {
  return (
    <InboxBoard theme={props.theme} layout={props.layout} navigation={props.navigation} keyboard />
  );
}

export function InboxWorkspacePanel(props: PluginWorkspacePanelProps) {
  return (
    <InboxBoard
      theme={props.theme}
      layout={props.layout}
      navigation={props.navigation}
      workspaceId={props.workspaceId}
    />
  );
}

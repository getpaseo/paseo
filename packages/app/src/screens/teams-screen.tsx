import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { router, useLocalSearchParams } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { MenuHeader } from "@/components/headers/menu-header";
import { ArrowUp, Users } from "@/components/icons/ui-icons";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { useIsCompactFormFactor } from "@/constants/layout";
import { buildTeamChatRows, formatTeamTime, type TeamChatRow } from "@/teams/chat-model";
import { useTeamChat, useTeamHosts, useTeamList, type HostTeam } from "@/teams/use-teams";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";

interface TeamSelection {
  serverId: string;
  teamId: string;
}

export function TeamsScreen(): ReactElement {
  const isFocused = useIsFocused();
  if (!isFocused) return <View style={styles.container} />;
  return <TeamsScreenContent />;
}

function useTeamSelection(): TeamSelection | null {
  const params = useLocalSearchParams<{ serverId?: string; teamId?: string }>();
  return params.serverId && params.teamId
    ? { serverId: params.serverId, teamId: params.teamId }
    : null;
}

function TeamsScreenContent(): ReactElement {
  const isCompact = useIsCompactFormFactor();
  const selection = useTeamSelection();
  const hosts = useTeamHosts();
  const { teams, isLoading, error } = useTeamList();
  const selectedTeam =
    teams.find((team) => team.serverId === selection?.serverId && team.id === selection.teamId) ??
    null;

  const openTeam = useCallback(
    (team: HostTeam) => {
      const route = {
        pathname: "/teams" as const,
        params: { serverId: team.serverId, teamId: team.id },
      };
      if (isCompact) router.push(route);
      else router.replace(route);
    },
    [isCompact],
  );
  const closeTeam = useCallback(() => router.replace("/teams"), []);

  const list = (
    <TeamList
      teams={teams}
      isLoading={isLoading}
      error={error}
      noHosts={hosts.length === 0}
      selection={selection}
      onOpen={openTeam}
    />
  );

  if (isCompact) {
    if (selection) {
      return (
        <View style={styles.container}>
          <BackHeader title={selectedTeam?.title ?? "Team"} onBack={closeTeam} />
          <TeamChat selection={selection} />
        </View>
      );
    }
    return (
      <View style={styles.container}>
        <MenuHeader title="Teams" />
        {list}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <MenuHeader title="Teams" />
      <View style={styles.split}>
        <View style={styles.sidebar}>{list}</View>
        <View style={styles.detail}>
          {selection ? (
            <>
              <View style={styles.chatHeader}>
                <Text style={styles.chatTitle} numberOfLines={1}>
                  {selectedTeam?.title ?? "Team"}
                </Text>
                {selectedTeam ? (
                  <Text style={styles.chatMeta} numberOfLines={1}>
                    {teamMeta(selectedTeam)}
                  </Text>
                ) : null}
              </View>
              <TeamChat selection={selection} />
            </>
          ) : (
            <View style={styles.centered}>
              <Text style={styles.muted}>Select a team</Text>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

function teamMeta(team: HostTeam): string {
  const working = team.items.filter((item) => item.board !== "root" && item.phase !== "done");
  const status = team.status.charAt(0).toUpperCase() + team.status.slice(1);
  return working.length > 0 ? `${status} · ${working.length} open` : status;
}

function lastActivity(team: HostTeam): string {
  const at = team.lastEventAt ?? team.createdAt;
  const date = new Date(at);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? formatTeamTime(at)
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function TeamList({
  teams,
  isLoading,
  error,
  noHosts,
  selection,
  onOpen,
}: {
  teams: HostTeam[];
  isLoading: boolean;
  error: Error | null;
  noHosts: boolean;
  selection: TeamSelection | null;
  onOpen: (team: HostTeam) => void;
}): ReactElement {
  if (noHosts) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>Update the host to use teams</Text>
      </View>
    );
  }
  if (isLoading) {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  }
  if (error && teams.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>Unable to load teams</Text>
      </View>
    );
  }
  if (teams.length === 0) {
    return (
      <View style={styles.centered} testID="teams-empty">
        <Users size={styles.emptyIcon.width} color={styles.emptyIcon.color} />
        <Text style={styles.muted}>No teams yet</Text>
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.listContent} testID="teams-list">
      {teams.map((team) => (
        <TeamRow
          key={`${team.serverId}:${team.id}`}
          team={team}
          selected={selection?.serverId === team.serverId && selection.teamId === team.id}
          onOpen={onOpen}
        />
      ))}
    </ScrollView>
  );
}

function TeamRow({
  team,
  selected,
  onOpen,
}: {
  team: HostTeam;
  selected: boolean;
  onOpen: (team: HostTeam) => void;
}): ReactElement {
  const handlePress = useCallback(() => onOpen(team), [onOpen, team]);
  return (
    <Pressable
      onPress={handlePress}
      style={[styles.row, selected && styles.rowSelected]}
      accessibilityRole="button"
      testID={`team-row-${team.id}`}
    >
      <View style={styles.rowTop}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {team.title}
        </Text>
        <Text style={styles.rowTime}>{lastActivity(team)}</Text>
      </View>
      <Text style={styles.rowMeta} numberOfLines={1}>
        {teamMeta(team)}
      </Text>
    </Pressable>
  );
}

function TeamChat({ selection }: { selection: TeamSelection }): ReactElement {
  const { state, pending, sendError, send } = useTeamChat(selection);
  const scrollRef = useRef<ScrollView>(null);
  const rows = useMemo(
    () =>
      state.status === "ready"
        ? buildTeamChatRows({
            team: state.team,
            events: state.events,
            bindings: state.bindings,
            pending,
            now: new Date(),
          })
        : [],
    [state, pending],
  );

  const rowCount = rows.length;
  useEffect(() => {
    if (rowCount > 0) scrollRef.current?.scrollToEnd({ animated: false });
  }, [rowCount]);

  const openAgent = useCallback(
    (agentId: string) => router.push(buildHostAgentDetailRoute(selection.serverId, agentId)),
    [selection.serverId],
  );

  let body: ReactElement;
  if (state.status === "loading") {
    body = (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  } else if (state.status === "error") {
    body = (
      <View style={styles.centered}>
        <Text style={styles.muted}>{state.message}</Text>
      </View>
    );
  } else {
    body = (
      <ScrollView
        ref={scrollRef}
        style={styles.chatScroll}
        contentContainerStyle={styles.chatContent}
        keyboardShouldPersistTaps="handled"
        testID="team-chat"
      >
        {rows.map((row) => (
          <TeamChatRowView key={row.key} row={row} onOpenAgent={openAgent} />
        ))}
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.chat}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {body}
      <TeamComposer onSend={send} error={sendError} />
    </KeyboardAvoidingView>
  );
}

function TeamChatRowView({
  row,
  onOpenAgent,
}: {
  row: TeamChatRow;
  onOpenAgent: (agentId: string) => void;
}): ReactElement {
  if (row.kind === "day") {
    return (
      <View style={styles.centerLine}>
        <Text style={styles.dayPill}>{row.label}</Text>
      </View>
    );
  }
  if (row.kind === "system") return <TeamSystemLine row={row} />;
  return <TeamBubble row={row} onOpenAgent={onOpenAgent} />;
}

const SYSTEM_LINE_COLLAPSED_LINES = 4;

function TeamSystemLine({ row }: { row: Extract<TeamChatRow, { kind: "system" }> }): ReactElement {
  // Summaries such as "Team finished" run to dozens of lines; they open on tap.
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((current) => !current), []);
  const long = row.text.length > 240 || row.text.includes("\n");
  return (
    <View style={styles.centerLine}>
      <Pressable onPress={toggle} disabled={!long} style={styles.systemPress}>
        <Text
          style={[
            styles.systemPill,
            long && styles.systemLong,
            row.attention && styles.systemAttention,
          ]}
          numberOfLines={long && !expanded ? SYSTEM_LINE_COLLAPSED_LINES : undefined}
        >
          {`${row.text} · ${row.time}`}
        </Text>
      </Pressable>
    </View>
  );
}

function TeamBubble({
  row,
  onOpenAgent,
}: {
  row: Extract<TeamChatRow, { kind: "bubble" }>;
  onOpenAgent: (agentId: string) => void;
}): ReactElement {
  const { agentId } = row;
  const handlePress = useCallback(() => {
    if (agentId) onOpenAgent(agentId);
  }, [agentId, onOpenAgent]);
  const toneStyle = {
    po: styles.authorPo,
    developer: styles.authorDeveloper,
    tester: styles.authorTester,
    reviewer: styles.authorReviewer,
    boss: styles.authorBoss,
    other: styles.authorOther,
  }[row.tone];

  return (
    <View style={[styles.bubbleLine, row.mine && styles.bubbleLineMine]}>
      <Pressable
        onPress={handlePress}
        disabled={!agentId}
        style={[styles.bubble, row.mine ? styles.bubbleMine : styles.bubbleTheirs]}
        accessibilityRole={agentId ? "button" : undefined}
        testID={row.mine ? "team-bubble-mine" : "team-bubble"}
      >
        {row.mine ? null : (
          <View style={styles.bubbleHead}>
            <Text style={[styles.author, toneStyle]}>{row.author}</Text>
            {row.subtitle ? (
              <Text style={styles.subtitle} numberOfLines={1}>
                {row.subtitle}
              </Text>
            ) : null}
          </View>
        )}
        <Text style={styles.bubbleText} selectable>
          {row.text}
        </Text>
        <Text style={styles.bubbleTime}>{row.pending ? `${row.time} · Sending...` : row.time}</Text>
      </Pressable>
    </View>
  );
}

function TeamComposer({
  onSend,
  error,
}: {
  onSend: (text: string) => Promise<boolean>;
  error: string | null;
}): ReactElement {
  const inputRef = useRef<EditingTextInputHandle>(null);
  const [hasDraft, setHasDraft] = useState(false);
  const handleChangeText = useCallback((text: string) => setHasDraft(text.trim().length > 0), []);
  const submit = useCallback(async () => {
    const input = inputRef.current;
    const text = input?.getText().trim() ?? "";
    if (!input || !text) return;
    input.reset();
    setHasDraft(false);
    const delivered = await onSend(text);
    // Give the text back so a failed send is not lost.
    if (!delivered && !input.getText()) {
      input.replaceText(text);
      setHasDraft(true);
    }
  }, [onSend]);
  const handleSubmit = useCallback(() => void submit(), [submit]);

  return (
    <View style={styles.composer}>
      {error ? <Text style={styles.composerError}>{error}</Text> : null}
      <View style={styles.composerRow}>
        <EditingTextInput
          ref={inputRef}
          onChangeText={handleChangeText}
          onSubmitEditing={handleSubmit}
          submitBehavior="submit"
          placeholder="Message the team"
          placeholderTextColor={styles.placeholder.color}
          style={styles.composerInput}
          accessibilityLabel="Message the team"
          testID="team-composer-input"
        />
        <Button
          variant="default"
          size="md"
          leftIcon={ArrowUp}
          onPress={handleSubmit}
          disabled={!hasDraft}
          accessibilityLabel="Send"
          testID="team-composer-send"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  split: {
    flex: 1,
    flexDirection: "row",
    minHeight: 0,
  },
  sidebar: {
    width: 320,
    backgroundColor: theme.colors.surfaceSidebar,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  detail: {
    flex: 1,
    minWidth: 0,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  emptyIcon: {
    color: theme.colors.foregroundMuted,
    width: theme.iconSize.lg,
  },
  placeholder: {
    color: theme.colors.foregroundMuted,
  },
  listContent: {
    paddingVertical: theme.spacing[2],
  },
  row: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[1],
  },
  rowSelected: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  rowTop: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  rowTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  rowTime: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  rowMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  chatHeader: {
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    gap: theme.spacing[0.5],
  },
  chatTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  chatMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  chat: {
    flex: 1,
    minHeight: 0,
  },
  chatScroll: {
    flex: 1,
  },
  chatContent: {
    width: "100%",
    maxWidth: 820,
    alignSelf: "center",
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingVertical: theme.spacing[4],
    gap: theme.spacing[2],
  },
  centerLine: {
    alignItems: "center",
    paddingVertical: theme.spacing[1],
  },
  dayPill: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    overflow: "hidden",
  },
  systemPill: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    overflow: "hidden",
  },
  systemPress: {
    maxWidth: "90%",
  },
  systemLong: {
    textAlign: "left",
  },
  systemAttention: {
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  bubbleLine: {
    flexDirection: "row",
    justifyContent: "flex-start",
  },
  bubbleLineMine: {
    justifyContent: "flex-end",
  },
  bubble: {
    maxWidth: "80%",
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
  },
  bubbleTheirs: {
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderTopLeftRadius: theme.borderRadius.sm,
  },
  bubbleMine: {
    backgroundColor: theme.colors.surface3,
    borderTopRightRadius: theme.borderRadius.sm,
  },
  bubbleHead: {
    gap: theme.spacing[0.5],
  },
  author: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  authorPo: { color: theme.colors.palette.purple[500] },
  authorDeveloper: { color: theme.colors.palette.blue[500] },
  authorTester: { color: theme.colors.palette.green[600] },
  authorReviewer: { color: theme.colors.palette.orange[500] },
  authorBoss: { color: theme.colors.palette.amber[500] },
  authorOther: { color: theme.colors.foregroundMuted },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  bubbleText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
  },
  bubbleTime: {
    alignSelf: "flex-end",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  composer: {
    width: "100%",
    maxWidth: 820,
    alignSelf: "center",
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[4],
    gap: theme.spacing[1],
  },
  composerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  composerInput: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    backgroundColor: theme.colors.surface1,
  },
  composerError: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
}));

import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { resolveAgentLabel } from "@/agent-presentation";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { getFocusedAgentId } from "@/plugins/command-center/context";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { settingsStyles } from "@/styles/settings";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import type { PrState } from "./data";
import { useStartPrWatch } from "./use-start-watch";

interface PrWatchTarget {
  serverId: string;
  workspaceId: string;
  url: string;
  title: string;
  abbreviation: string;
}

export function PullRequestWatchAction({
  state,
  workspaceId,
  style,
  ...target
}: Omit<PrWatchTarget, "workspaceId"> & {
  workspaceId?: string | null;
  state: PrState;
  style: StyleProp<ViewStyle>;
}) {
  const { t } = useTranslation();
  const { open, dialog } = usePrWatchSetup(
    workspaceId && (state === "open" || state === "draft") ? { ...target, workspaceId } : null,
  );
  if (!open) return null;
  return (
    <>
      <Button variant="ghost" size="sm" onPress={open} style={style} testID="pr-pane-watch">
        {t("workspace.git.pr.watch.action", { abbreviation: target.abbreviation })}
      </Button>
      {dialog}
    </>
  );
}

export function usePrWatchSetup(target: PrWatchTarget | null) {
  const nextGeneration = useRef(0);
  const [session, setSession] = useState<{
    generation: number;
    target: PrWatchTarget;
    focusedId: string | null;
    visible: boolean;
  } | null>(null);
  const open = useCallback(() => {
    if (!target) return;
    const layout =
      useWorkspaceLayoutStore.getState().layoutByWorkspace[
        `${target.serverId}:${target.workspaceId}`
      ];
    const focusedId = getFocusedAgentId(layout ?? null);
    setSession({ generation: ++nextGeneration.current, target, focusedId, visible: true });
  }, [target]);
  const close = useCallback((generation: number) => {
    setSession((current) =>
      current?.generation === generation ? { ...current, visible: false } : current,
    );
  }, []);
  const matches =
    session?.target.url === target?.url &&
    session?.target.serverId === target?.serverId &&
    session?.target.workspaceId === target?.workspaceId;
  if (session && !matches) setSession(null);
  return {
    open: target ? open : null,
    dialog:
      session && matches ? (
        <WatchSetup
          key={session.generation}
          {...session.target}
          visible={session.visible}
          focusedId={session.focusedId}
          generation={session.generation}
          onClose={close}
        />
      ) : null,
  };
}

function WatchSetup({
  serverId,
  workspaceId,
  url,
  title,
  abbreviation,
  visible,
  focusedId,
  generation,
  onClose,
}: PrWatchTarget & {
  visible: boolean;
  focusedId: string | null;
  generation: number;
  onClose: (generation: number) => void;
}) {
  const { t } = useTranslation();
  const { supported, pending, error, setError, start } = useStartPrWatch(
    serverId,
    url,
    abbreviation,
  );
  const agents = useSessionStore(
    useShallow((state) =>
      Array.from(state.sessions[serverId]?.agents.values() ?? []).filter(
        (agent) =>
          normalizeWorkspaceOpaqueId(agent.workspaceId) === workspaceId &&
          !agent.background &&
          !agent.archivedAt &&
          agent.status !== "closed",
      ),
    ),
  );

  const [agentId, setAgentId] = useState(() => {
    const focused = agents.find((agent) => agent.id === focusedId);
    return focused?.id ?? (agents.length === 1 ? agents[0].id : null);
  });
  const selectedId = agents.find((agent) => agent.id === agentId)?.id;
  const label = t("workspace.git.pr.watch.action", { abbreviation });
  const header = useMemo(() => ({ title: label }), [label]);
  const close = useCallback(() => onClose(generation), [generation, onClose]);
  const select = useCallback(
    (id: string) => {
      setAgentId(id);
      setError(null);
    },
    [setError],
  );
  const confirm = useCallback(async () => {
    if (selectedId && (await start(selectedId))) close();
  }, [close, selectedId, start]);

  const hasAgents = agents.length > 0;
  const footer = useMemo(
    () =>
      supported && hasAgents ? (
        <Button onPress={confirm} disabled={pending || !selectedId} testID="pr-watch-confirm">
          {pending ? t("workspace.git.pr.watch.starting") : label}
        </Button>
      ) : undefined,
    [confirm, hasAgents, label, pending, selectedId, supported, t],
  );

  let unavailableMessage: string | null = null;
  if (!supported) unavailableMessage = t("workspace.git.pr.watch.updateHost");
  else if (!hasAgents) unavailableMessage = t("workspace.git.pr.watch.noAgents");

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={close}
      desktopMaxWidth={420}
      testID="pr-watch-setup"
      footer={footer}
    >
      {unavailableMessage ? (
        <Text style={styles.body}>{unavailableMessage}</Text>
      ) : (
        <>
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>
          <Text style={styles.body}>{t("workspace.git.pr.watch.recipient")}</Text>
          <View style={settingsStyles.card} accessibilityRole="radiogroup">
            {agents.map((agent, index) => (
              <RecipientRow
                key={agent.id}
                agent={agent}
                selected={selectedId === agent.id}
                disabled={pending}
                withBorder={index > 0}
                onSelect={select}
              />
            ))}
          </View>
        </>
      )}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </AdaptiveModalSheet>
  );
}

function RecipientRow({
  agent,
  selected,
  disabled,
  withBorder,
  onSelect,
}: {
  agent: Agent;
  selected: boolean;
  disabled: boolean;
  withBorder: boolean;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const press = useCallback(() => onSelect(agent.id), [agent.id, onSelect]);
  const accessibilityState = useMemo(() => ({ checked: selected, disabled }), [disabled, selected]);
  const rowStyle = useMemo(
    () => [settingsStyles.row, withBorder && settingsStyles.rowBorder, selected && styles.selected],
    [selected, withBorder],
  );
  return (
    <PressHighlight
      accessibilityRole="radio"
      accessibilityState={accessibilityState}
      aria-checked={selected}
      disabled={disabled}
      onPress={press}
      style={rowStyle}
      testID={`pr-watch-agent-${agent.id}`}
    >
      <View style={settingsStyles.rowContent}>
        <Text numberOfLines={2} style={settingsStyles.rowTitle}>
          {resolveAgentLabel(agent.title) ?? t("workspace.git.pr.watch.untitledAgent")}
        </Text>
        <Text style={settingsStyles.rowHint}>{agent.provider}</Text>
      </View>
      {selected ? <Text style={styles.check}>✓</Text> : null}
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { color: theme.colors.foregroundMuted },
  title: { color: theme.colors.foreground, fontWeight: "600" },
  error: { color: theme.colors.destructive },
  selected: { backgroundColor: theme.colors.surface2 },
  check: { color: theme.colors.foreground, paddingHorizontal: theme.spacing[2] },
}));

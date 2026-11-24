import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { resolveAgentLabel } from "@/agent-presentation";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useToast } from "@/contexts/toast-context";
import { getFocusedAgentId } from "@/plugins/command-center/context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { settingsStyles } from "@/styles/settings";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import type { PrState } from "./data";

interface WatchSetupProps {
  serverId: string;
  workspaceId: string;
  url: string;
  title: string;
  abbreviation: string;
  style: StyleProp<ViewStyle>;
}

export function PullRequestWatchAction({
  state,
  workspaceId,
  ...setup
}: Omit<WatchSetupProps, "workspaceId"> & {
  workspaceId?: string | null;
  state: PrState;
}) {
  if (!workspaceId || (state !== "open" && state !== "draft")) return null;
  return <WatchSetup {...setup} workspaceId={workspaceId} />;
}

function WatchSetup({ serverId, workspaceId, url, title, abbreviation, style }: WatchSetupProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  // COMPAT(agentChangeRequestSubscribe): added after v0.17.4, remove after 2027-05-25.
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.agentChangeRequestSubscribe === true,
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

  const [visible, setVisible] = useState(false);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const selectedId = agents.find((agent) => agent.id === agentId)?.id;
  const label = t("workspace.git.pr.watch.action", { abbreviation });
  const header = useMemo(() => ({ title: label }), [label]);

  const open = useCallback(() => {
    if (!error) {
      const layout =
        useWorkspaceLayoutStore.getState().layoutByWorkspace[`${serverId}:${workspaceId}`];
      const focusedId = getFocusedAgentId(layout ?? null);
      const focused = agents.find((agent) => agent.id === focusedId);
      setAgentId(focused?.id ?? (agents.length === 1 ? agents[0].id : null));
    }
    setVisible(true);
  }, [agents, error, serverId, workspaceId]);

  const close = useCallback(() => setVisible(false), []);
  const select = useCallback((id: string) => {
    setAgentId(id);
    setError(null);
  }, []);

  const confirm = useCallback(async () => {
    if (submitting.current || !supported || !selectedId) return;
    if (!client) {
      setError(t("workspace.git.pr.watch.disconnected"));
      return;
    }
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      if (!(await client.subscribeAgentChangeRequest({ agentId: selectedId, url }))) {
        setError(t("workspace.git.pr.watch.closed", { abbreviation }));
        return;
      }
      setVisible(false);
      toast.show(t("workspace.git.pr.watch.started"), { variant: "success" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("workspace.git.pr.watch.failed"));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }, [abbreviation, client, selectedId, supported, t, toast, url]);

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
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onPress={open}
        style={style}
        testID="pr-pane-watch"
      >
        {label}
      </Button>
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
    </>
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

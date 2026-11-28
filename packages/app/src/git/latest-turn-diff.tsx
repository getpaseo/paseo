import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import type { DiffState } from "@getpaseo/client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DiffDocument } from "@/git/diff-document";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

const mode = { kind: "commit" } as const;

export function LatestTurnDiff({
  serverId,
  workspaceId,
  defaultAgentId,
  displayPreferences,
  ignoreWhitespace,
  enabled,
}: {
  serverId: string;
  workspaceId: string;
  defaultAgentId?: string;
  displayPreferences: Parameters<typeof DiffDocument>[0]["displayPreferences"];
  ignoreWhitespace: boolean;
  enabled: boolean;
}) {
  const { t } = useTranslation();
  const [selection, setSelection] = useState(defaultAgentId);
  const agents = useSessionStore(
    useShallow((state) =>
      [...(state.sessions[serverId]?.agents.values() ?? [])].filter(
        (agent) => agent.workspaceId === workspaceId && !agent.archivedAt && !agent.background,
      ),
    ),
  );
  const selectedAgent = useSessionStore((state) => {
    if (selection === undefined) return undefined;
    const session = state.sessions[serverId];
    const selected = session?.agents.get(selection) ?? session?.agentDetails.get(selection);
    return selected?.workspaceId === workspaceId && !selected.background ? selected : undefined;
  });
  const agent = selection === undefined && agents.length === 1 ? agents[0] : selectedAgent;
  const showAgentPicker =
    agents.length > 1 ||
    (agents.length === 1 && selection !== undefined && agents[0]?.id !== selection);
  const changes = agent?.latestTurnChanges;
  const running = agent?.status === "running" || (agent != null && agent.turn.phase !== "idle");
  const label = (candidate: (typeof agents)[number]) => candidate.title || candidate.id.slice(0, 8);

  let body;
  if (running) {
    body = <Text style={styles.message}>{t("workspace.git.diff.latestTurnRunning")}</Text>;
  } else if (agent && changes) {
    body = (
      <TurnDiffDocument
        key={`${agent.id}:${changes.turnId}:${ignoreWhitespace}`}
        serverId={serverId}
        cwd={agent.cwd}
        before={changes.before}
        after={changes.after}
        enabled={enabled}
        ignoreWhitespace={ignoreWhitespace}
        displayPreferences={displayPreferences}
      />
    );
  } else {
    const message =
      agents.length > 1 && selection === undefined
        ? "latestTurnChooseAgent"
        : "latestTurnUnavailable";
    body = <Text style={styles.message}>{t(`workspace.git.diff.${message}`)}</Text>;
  }

  return (
    <View style={styles.container} testID="latest-turn-changes">
      <View style={styles.context}>
        <Text style={styles.message}>{t("workspace.git.diff.latestTurnDescription")}</Text>
        {showAgentPicker && (
          <DropdownMenu>
            <DropdownMenuTrigger testID="latest-turn-agent-picker" style={styles.picker}>
              <Text style={styles.pickerLabel}>
                {agent ? label(agent) : t("workspace.git.diff.latestTurnChooseAgent")}
              </Text>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {agents.map((candidate) => (
                <AgentOption
                  key={candidate.id}
                  id={candidate.id}
                  selected={agent?.id === candidate.id}
                  title={label(candidate)}
                  select={setSelection}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </View>
      {body}
    </View>
  );
}

function AgentOption({
  id,
  selected,
  title,
  select,
}: {
  id: string;
  selected: boolean;
  title: string;
  select: (id: string) => void;
}) {
  const onSelect = useCallback(() => select(id), [id, select]);
  return (
    <DropdownMenuItem selected={selected} onSelect={onSelect}>
      {title}
    </DropdownMenuItem>
  );
}

function TurnDiffDocument({
  serverId,
  cwd,
  before,
  after,
  enabled,
  displayPreferences,
  ignoreWhitespace,
}: {
  serverId: string;
  cwd: string;
  before: string;
  after: string;
  enabled: boolean;
  displayPreferences: Parameters<typeof DiffDocument>[0]["displayPreferences"];
  ignoreWhitespace: boolean;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const [diff, setDiff] = useState<DiffState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client || !enabled) return;
    const subscription = client.observeDiff({
      cwd,
      base: { kind: "rev", rev: before },
      head: { kind: "rev", rev: after },
      ignoreWhitespace,
    });
    const unsubscribe = subscription.subscribe({
      snapshot: (next) => {
        setDiff(next);
        setError(null);
      },
      update: () => {},
      error: (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    });
    return () => {
      unsubscribe();
      void subscription.release();
    };
  }, [after, before, client, cwd, enabled, ignoreWhitespace]);

  if (error) return <Text style={styles.message}>{error}</Text>;
  if (!diff || diff.phase === "loading")
    return <Text style={styles.message}>{t("common.loading")}</Text>;
  if (diff.phase === "error") return <Text style={styles.message}>{diff.error.message}</Text>;
  if (diff.diffTooLarge)
    return <Text style={styles.message}>{t("workspace.git.diff.tooLarge")}</Text>;
  if (diff.files.length === 0) return <Text style={styles.message}>{t("diffViewer.empty")}</Text>;
  return <DiffDocument files={diff.files} displayPreferences={displayPreferences} mode={mode} />;
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  context: { padding: theme.spacing[2], gap: theme.spacing[2], alignItems: "flex-start" },
  message: { color: theme.colors.foregroundMuted, padding: theme.spacing[2] },
  picker: {
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  pickerLabel: { color: theme.colors.foreground },
}));

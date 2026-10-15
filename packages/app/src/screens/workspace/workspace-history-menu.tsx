import { useCallback, useMemo, useRef, useState } from "react";
import { Text } from "react-native";
import { useRouter, type Href } from "expo-router";
import { History } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuHint,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { useProviderIcon } from "@/components/provider-icons";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useAgentHistory } from "@/hooks/use-agent-history";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useCompactTimeAgo } from "@/hooks/use-time-ago";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { toErrorMessage } from "@/utils/error-messages";

const ThemedHistory = withUnistyles(History);

export function WorkspaceHistoryMenu({
  serverId,
  workspaceId,
  revealed = true,
}: {
  serverId: string;
  workspaceId: string;
  revealed?: boolean;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const compact = useIsCompactFormFactor();
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const reopening = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // COMPAT(workspaceAgentHistory): added in v0.11.1; remove after 2027-04-12 once the daemon floor supports workspace filtering.
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.workspaceAgentHistory === true,
  );
  const history = useAgentHistory({ serverId, workspaceId, enabled: open && supported });
  const agents = history.agents.filter((agent) => agent.archivedAt != null);
  const loadFailed = history.isError || history.hostErrors.length > 0;

  const handleFocus = useCallback(() => setFocused(true), []);
  const handleBlur = useCallback(() => setFocused(false), []);
  const reopen = useCallback(
    async (agent: AggregatedAgent) => {
      if (reopening.current) return;
      if (!client || !isConnected) {
        setError(t("workspace.terminal.hostDisconnected"));
        return;
      }
      reopening.current = true;
      setPendingId(agent.id);
      setError(null);
      try {
        await client.refreshAgent(agent.id);
        setOpen(false);
        router.navigate(buildHostAgentDetailRoute(serverId, agent.id, workspaceId) as Href);
      } catch (cause) {
        setError(`${t("workspaceHistory.reopenError")} ${toErrorMessage(cause)}`);
      } finally {
        reopening.current = false;
        setPendingId(null);
      }
    },
    [client, isConnected, router, serverId, workspaceId, t],
  );

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} compactMode="sheet">
      <ToolbarButton
        kind="menu"
        label={t("workspaceHistory.title")}
        testID="workspace-history-trigger"
        compact={compact}
        selected={open}
        onFocus={handleFocus}
        onBlur={handleBlur}
        style={!revealed && !focused && !open && !compact && !isNative ? styles.hidden : undefined}
      >
        <ThemedHistory size={16} uniProps={mutedIconColorMapping} />
      </ToolbarButton>
      <DropdownMenuContent
        testID="workspace-history-menu"
        align="end"
        side="bottom"
        minWidth={300}
        maxHeight={360}
        scrollable
        sheetTitle={t("workspaceHistory.title")}
      >
        {!supported ? (
          <Text style={styles.message}>{t("workspaceHistory.updateHost")}</Text>
        ) : (
          <>
            {history.isInitialLoad ? (
              <DropdownMenuHint>{t("common.loading")}</DropdownMenuHint>
            ) : null}
            {loadFailed ? (
              <>
                <Text style={styles.message} accessibilityRole="alert">
                  {isConnected
                    ? t("workspaceHistory.loadError")
                    : t("workspace.terminal.hostDisconnected")}
                </Text>
                <DropdownMenuItem closeOnSelect={false} onSelect={history.refreshAll}>
                  {t("common.actions.retry")}
                </DropdownMenuItem>
              </>
            ) : null}
            {error ? (
              <Text
                style={styles.message}
                accessibilityRole="alert"
                testID="workspace-history-error"
              >
                {error}
              </Text>
            ) : null}
            {agents.map((agent) => (
              <HistoryItem
                key={agent.id}
                agent={agent}
                pending={pendingId === agent.id}
                disabled={pendingId !== null}
                onReopen={reopen}
              />
            ))}
            {!history.isInitialLoad && !loadFailed && agents.length === 0 && !history.hasMore ? (
              <DropdownMenuHint>{t("workspaceHistory.empty")}</DropdownMenuHint>
            ) : null}
            {history.hasMore ? (
              <DropdownMenuItem
                closeOnSelect={false}
                disabled={history.isLoadingMore}
                loading={history.isLoadingMore}
                onSelect={history.loadMore}
              >
                {t("sessions.actions.loadMore")}
              </DropdownMenuItem>
            ) : null}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HistoryItem({
  agent,
  pending,
  disabled,
  onReopen,
}: {
  agent: AggregatedAgent;
  pending: boolean;
  disabled: boolean;
  onReopen: (agent: AggregatedAgent) => Promise<void>;
}) {
  const { t } = useTranslation();
  const Icon = useProviderIcon(agent.provider, agent.serverId);
  const ThemedIcon = useMemo(() => withUnistyles(Icon), [Icon]);
  const time = useCompactTimeAgo(agent.archivedAt ?? null);
  const onSelect = useCallback(() => void onReopen(agent), [onReopen, agent]);
  const leading = useMemo(
    () => <ThemedIcon size={14} uniProps={mutedIconColorMapping} />,
    [ThemedIcon],
  );
  const trailing = useMemo(() => <Text style={styles.time}>{time}</Text>, [time]);
  return (
    <DropdownMenuItem
      testID={`workspace-history-agent-${agent.id}`}
      closeOnSelect={false}
      disabled={disabled}
      loading={pending}
      onSelect={onSelect}
      leading={leading}
      trailing={trailing}
    >
      {agent.title ?? t("agentList.fallbackTitle")}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  hidden: { opacity: 0 },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[3],
  },
  time: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));

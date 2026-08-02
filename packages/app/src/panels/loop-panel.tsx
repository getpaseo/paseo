import { useEffect, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { RefreshCw } from "lucide-react-native";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { useSessionStore } from "@/stores/session-store";
import { refreshLoops, useLoopStore } from "@/loops/store";
import { useLoopLogs } from "@/loops/use-loop-logs";

function useLoopPanelDescriptor(
  target: { kind: "loop"; loopId: string },
  context: { serverId: string },
): PanelDescriptor {
  const loop = useLoopStore((state) =>
    (state.loopsByServer.get(context.serverId) ?? []).find((item) => item.id === target.loopId),
  );
  const label = loop?.name?.trim() || target.loopId;
  return {
    label,
    subtitle: "Loop",
    tooltip: label,
    titleState: loop ? "ready" : "loading",
    icon: RefreshCw,
    statusBucket: loop?.status === "running" ? "running" : null,
  };
}

function LoopPanel() {
  const { t } = useTranslation();
  const { serverId, target } = usePaneContext();
  const { isPaneFocused } = usePaneFocus();
  invariant(target.kind === "loop", "LoopPanel requires loop target");
  const loop = useLoopStore(
    (state) =>
      (state.loopsByServer.get(serverId) ?? []).find((item) => item.id === target.loopId) ?? null,
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);

  useEffect(() => {
    if (!client) return;
    void refreshLoops(client, serverId).catch(() => undefined);
  }, [client, serverId]);

  const { text, error, loading } = useLoopLogs({
    serverId,
    loopId: target.loopId,
    isPaneFocused,
  });

  const title = loop?.name?.trim() || target.loopId;
  const status = loop?.status ?? "unknown";
  const activeIteration = loop?.activeIteration;
  const roleParts = [
    loop?.activeWorkerAgentId ? t("loops.roleWorker") : null,
    loop?.activeVerifierAgentId ? t("loops.roleVerifier") : null,
  ].filter(Boolean);
  const body = useMemo(() => {
    if (text.trim().length > 0) return text;
    if (loading) return t("common.states.loading");
    if (error) return error;
    return t("loops.noLiveLog");
  }, [error, loading, t, text]);

  return (
    <View style={styles.root} testID="loop-panel">
      <View style={styles.header}>
        <Text style={styles.command} numberOfLines={2}>
          {title}
        </Text>
        <Text style={styles.meta}>
          {status}
          {activeIteration != null ? ` · ${t("loops.iteration", { count: activeIteration })}` : ""}
          {roleParts.length > 0 ? ` · ${roleParts.join(" / ")}` : ""}
        </Text>
      </View>
      <ScrollView style={styles.logScroll} contentContainerStyle={styles.logContent}>
        <Text style={styles.logText} selectable>
          {body}
        </Text>
      </ScrollView>
    </View>
  );
}

export const loopPanelRegistration: PanelRegistration<"loop"> = {
  kind: "loop",
  component: LoopPanel,
  useDescriptor: useLoopPanelDescriptor,
};

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  header: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    gap: theme.spacing[1],
  },
  command: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "capitalize",
  },
  logScroll: {
    flex: 1,
  },
  logContent: {
    padding: theme.spacing[4],
  },
  logText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
}));

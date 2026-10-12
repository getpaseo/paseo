import { useCallback, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { RefreshCw, X } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { MaterialFileIcon } from "@/components/material-file-icon";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
import { useSessionStore } from "@/stores/session-store";
import type { TaskArtifact } from "@getpaseo/protocol/messages";
import { canPreviewFile } from "./types";
import { performFileAction } from "./actions";

export function TaskArtifactsList({
  serverId,
  agentId,
  onOpen,
}: {
  serverId: string;
  agentId: string | null;
  onOpen(path: string): void;
}) {
  const { t } = useTranslation();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.taskArtifacts === true,
  );
  const cwd = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return agentId
      ? (session?.agents.get(agentId) ?? session?.agentDetails.get(agentId))?.cwd
      : undefined;
  });
  const active = useRetainedPanelActive();
  const appVisible = useAppActivelyVisible();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["task-artifacts", serverId, agentId], [serverId, agentId]);
  const query = useFetchQuery({
    // Each conversation owns its snapshot; never show the previous task's files.
    dataShape: "value",
    staleTimeMs: 3000,
    queryKey,
    enabled: Boolean(client && supported && agentId && active && appVisible),
    refetchInterval: active && appVisible ? 5000 : false,
    queryFn: async () => {
      if (!client || !agentId) throw new Error(t("fileAccess.disconnected"));
      const result = await client.getTaskArtifacts(agentId);
      if (result.error) throw new Error(result.error);
      return result.items;
    },
  });
  const remove = useMutation({
    mutationFn: async (input: { path: string; agentId: string; queryKey: typeof queryKey }) => {
      if (!client) throw new Error(t("fileAccess.disconnected"));
      const result = await client.updateTaskArtifact(input.agentId, "remove", input.path);
      if (result.error) throw new Error(result.error);
      return result.items;
    },
    onSuccess: (items, input) => queryClient.setQueryData(input.queryKey, items),
  });
  const { mutate: removeArtifact } = remove;
  const removePath = useCallback(
    (path: string) => {
      if (agentId) removeArtifact({ path, agentId, queryKey });
    },
    [agentId, queryKey, removeArtifact],
  );
  const open = useMutation({
    mutationFn: async (path: string) => {
      if (canPreviewFile(path)) {
        onOpen(path);
        return;
      }
      if (!client || !cwd) throw new Error(t("fileAccess.disconnected"));
      await performFileAction({ client, target: { serverId, cwd, path }, action: "external" });
    },
  });
  const { refetch } = query;
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);
  const items = query.data ?? [];
  const error = open.error ?? remove.error ?? query.error;
  return (
    <View style={styles.body} testID="task-artifacts-list">
      <View style={styles.header}>
        <View style={styles.heading}>
          <Text style={styles.title}>{t("fileAccess.artifacts")}</Text>
          <Text style={styles.count}>
            {t("fileAccess.artifactsCount", { count: items.length })}
          </Text>
        </View>
        <Button
          variant="ghost"
          size="xs"
          leftIcon={RefreshCw}
          onPress={refresh}
          accessibilityLabel={t("fileAccess.refresh")}
          loading={query.isFetching}
          disabled={!agentId || !client || !supported}
          testID="artifacts-refresh"
        />
      </View>
      <Text style={styles.hint}>{t("fileAccess.artifactsHint")}</Text>
      {!client ? <Text style={styles.hint}>{t("fileAccess.disconnected")}</Text> : null}
      {client && !supported ? <Text style={styles.hint}>{t("fileAccess.updateHost")}</Text> : null}
      {error ? <Text style={styles.error}>{error.message}</Text> : null}
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {items.map((item) => (
          <ArtifactRow
            key={item.id}
            item={item}
            onOpen={open.mutate}
            onRemove={removePath}
            removing={remove.isPending}
          />
        ))}
        {!items.length && !query.isFetching ? (
          <View style={styles.empty}>
            <Text style={styles.hint}>
              {t(agentId ? "fileAccess.artifactsEmpty" : "fileAccess.artifactsNoTask")}
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function ArtifactRow({
  item,
  onOpen,
  onRemove,
  removing,
}: {
  item: TaskArtifact;
  onOpen(path: string): void;
  onRemove(path: string): void;
  removing: boolean;
}) {
  const { t } = useTranslation();
  const open = useCallback(() => onOpen(item.path), [onOpen, item.path]);
  const remove = useCallback(() => onRemove(item.path), [onRemove, item.path]);
  let size = `${(item.size / 1024 / 1024).toFixed(1)} MB`;
  if (item.size < 1024) size = `${item.size} B`;
  else if (item.size < 1024 * 1024) size = `${(item.size / 1024).toFixed(1)} KB`;
  const fileIcon = useMemo(() => <MaterialFileIcon fileName={item.name} size={22} />, [item.name]);
  return (
    <View style={styles.row}>
      <Button
        variant="ghost"
        onPress={open}
        disabled={item.status === "missing"}
        leftIcon={fileIcon}
        style={styles.fileButton}
      >
        <View style={styles.fileText}>
          <Text style={styles.name} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {size} · {item.path}
          </Text>
          {item.status !== "ready" ? (
            <Text style={styles.meta}>{t(`fileAccess.${item.status}`)}</Text>
          ) : null}
        </View>
      </Button>
      <Button
        variant="ghost"
        size="xs"
        leftIcon={X}
        onPress={remove}
        disabled={removing}
        accessibilityLabel={`${t("fileAccess.removeArtifact")} ${item.name}`}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { flex: 1, gap: theme.spacing[3], padding: theme.spacing[3], minHeight: 160 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  heading: { flex: 1, flexDirection: "row", gap: theme.spacing[2], alignItems: "center" },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  count: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, lineHeight: 20 },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  list: { flex: 1 },
  listContent: { gap: theme.spacing[1] },
  empty: { paddingVertical: theme.spacing[6] },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  fileButton: {
    flex: 1,
    minHeight: 54,
    justifyContent: "flex-start",
    paddingHorizontal: theme.spacing[2],
  },
  fileText: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  name: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));

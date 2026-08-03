import { useCallback, useMemo } from "react";
import { FlatList, Pressable, Text, View, type ListRenderItemInfo } from "react-native";
import { GitBranch, RotateCw, Tag } from "lucide-react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { RepositoryGraphCommit } from "@getpaseo/protocol/messages";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";
import { formatTimeAgo } from "@/utils/time";
import { layoutRepositoryGraph, type RepositoryGraphRowLayout } from "./layout";
import { useRepositoryGraphHistory } from "./use-history";

const ROW_HEIGHT = 52;
const LANE_WIDTH = 14;
const LANE_PADDING = 10;
const GRAPH_COLORS = [
  "#0085d9",
  "#d9008f",
  "#00a92d",
  "#d98500",
  "#a300d9",
  "#e02d2d",
  "#00a89d",
  "#d53bdd",
  "#72ad00",
  "#dc5b23",
  "#6f24d6",
  "#bd8f00",
];
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

function getContrastingTextColor(backgroundColor: string): string {
  const red = Number.parseInt(backgroundColor.slice(1, 3), 16);
  const green = Number.parseInt(backgroundColor.slice(3, 5), 16);
  const blue = Number.parseInt(backgroundColor.slice(5, 7), 16);
  return red * 0.299 + green * 0.587 + blue * 0.114 > 150 ? "#111827" : "#ffffff";
}

function GraphCell({ row, laneCount }: { row: RepositoryGraphRowLayout; laneCount: number }) {
  const width = LANE_PADDING * 2 + laneCount * LANE_WIDTH;
  const x = (column: number) => LANE_PADDING + column * LANE_WIDTH + LANE_WIDTH / 2;
  return (
    <Svg width={width} height={ROW_HEIGHT} viewBox={`0 0 ${width} ${ROW_HEIGHT}`}>
      {row.edges.map((edge) => {
        const fromX = x(edge.from);
        const toX = x(edge.to);
        const startY = edge.startsAtCommit ? ROW_HEIGHT / 2 : 0;
        return (
          <Path
            key={`${edge.from}-${edge.to}-${edge.color}-${edge.startsAtCommit}`}
            d={`M ${fromX} ${startY} C ${fromX} ${(startY + ROW_HEIGHT) / 2}, ${toX} ${(startY + ROW_HEIGHT) / 2}, ${toX} ${ROW_HEIGHT}`}
            fill="none"
            stroke={GRAPH_COLORS[edge.color % GRAPH_COLORS.length]}
            strokeWidth={2}
          />
        );
      })}
      {!row.startsLane ? (
        <Path
          d={`M ${x(row.column)} 0 L ${x(row.column)} ${ROW_HEIGHT / 2}`}
          fill="none"
          stroke={GRAPH_COLORS[row.color % GRAPH_COLORS.length]}
          strokeWidth={2}
        />
      ) : null}
      <Circle
        cx={x(row.column)}
        cy={ROW_HEIGHT / 2}
        r={4}
        fill={GRAPH_COLORS[row.color % GRAPH_COLORS.length]}
      />
    </Svg>
  );
}

type GraphRef = RepositoryGraphCommit["refs"][number];

function RefBadge({
  refInfo,
  remote,
  color,
}: {
  refInfo: GraphRef;
  remote?: string;
  color: string;
}) {
  const RefIcon = refInfo.kind === "tag" ? Tag : GitBranch;
  const foregroundColor = getContrastingTextColor(color);
  return (
    <View style={styles.refBadge}>
      <View style={[styles.localRef, { backgroundColor: color }]}>
        <RefIcon size={12} strokeWidth={2.5} color={foregroundColor} />
        <Text style={[styles.refText, { color: foregroundColor }]}>{refInfo.name}</Text>
      </View>
      {remote ? (
        <View style={styles.remoteRef}>
          <Text style={styles.remoteRefText}>{remote}</Text>
        </View>
      ) : null}
    </View>
  );
}

function RefBadges({ refs, color }: { refs: GraphRef[]; color: string }) {
  const consumedRemotes = new Set<string>();
  const badges: Array<{ refInfo: GraphRef; remote?: string }> = refs.flatMap((refInfo) => {
    if (refInfo.kind === "remote" && consumedRemotes.has(refInfo.name)) {
      return [];
    }
    if (refInfo.kind !== "head") {
      return [{ refInfo }];
    }
    const remote = refs.find(
      (candidate) =>
        candidate.kind === "remote" &&
        candidate.name.split("/").slice(1).join("/") === refInfo.name,
    );
    if (!remote) {
      return [{ refInfo }];
    }
    consumedRemotes.add(remote.name);
    return [{ refInfo, remote: remote.name.split("/")[0] }];
  });

  return badges.map(({ refInfo, remote }) => (
    <RefBadge
      key={`${refInfo.kind}:${refInfo.name}`}
      refInfo={refInfo}
      remote={remote}
      color={color}
    />
  ));
}

function CommitRow({ row, laneCount }: { row: RepositoryGraphRowLayout; laneCount: number }) {
  return (
    <View style={styles.row} testID={`repository-graph-commit-${row.commit.shortSha}`}>
      <GraphCell row={row} laneCount={laneCount} />
      <View style={styles.commitBody}>
        <View style={styles.subjectLine}>
          <RefBadges
            refs={row.commit.refs}
            color={GRAPH_COLORS[row.color % GRAPH_COLORS.length] ?? GRAPH_COLORS[0]}
          />
          <Text style={styles.subject} numberOfLines={1}>
            {row.commit.subject}
          </Text>
        </View>
        <View style={styles.metaLine}>
          <Text style={styles.author} numberOfLines={1}>
            {row.commit.authorName}
          </Text>
          <Text style={styles.date}>{formatTimeAgo(new Date(row.commit.authorDate))}</Text>
          <Text style={styles.sha}>{row.commit.shortSha}</Text>
        </View>
      </View>
    </View>
  );
}

function State({ message, loading = false }: { message: string; loading?: boolean }) {
  return (
    <View style={styles.state}>
      {loading ? <ThemedLoadingSpinner size="small" uniProps={foregroundColorMapping} /> : null}
      <Text style={styles.stateText}>{message}</Text>
    </View>
  );
}

export function RepositoryGraphPane({
  serverId,
  cwd,
  enabled,
}: {
  serverId: string;
  cwd: string;
  enabled: boolean;
}) {
  const { t } = useTranslation();
  const query = useRepositoryGraphHistory({ serverId, cwd, enabled });
  const rows = useMemo(
    () => layoutRepositoryGraph(query.data?.commits ?? []),
    [query.data?.commits],
  );
  const laneCount = useMemo(
    () => rows.reduce((maximum, row) => Math.max(maximum, row.laneCount), 1),
    [rows],
  );
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<RepositoryGraphRowLayout>) => (
      <CommitRow row={item} laneCount={laneCount} />
    ),
    [laneCount],
  );
  const keyExtractor = useCallback((row: RepositoryGraphRowLayout) => row.commit.sha, []);
  const refetch = query.refetch;
  const handleRetry = useCallback(() => {
    void refetch();
  }, [refetch]);

  if (!query.supported) {
    return <State message={t("workspace.repositoryGraph.updateHost")} />;
  }
  if (!query.isConnected) {
    return <State message={t("workspace.terminal.hostDisconnected")} />;
  }
  if (query.isLoading && rows.length === 0) {
    return <State message={t("workspace.repositoryGraph.loading")} loading />;
  }
  if (query.error) {
    return (
      <View style={styles.state}>
        <Text style={styles.errorText}>{t("workspace.repositoryGraph.loadError")}</Text>
        <Pressable style={styles.retryButton} onPress={handleRetry}>
          <ThemedRotateCw size={14} uniProps={foregroundColorMapping} />
          <Text style={styles.retryText}>{t("workspace.repositoryGraph.retry")}</Text>
        </Pressable>
      </View>
    );
  }
  if (rows.length === 0) {
    return <State message={t("workspace.repositoryGraph.empty")} />;
  }
  return (
    <View style={styles.list}>
      <FlatList
        data={rows}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        contentContainerStyle={styles.listContent}
        testID="repository-graph-list"
      />
      {query.data?.hasMore ? (
        <View>
          <Text style={styles.limitText}>
            {t("workspace.repositoryGraph.limit", { count: rows.length })}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: { flex: 1 },
  listContent: { paddingVertical: theme.spacing[2] },
  row: {
    height: ROW_HEIGHT,
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderAccent,
  },
  commitBody: { flex: 1, minWidth: 0, justifyContent: "center", paddingRight: theme.spacing[3] },
  subjectLine: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  subject: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  metaLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  author: { maxWidth: 110, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  date: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  sha: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  refBadge: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: theme.borderRadius.base,
    overflow: "hidden",
  },
  localRef: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingLeft: theme.spacing[1],
  },
  refText: {
    fontSize: theme.fontSize.xs,
    paddingRight: theme.spacing[1],
    paddingVertical: 1,
  },
  remoteRef: {
    alignSelf: "stretch",
    justifyContent: "center",
    backgroundColor: theme.colors.surface3,
    paddingHorizontal: theme.spacing[1],
  },
  remoteRefText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontStyle: "italic",
  },
  state: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  stateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  errorText: { color: theme.colors.destructive, fontSize: theme.fontSize.sm, textAlign: "center" },
  retryButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
  },
  retryText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  limitText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
    padding: theme.spacing[3],
  },
}));

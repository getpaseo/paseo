import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { ChevronRight, FolderGit2, GitBranch, Plus } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { Href } from "expo-router";
import { router } from "expo-router";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { useNestedRepos, type NestedRepo } from "@/hooks/use-nested-repos";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { useSessionStore } from "@/stores/session-store";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedFolderGit2 = withUnistyles(FolderGit2);
const ThemedGitBranch = withUnistyles(GitBranch);
const ThemedPlus = withUnistyles(Plus);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

/** One sidebar session row entry: the projection of Agent the rows need. */
interface RepoSessionEntry {
  agentId: string;
  title: string | null;
  cwd: string;
}

/**
 * Lists git repositories nested inside a project folder. The whole section is
 * collapsible from its header; each repo is itself an accordion holding the
 * sessions (agents) whose cwd lives inside that repo, plus a trailing "+" that
 * starts a new workspace/session rooted at the repo directory. The scan is
 * one-shot on mount; `refresh` re-runs it after a project is added.
 */
export function NestedReposSection({ serverId, scanCwd }: { serverId: string; scanCwd: string }) {
  const { t } = useTranslation();
  const { repos, loading, error } = useNestedRepos(
    (sid) => getHostRuntimeStore().getClient(sid),
    serverId,
    scanCwd,
  );
  const [sectionCollapsed, setSectionCollapsed] = useState(false);
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set());

  // Stable Map reference — re-renders only when the agents map itself changes.
  const agents = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.agents : undefined,
  );

  const sessionsByRepo = useMemo(() => {
    const byRepo = new Map<string, RepoSessionEntry[]>();
    if (!agents || repos.length === 0) {
      return byRepo;
    }
    const sortedRepos = [...repos].sort((a, b) => b.path.length - a.path.length);
    for (const agent of agents.values()) {
      if (agent.archivedAt || !agent.cwd) {
        continue;
      }
      // Longest-prefix match so nested checkouts claim their own sessions.
      const repo = sortedRepos.find((candidate) => isPathInside(agent.cwd, candidate.path));
      if (!repo) {
        continue;
      }
      const entries = byRepo.get(repo.path) ?? [];
      entries.push({ agentId: agent.id, title: agent.title, cwd: agent.cwd });
      byRepo.set(repo.path, entries);
    }
    return byRepo;
  }, [agents, repos]);

  const toggleSection = useCallback(() => {
    setSectionCollapsed((current) => !current);
  }, []);

  const toggleRepo = useCallback((path: string) => {
    setExpandedRepos((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleNewSessionForRepo = useCallback(
    (repo: NestedRepo) => {
      router.navigate(
        buildNewWorkspaceRoute({
          serverId,
          sourceDirectory: repo.path,
          displayName: repo.name,
        }) as Href,
      );
    },
    [serverId],
  );

  if (loading && repos.length === 0) {
    return null;
  }
  if (repos.length === 0 && !error) {
    return null;
  }

  return (
    <View style={styles.container}>
      <Pressable
        onPress={toggleSection}
        accessibilityRole={isWeb ? undefined : "button"}
        accessibilityLabel={t("sidebar.workspace.actions.nestedRepos")}
        style={styles.headerPressable}
        testID="sidebar-nested-repos-header"
      >
        {({ hovered, pressed }) => (
          <View style={[styles.header, (hovered || pressed) && styles.headerHovered]}>
            <ThemedChevronRight
              size={12}
              uniProps={hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping}
              style={sectionCollapsed ? undefined : styles.chevronExpanded}
            />
            <Text style={styles.headerText}>{t("sidebar.workspace.actions.nestedRepos")}</Text>
            {loading ? <Text style={styles.headerLoading}>…</Text> : null}
            <Text style={styles.headerCount}>{repos.length}</Text>
          </View>
        )}
      </Pressable>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      {!sectionCollapsed &&
        repos.map((repo) => (
          <NestedRepoAccordion
            key={repo.path}
            serverId={serverId}
            repo={repo}
            sessions={sessionsByRepo.get(repo.path) ?? []}
            expanded={expandedRepos.has(repo.path)}
            onToggle={toggleRepo}
            onNewSession={handleNewSessionForRepo}
          />
        ))}
    </View>
  );
}

function isPathInside(child: string, parent: string): boolean {
  const c = child.replace(/\/+$/, "");
  const p = parent.replace(/\/+$/, "");
  return c === p || c.startsWith(`${p}/`);
}

function NestedRepoAccordion({
  serverId,
  repo,
  sessions,
  expanded,
  onToggle,
  onNewSession,
}: {
  serverId: string;
  repo: NestedRepo;
  sessions: RepoSessionEntry[];
  expanded: boolean;
  onToggle: (path: string) => void;
  onNewSession: (repo: NestedRepo) => void;
}) {
  const { t } = useTranslation();
  const handleToggle = useCallback(() => onToggle(repo.path), [onToggle, repo.path]);
  const handleNew = useCallback(() => onNewSession(repo), [onNewSession, repo]);
  const newSessionLabel = t("sidebar.workspace.actions.newSessionInRepo", { repo: repo.name });
  const plusIconProps = useCallback(
    (hovered: boolean) => (theme: Theme) => ({
      color: hovered ? theme.colors.foreground : theme.colors.foregroundMuted,
    }),
    [],
  );

  const rowStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      (hovered || pressed) && styles.rowHovered,
    ],
    [],
  );

  return (
    <View>
      <View style={styles.repoRowWrapper}>
        <Pressable
          onPress={handleToggle}
          accessibilityRole={isWeb ? undefined : "button"}
          accessibilityLabel={`${repo.name} (${repo.path})`}
          style={rowStyle}
          testID={`sidebar-nested-repo-${repo.name}`}
        >
          {({ hovered, pressed }) => (
            <>
              <ThemedChevronRight
                size={12}
                uniProps={hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping}
                style={expanded ? styles.chevronExpanded : undefined}
              />
              <ThemedFolderGit2
                size={14}
                uniProps={hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping}
              />
              <Text numberOfLines={1} style={styles.rowText}>
                {repo.name}
              </Text>
              {repo.branch ? (
                <>
                  <ThemedGitBranch size={11} uniProps={foregroundMutedColorMapping} />
                  <Text numberOfLines={1} style={styles.rowBranch}>
                    {repo.branch}
                  </Text>
                </>
              ) : null}
              {sessions.length > 0 ? <Text style={styles.rowCount}>{sessions.length}</Text> : null}
            </>
          )}
        </Pressable>
        <Pressable
          onPress={handleNew}
          accessibilityRole={isWeb ? undefined : "button"}
          accessibilityLabel={newSessionLabel}
          style={styles.newButton}
          hitSlop={6}
          testID={`sidebar-nested-repo-new-${repo.name}`}
        >
          {({ hovered, pressed }) => (
            <ThemedPlus size={13} uniProps={plusIconProps(hovered || pressed)} />
          )}
        </Pressable>
      </View>
      {expanded
        ? sessions.map((session) => (
            <RepoSessionRow key={session.agentId} serverId={serverId} session={session} />
          ))
        : null}
      {expanded && sessions.length === 0 ? (
        <Text style={styles.emptyText}>{t("sidebar.workspace.actions.noSessionsInRepo")}</Text>
      ) : null}
    </View>
  );
}

function RepoSessionRow({ serverId, session }: { serverId: string; session: RepoSessionEntry }) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    router.navigate(navigateToAgent({ serverId, agentId: session.agentId }) as unknown as Href);
  }, [serverId, session.agentId]);
  const title = session.title ?? t("importSession.preview.untitledSession");

  const rowStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.sessionRow,
      (hovered || pressed) && styles.rowHovered,
    ],
    [],
  );

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole={isWeb ? undefined : "button"}
      accessibilityLabel={title}
      style={rowStyle}
      testID={`sidebar-nested-repo-session-${session.agentId}`}
    >
      <Text numberOfLines={1} style={styles.sessionText}>
        {title}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingLeft: 16,
    paddingRight: 8,
  },
  headerPressable: {
    marginRight: 8,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 4,
    borderRadius: 4,
  },
  headerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  headerText: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  headerLoading: {
    color: theme.colors.foregroundMuted,
    fontSize: 11,
  },
  headerCount: {
    color: theme.colors.foregroundMuted,
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
  },
  errorText: {
    color: theme.colors.statusDanger,
    fontSize: 12,
    paddingVertical: 2,
  },
  repoRowWrapper: {
    flexDirection: "row",
    alignItems: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 4,
    borderRadius: 4,
    flex: 1,
    minWidth: 0,
    marginRight: 2,
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: 12,
  },
  rowBranch: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: 11,
    fontFamily: theme.fontFamily.mono,
  },
  rowCount: {
    color: theme.colors.foregroundMuted,
    fontSize: 10,
    fontFamily: theme.fontFamily.mono,
  },
  newButton: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
    marginRight: 8,
    flexShrink: 0,
  },
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 3,
    paddingLeft: 14,
    paddingRight: 4,
    borderRadius: 4,
    marginRight: 8,
  },
  sessionText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: 12,
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: 11,
    paddingLeft: 14,
    paddingVertical: 2,
  },
  chevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
}));

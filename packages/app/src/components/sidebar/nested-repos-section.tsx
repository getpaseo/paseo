import { useCallback } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { FolderGit2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { Href } from "expo-router";
import { router } from "expo-router";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { useNestedRepos, type NestedRepo } from "@/hooks/use-nested-repos";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

const ThemedFolderGit2 = withUnistyles(FolderGit2);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

/**
 * Lists git repositories nested inside a project folder, each as a row that starts
 * a session in that repo (via the existing new-workspace route). The scan is
 * one-shot on mount; `refresh` re-runs it after a project is added.
 */
export function NestedReposSection({ serverId, scanCwd }: { serverId: string; scanCwd: string }) {
  const { t } = useTranslation();
  const { repos, loading, error } = useNestedRepos(
    (sid) => getHostRuntimeStore().getClient(sid),
    serverId,
    scanCwd,
  );

  if (loading && repos.length === 0) {
    return null;
  }
  if (repos.length === 0 && !error) {
    return null;
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerText}>{t("sidebar.workspace.actions.nestedRepos")}</Text>
        {loading ? <Text style={styles.headerLoading}>…</Text> : null}
      </View>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      {repos.map((repo) => (
        <NestedRepoRow key={repo.path} repo={repo} serverId={serverId} />
      ))}
    </View>
  );
}

function NestedRepoRow({ repo, serverId }: { repo: NestedRepo; serverId: string }) {
  const handlePress = useCallback(() => {
    router.navigate(
      buildNewWorkspaceRoute({
        serverId,
        sourceDirectory: repo.path,
        displayName: repo.name,
      }) as Href,
    );
  }, [repo.path, repo.name, serverId]);

  const rowStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      hovered && !pressed && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [],
  );

  return (
    <Pressable
      accessibilityRole={isWeb ? undefined : "button"}
      accessibilityLabel={`${repo.name} (${repo.path})`}
      onPress={handlePress}
      style={rowStyle}
      testID={`sidebar-nested-repo-${repo.name}`}
    >
      {({ hovered, pressed }) => (
        <>
          <ThemedFolderGit2
            size={14}
            uniProps={hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping}
          />
          <Text numberOfLines={1} style={styles.rowText}>
            {repo.name}
          </Text>
        </>
      )}
    </Pressable>
  );
}

// The host runtime store is reachable from anywhere.

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingLeft: 16,
    paddingRight: 8,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
  },
  headerText: {
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
  errorText: {
    color: theme.colors.statusDanger,
    fontSize: 12,
    paddingVertical: 2,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 4,
    borderRadius: 4,
    marginRight: 8,
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  rowText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: 12,
  },
}));

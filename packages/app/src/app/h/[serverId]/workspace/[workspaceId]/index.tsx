import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useNavigation } from "expo-router/react-navigation";
import { StyleSheet, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { RetainedPanel } from "@/components/retained-panel";
import {
  type ActiveWorkspaceSelection,
  useActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useHasHydratedWorkspaces, useWorkspaceExists } from "@/stores/session-store-hooks";
import { useDirectoryDemand } from "@/hooks/use-directory-demand";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { WorkspaceScreen } from "@/screens/workspace/workspace-screen";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  areRetainedWorkspaceSelectionListsEqual,
  areWorkspaceSelectionsEqual,
  getNextWorkspaceDeckExpirationDelay,
  getWorkspaceSelectionKey,
  orderWorkspaceSelectionsForStableRender,
  reconcileRetainedWorkspaceSelections,
  resolveWorkspaceDeckRetentionLimit,
  type RetainedWorkspaceSelection,
  resolveWorkspaceDeckEntries,
  shouldKeepWorkspaceDeckEntryMounted,
} from "@/screens/workspace/workspace-deck-retention";
import {
  decodeWorkspaceIdFromPathSegment,
  parseWorkspaceOpenIntent,
  type WorkspaceOpenIntent,
} from "@/utils/host-routes";
import {
  replaceBrowserRouteWithCanonicalHostWorkspaceRoute,
  stripHostWorkspaceRouteEchoSearchFromBrowserUrlAfterCommit,
} from "@/utils/host-route-browser";
import { prepareWorkspaceTab } from "@/utils/prepare-workspace-tab";
import { isNative, isWeb } from "@/constants/platform";
import { RenderProfile } from "@/utils/render-profiler";

function getParamValue(value: string | string[] | undefined): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const firstValue = value[0];
    return typeof firstValue === "string" ? firstValue.trim() : "";
  }
  return "";
}

function getOpenIntentTarget(openIntent: WorkspaceOpenIntent): WorkspaceTabTarget {
  if (openIntent.kind === "agent") {
    return { kind: "agent", agentId: openIntent.agentId };
  }
  if (openIntent.kind === "terminal") {
    return { kind: "terminal", terminalId: openIntent.terminalId };
  }
  if (openIntent.kind === "file") {
    return { kind: "file", path: openIntent.path };
  }
  if (openIntent.kind === "setup") {
    return { kind: "setup", workspaceId: openIntent.workspaceId };
  }
  return { kind: "draft", draftId: openIntent.draftId };
}

// COMPAT(workspace-open-url): added in v0.12.0, remove after 2027-01-22.
// Bookmarks and older clients still send ?open=; internal navigation uses pending model state.
function stripOpenSearchParamFromBrowserUrl() {
  if (!isWeb || typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  if (!url.searchParams.has("open")) {
    return;
  }
  url.searchParams.delete("open");
  replaceBrowserRouteWithCanonicalHostWorkspaceRoute(`${url.pathname}${url.search}${url.hash}`);
}

function clearConsumedOpenIntent(input: {
  navigation: { setParams: (params: { open?: string | undefined }) => void };
}) {
  input.navigation.setParams({ open: undefined });
  if (isWeb) {
    // Expo commits the incoming browser URL after setParams. Strip the consumed legacy input
    // after that commit so it cannot be restored into the address bar and replayed on reload.
    window.setTimeout(stripOpenSearchParamFromBrowserUrl, 0);
  }
}

export default function HostWorkspaceIndexRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <HostWorkspaceRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function HostWorkspaceRouteContent() {
  const navigation = useNavigation();
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    workspaceId?: string | string[];
    open?: string | string[];
  }>();
  const serverId = getParamValue(params.serverId);
  const workspaceValue = getParamValue(params.workspaceId);
  const workspaceId = workspaceValue
    ? (decodeWorkspaceIdFromPathSegment(workspaceValue) ?? "")
    : "";
  const openValue = getParamValue(params.open);
  // A restored workspace with no open chat has nothing else demanding its host's directory on a
  // phone, where the sidebar only demands while its panel is active. Without demand the deck
  // waits on workspace hydration that never starts.
  useDirectoryDemand(serverId);
  useEffect(() => {
    if (!serverId || !workspaceId) {
      return;
    }
    stripHostWorkspaceRouteEchoSearchFromBrowserUrlAfterCommit();
  }, [serverId, workspaceId]);

  useLayoutEffect(() => {
    if (!openValue || !serverId || !workspaceId) return;
    const openIntent = parseWorkspaceOpenIntent(openValue);
    if (openIntent) {
      prepareWorkspaceTab(
        {
          serverId,
          workspaceId,
          target: getOpenIntentTarget(openIntent),
          pin: openIntent.kind === "agent",
        },
        { openTab: useWorkspaceLayoutStore.getState().deferOpenTab },
      );
    }
    clearConsumedOpenIntent({
      navigation: navigation as unknown as {
        setParams: (params: { open?: string | undefined }) => void;
      },
    });
  }, [navigation, openValue, serverId, workspaceId]);

  return <WorkspaceDeck />;
}

function WorkspaceDeck() {
  const activeSelection = useActiveWorkspaceSelection();
  const [retainedSelections, setRetainedSelections] = useState<RetainedWorkspaceSelection[]>(() =>
    activeSelection ? [{ selection: activeSelection, inactiveSince: null }] : [],
  );
  const unmountWorkspaceSelection = useCallback((selection: ActiveWorkspaceSelection) => {
    setRetainedSelections((current) =>
      current.filter((entry) => !areWorkspaceSelectionsEqual(entry.selection, selection)),
    );
  }, []);

  const reconciliationNow = Date.now();
  const nextRetainedSelections = useMemo(
    () =>
      reconcileRetainedWorkspaceSelections({
        currentEntries: retainedSelections,
        activeSelection,
        now: reconciliationNow,
        maxMountedWorkspaces: resolveWorkspaceDeckRetentionLimit({ isNative }),
      }),
    [activeSelection, reconciliationNow, retainedSelections],
  );
  const renderedSelections = useMemo(
    () =>
      orderWorkspaceSelectionsForStableRender(
        nextRetainedSelections.map((entry) => entry.selection),
      ),
    [nextRetainedSelections],
  );
  const renderedEntries = useMemo(
    () => resolveWorkspaceDeckEntries({ selections: renderedSelections, activeSelection }),
    [activeSelection, renderedSelections],
  );

  useLayoutEffect(() => {
    if (!areRetainedWorkspaceSelectionListsEqual(retainedSelections, nextRetainedSelections)) {
      setRetainedSelections(nextRetainedSelections);
    }
  }, [nextRetainedSelections, retainedSelections]);

  useEffect(() => {
    const expirationDelay = getNextWorkspaceDeckExpirationDelay({
      entries: nextRetainedSelections,
      activeSelection,
      now: reconciliationNow,
    });
    if (expirationDelay === null) {
      return;
    }
    const timeout = setTimeout(() => {
      setRetainedSelections((current) =>
        reconcileRetainedWorkspaceSelections({
          currentEntries: current,
          activeSelection,
          now: Date.now(),
          maxMountedWorkspaces: resolveWorkspaceDeckRetentionLimit({ isNative }),
        }),
      );
    }, expirationDelay + 1);
    return () => clearTimeout(timeout);
  }, [activeSelection, nextRetainedSelections, reconciliationNow]);

  return (
    <RenderProfile id="WorkspaceDeck">
      <View style={styles.deck}>
        {renderedEntries.map(({ selection, active }) => {
          return (
            <WorkspaceDeckEntry
              key={getWorkspaceSelectionKey(selection)}
              selection={selection}
              active={active}
              onUnmountInactive={unmountWorkspaceSelection}
            />
          );
        })}
      </View>
    </RenderProfile>
  );
}

function WorkspaceDeckEntry({
  selection,
  active,
  onUnmountInactive,
}: {
  selection: ActiveWorkspaceSelection;
  active: boolean;
  onUnmountInactive: (selection: ActiveWorkspaceSelection) => void;
}) {
  const hasHydratedWorkspaces = useHasHydratedWorkspaces(selection.serverId);
  const workspaceExists = useWorkspaceExists(selection.serverId, selection.workspaceId);
  const shouldKeepMounted = shouldKeepWorkspaceDeckEntryMounted({
    isActive: active,
    hasHydratedWorkspaces,
    workspaceExists,
  });

  useEffect(() => {
    if (!shouldKeepMounted) {
      onUnmountInactive(selection);
    }
  }, [onUnmountInactive, selection, shouldKeepMounted]);

  if (!shouldKeepMounted) {
    return null;
  }

  return (
    <RetainedPanel
      active={active}
      testID={`workspace-deck-entry-${selection.serverId}:${selection.workspaceId}`}
    >
      <WorkspaceScreen
        serverId={selection.serverId}
        workspaceId={selection.workspaceId}
        isRouteFocused={active}
      />
    </RetainedPanel>
  );
}

const styles = StyleSheet.create({
  deck: {
    flex: 1,
  },
});

import { useEffect, useRef, useState } from "react";
import { useNavigation } from "@react-navigation/native";
import { StyleSheet, View } from "react-native";
import { useGlobalSearchParams, useLocalSearchParams, useRootNavigationState } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import {
  type ActiveWorkspaceSelection,
  useActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import { WorkspaceScreen } from "@/screens/workspace/workspace-screen";
import { useWorkspaceLayoutStoreHydrated } from "@/stores/workspace-layout-store";
import {
  areWorkspaceSelectionListsEqual,
  areWorkspaceSelectionsEqual,
  getWorkspaceSelectionKey,
  pruneMountedWorkspaceSelections,
  WORKSPACE_DECK_MAX_MOUNTED_WORKSPACES,
} from "@/screens/workspace/workspace-deck-retention";
import {
  decodeWorkspaceIdFromPathSegment,
  parseWorkspaceOpenIntent,
  type WorkspaceOpenIntent,
} from "@/utils/host-routes";
import { prepareWorkspaceTab } from "@/utils/workspace-navigation";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-execution";
import { isWeb } from "@/constants/platform";

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

function stripOpenSearchParamFromBrowserUrl() {
  if (!isWeb || typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  if (!url.searchParams.has("open")) {
    return;
  }
  url.searchParams.delete("open");
  window.history.replaceState(null, "", url.toString());
}

function clearConsumedOpenIntent(input: {
  navigation: { setParams: (params: { open?: string | undefined }) => void };
}) {
  input.navigation.setParams({ open: undefined });
  if (isWeb) {
    stripOpenSearchParamFromBrowserUrl();
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
  const rootNavigationState = useRootNavigationState();
  const hasHydratedWorkspaceLayoutStore = useWorkspaceLayoutStoreHydrated();
  const consumedIntentRef = useRef<string | null>(null);
  const [intentConsumed, setIntentConsumed] = useState(false);
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    workspaceId?: string | string[];
  }>();
  const globalParams = useGlobalSearchParams<{
    open?: string | string[];
  }>();
  const serverId = getParamValue(params.serverId);
  const workspaceValue = getParamValue(params.workspaceId);
  const workspaceId = workspaceValue
    ? (decodeWorkspaceIdFromPathSegment(workspaceValue) ?? "")
    : "";
  const openValue = getParamValue(globalParams.open);
  useEffect(() => {
    if (!openValue) {
      return;
    }
    if (!rootNavigationState?.key) {
      return;
    }
    if (!hasHydratedWorkspaceLayoutStore) {
      return;
    }

    const consumptionKey = `${serverId}:${workspaceId}:${openValue}`;
    if (consumedIntentRef.current === consumptionKey) {
      clearConsumedOpenIntent({
        navigation: navigation as unknown as {
          setParams: (params: { open?: string | undefined }) => void;
        },
      });
      setIntentConsumed(true);
      return;
    }
    consumedIntentRef.current = consumptionKey;

    const openIntent = parseWorkspaceOpenIntent(openValue);
    if (openIntent) {
      prepareWorkspaceTab({
        serverId,
        workspaceId,
        target: getOpenIntentTarget(openIntent),
        pin: openIntent.kind === "agent",
      });
    }

    // Expo Router's replace ignores query-param-only changes (findDivergentState
    // skips search params). Strip ?open from the browser URL directly so the
    // address bar reflects the clean workspace route.
    clearConsumedOpenIntent({
      navigation: navigation as unknown as {
        setParams: (params: { open?: string | undefined }) => void;
      },
    });

    setIntentConsumed(true);
  }, [
    hasHydratedWorkspaceLayoutStore,
    navigation,
    openValue,
    rootNavigationState?.key,
    serverId,
    workspaceId,
  ]);

  if (openValue && (!intentConsumed || !hasHydratedWorkspaceLayoutStore)) {
    return null;
  }

  return <WorkspaceDeck />;
}

function WorkspaceDeck() {
  const activeSelection = useActiveWorkspaceSelection();
  const activeServerId = activeSelection?.serverId ?? null;
  const workspaces = useSessionStore((state) =>
    activeServerId ? state.sessions[activeServerId]?.workspaces : undefined,
  );
  const hasHydratedWorkspaces = useSessionStore((state) =>
    activeServerId ? (state.sessions[activeServerId]?.hasHydratedWorkspaces ?? false) : false,
  );
  const [mountedSelections, setMountedSelections] = useState<ActiveWorkspaceSelection[]>(() =>
    activeSelection ? [activeSelection] : [],
  );

  useEffect(() => {
    setMountedSelections((current) => {
      const next = pruneMountedWorkspaceSelections({
        currentSelections: current,
        activeSelection,
        maxMountedWorkspaces: WORKSPACE_DECK_MAX_MOUNTED_WORKSPACES,
        shouldPruneInactiveSelections: hasHydratedWorkspaces,
        canRetainInactiveSelection: (selection) => {
          if (selection.serverId !== activeServerId) {
            return false;
          }
          return Boolean(
            resolveWorkspaceMapKeyByIdentity({
              workspaces,
              workspaceId: selection.workspaceId,
            }),
          );
        },
      });
      if (areWorkspaceSelectionListsEqual(current, next)) {
        return current;
      }
      return next;
    });
  }, [activeSelection, activeServerId, hasHydratedWorkspaces, workspaces]);

  if (!activeSelection) {
    return null;
  }

  return (
    <View style={styles.deck}>
      {mountedSelections.map((selection) => {
        const isActive = areWorkspaceSelectionsEqual(selection, activeSelection);
        return (
          <View
            key={getWorkspaceSelectionKey(selection)}
            style={isActive ? styles.activeDeckEntry : styles.inactiveDeckEntry}
            testID={`workspace-deck-entry-${selection.serverId}:${selection.workspaceId}`}
          >
            <WorkspaceScreen
              serverId={selection.serverId}
              workspaceId={selection.workspaceId}
              isRouteFocused={isActive}
            />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  deck: {
    flex: 1,
  },
  activeDeckEntry: {
    flex: 1,
  },
  inactiveDeckEntry: {
    display: "none",
    flex: 1,
  },
});

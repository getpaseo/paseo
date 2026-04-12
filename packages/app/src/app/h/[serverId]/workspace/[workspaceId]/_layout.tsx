import { useEffect, useRef, useState } from "react";
import { useGlobalSearchParams, useLocalSearchParams, useRootNavigationState } from "expo-router";
import { Platform } from "react-native";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import { WorkspaceScreen } from "@/screens/workspace/workspace-screen";
import {
  decodeWorkspaceIdFromPathSegment,
  parseWorkspaceOpenIntent,
  type WorkspaceOpenIntent,
} from "@/utils/host-routes";
import { prepareWorkspaceTab } from "@/utils/workspace-navigation";

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
  return { kind: "draft", draftId: openIntent.draftId };
}

export default function HostWorkspaceLayout() {
  return (
    <HostRouteBootstrapBoundary>
      <HostWorkspaceLayoutContent />
    </HostRouteBootstrapBoundary>
  );
}

function HostWorkspaceLayoutContent() {
  const rootNavigationState = useRootNavigationState();
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

    const consumptionKey = `${serverId}:${workspaceId}:${openValue}`;
    if (consumedIntentRef.current === consumptionKey) {
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
    if (Platform.OS === "web" && typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (url.searchParams.has("open")) {
        url.searchParams.delete("open");
        window.history.replaceState(null, "", url.toString());
      }
    }

    setIntentConsumed(true);
  }, [openValue, rootNavigationState?.key, serverId, workspaceId]);

  if (openValue && !intentConsumed) {
    return null;
  }

  return (
    <WorkspaceScreen
      key={`${serverId}:${workspaceId}`}
      serverId={serverId}
      workspaceId={workspaceId}
    />
  );
}

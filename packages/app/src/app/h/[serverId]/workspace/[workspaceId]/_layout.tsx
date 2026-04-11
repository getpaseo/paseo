import { useEffect, useRef } from "react";
import { useGlobalSearchParams, useLocalSearchParams, useRouter } from "expo-router";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import { WorkspaceScreen } from "@/screens/workspace/workspace-screen";
import {
  buildHostRootRoute,
  buildHostWorkspaceRoute,
  decodeWorkspaceIdFromPathSegment,
  parseWorkspaceOpenIntent,
  type WorkspaceOpenIntent,
} from "@/utils/host-routes";
import { prepareWorkspaceTab } from "@/utils/workspace-navigation";
import {
  isWorkspaceVisibleInDesktopWindow,
  useDesktopWorkspaceWindowState,
} from "@/desktop/window-workspace-state";

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
  const router = useRouter();
  const consumedIntentRef = useRef<string | null>(null);
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
  const desktopWorkspaceWindowState = useDesktopWorkspaceWindowState();

  useEffect(() => {
    if (!openValue) {
      return;
    }

    const consumptionKey = `${serverId}:${workspaceId}:${openValue}`;
    if (consumedIntentRef.current === consumptionKey) {
      return;
    }
    consumedIntentRef.current = consumptionKey;

    const openIntent = parseWorkspaceOpenIntent(openValue);
    const route = openIntent
      ? prepareWorkspaceTab({
          serverId,
          workspaceId,
          target: getOpenIntentTarget(openIntent),
          pin: openIntent.kind === "agent",
        })
      : buildHostWorkspaceRoute(serverId, workspaceId);

    router.replace(route as any);
  }, [openValue, router, serverId, workspaceId]);

  useEffect(() => {
    if (!serverId || !workspaceId || !desktopWorkspaceWindowState.isReady) {
      return;
    }
    if (isWorkspaceVisibleInDesktopWindow(desktopWorkspaceWindowState, serverId, workspaceId)) {
      return;
    }
    router.replace(buildHostRootRoute(serverId));
  }, [desktopWorkspaceWindowState, router, serverId, workspaceId]);

  if (openValue) {
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

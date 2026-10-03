import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { useFetchQuery } from "@/data/query";
import { resolveAgentRoute, type AgentRouteLookup } from "@/navigation/agent-route-resolution";
import { AgentRouteResolutionView } from "@/navigation/agent-route-resolution-view";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { useAppSettings } from "@/hooks/use-settings";
import { readLinkFlag, readLinkPrompt } from "@/intents/automation-link";
import { stagePendingPrompt } from "@/intents/pending-prompt-store";
import { LinkPromptHostOfflineError, sendLinkPrompt } from "@/intents/send-link-prompt";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useSessionStore } from "@/stores/session-store";
import { getHostRuntimeStore, useHostRuntimeSnapshot, useHosts } from "@/runtime/host-runtime";
import { buildHostRootRoute, buildSettingsHostRoute } from "@/utils/host-routes";
import { toErrorMessage } from "@/utils/error-messages";
import { navigateToAgent } from "@/utils/navigate-to-agent";

export default function HostAgentReadyRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <HostAgentReadyRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function HostAgentReadyRouteContent() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    serverId?: string;
    agentId?: string;
    prompt?: string;
    send?: string;
  }>();
  const handledNavigationRef = useRef<string | null>(null);
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const agentId = typeof params.agentId === "string" ? params.agentId : "";
  const prompt = readLinkPrompt(params.prompt);
  const send = readLinkFlag(params.send);
  const toast = useToast();
  const { t } = useTranslation();
  const { settings, isLoading: settingsLoading } = useAppSettings();
  const linkPromptSend = settings.linkPromptSend;
  const hosts = useHosts();
  const runtimeSnapshot = useHostRuntimeSnapshot(serverId);
  const client = runtimeSnapshot?.client ?? null;
  const connectionStatus = runtimeSnapshot?.connectionStatus ?? "connecting";
  const hostName = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const agentWorkspaceId = useSessionStore((state) => {
    if (!serverId || !agentId) {
      return null;
    }
    return state.sessions[serverId]?.agents?.get(agentId)?.workspaceId ?? null;
  });
  useEffect(() => {
    if (!serverId || !agentId || agentWorkspaceId) return;
    void getHostRuntimeStore()
      .prepareAgentRoute(serverId, agentId)
      .catch(() => undefined);
  }, [agentId, agentWorkspaceId, serverId]);
  const shouldLookupAgent = Boolean(
    serverId && agentId && client && connectionStatus === "online" && !agentWorkspaceId,
  );
  const lookupQuery = useFetchQuery({
    queryKey: ["agentRouteResolution", serverId, agentId, runtimeSnapshot?.clientGeneration ?? 0],
    queryFn: async () => {
      if (!client) {
        throw new Error("Target host client is unavailable");
      }
      const result = await client.fetchAgent({ agentId });
      return result?.agent?.workspaceId ?? null;
    },
    enabled: shouldLookupAgent,
    retry: false,
    dataShape: "value",
    staleTimeMs: 0,
  });
  const lookup = useMemo<AgentRouteLookup>(() => {
    if (!shouldLookupAgent) {
      return { kind: "idle" };
    }
    if (lookupQuery.isFetching) {
      return { kind: "fetching" };
    }
    if (lookupQuery.isError) {
      return { kind: "failed", error: toErrorMessage(lookupQuery.error) };
    }
    if (lookupQuery.isSuccess) {
      return { kind: "found", workspaceId: lookupQuery.data };
    }
    return { kind: "fetching" };
  }, [
    lookupQuery.data,
    lookupQuery.error,
    lookupQuery.isError,
    lookupQuery.isFetching,
    lookupQuery.isSuccess,
    shouldLookupAgent,
  ]);
  const resolution = resolveAgentRoute({
    serverId,
    agentId,
    cachedWorkspaceId: agentWorkspaceId,
    connectionStatus,
    lookup,
  });

  useEffect(() => {
    let navigationKey: string | null = null;
    if (resolution.kind === "invalid") {
      navigationKey = "invalid";
    } else if (resolution.kind === "resolved") {
      navigationKey = `workspace:${resolution.workspaceId}`;
    } else if (resolution.kind === "notFound") {
      navigationKey = "not-found";
    }
    if (!navigationKey || handledNavigationRef.current === navigationKey) {
      return;
    }
    if (prompt && send && settingsLoading) {
      return;
    }
    handledNavigationRef.current = navigationKey;

    if (resolution.kind === "resolved") {
      const openAgent = () =>
        navigateToAgent({ serverId, agentId, workspaceId: resolution.workspaceId });
      if (!prompt) {
        openAgent();
        return;
      }
      const stagePrompt = () =>
        stagePendingPrompt({
          draftKey: buildDraftStoreKey({ serverId, agentId }),
          prompt: { text: prompt, attachments: [] },
        });
      if (!send) {
        stagePrompt();
        openAgent();
        return;
      }
      // Sending without a tap is opt-in: any app can open a paseo:// link.
      if (!linkPromptSend) {
        stagePrompt();
        openAgent();
        toast.error(t("intents.links.sendDisabled"));
        return;
      }
      void sendLinkPrompt({ serverId, agentId, text: prompt })
        .then(() => {
          toast.show(t("intents.links.promptSent"));
          return undefined;
        })
        .catch((error: unknown) => {
          stagePrompt();
          toast.error(
            error instanceof LinkPromptHostOfflineError
              ? t("intents.links.hostOffline")
              : t("intents.links.sendFailed", { message: toErrorMessage(error) }),
          );
        })
        .finally(openAgent);
      return;
    }
    router.replace(resolution.kind === "invalid" ? ("/" as Href) : buildHostRootRoute(serverId));
  }, [
    agentId,
    linkPromptSend,
    prompt,
    resolution,
    router,
    send,
    serverId,
    settingsLoading,
    t,
    toast,
  ]);

  const handleRetry = useCallback(() => {
    if (resolution.kind === "lookupError") {
      void lookupQuery.refetch();
      return;
    }
    if (serverId) {
      void getHostRuntimeStore().runProbeCycleNow(serverId);
    }
  }, [lookupQuery, resolution.kind, serverId]);
  const handleManageHost = useCallback(() => {
    if (serverId) {
      router.push(buildSettingsHostRoute(serverId));
    }
  }, [router, serverId]);
  const handleBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(serverId ? buildHostRootRoute(serverId) : ("/" as Href));
  }, [router, serverId]);

  if (
    resolution.kind === "waitingForHost" ||
    resolution.kind === "fetchingAgent" ||
    resolution.kind === "lookupError"
  ) {
    // Agent URLs intentionally omit workspaceId. Keep this route mounted while the target host
    // reconnects, then resolve the workspace from the authoritative agent record.
    return (
      <AgentRouteResolutionView
        resolution={resolution}
        hostName={hostName}
        lastHostError={runtimeSnapshot?.lastError ?? null}
        onRetry={handleRetry}
        onManageHost={handleManageHost}
        onBack={handleBack}
      />
    );
  }

  return null;
}

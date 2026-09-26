import { useEffect, useRef } from "react";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { useToast } from "@/contexts/toast-context";
import { buildWorkspaceLinkRoute, readLinkParam } from "@/intents/automation-link";
import { describeLinkHostFailure } from "@/intents/link-host-message";
import { useLinkHost } from "@/intents/use-link-host";
import { StartupSplashScreen } from "@/screens/startup-splash-screen";

/**
 * `paseo://workspace?workspaceId=…&serverId=…&agentId=…|terminalId=…`: the
 * query form of the workspace deep link. Resolves the host, then hands off to
 * the canonical `/h/[serverId]/workspace/[workspaceId]`.
 */
export default function WorkspaceLinkRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <WorkspaceLinkRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function WorkspaceLinkRouteContent() {
  const router = useRouter();
  const toast = useToast();
  const { t } = useTranslation();
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    workspaceId?: string | string[];
    agentId?: string | string[];
    terminalId?: string | string[];
  }>();
  const workspaceId = readLinkParam(params.workspaceId);
  const agentId = readLinkParam(params.agentId);
  const terminalId = readLinkParam(params.terminalId);
  const host = useLinkHost(readLinkParam(params.serverId));
  const handledRef = useRef(false);

  useEffect(() => {
    if (!host || handledRef.current) {
      return;
    }
    handledRef.current = true;
    if (!workspaceId) {
      toast.error(t("intents.links.missingWorkspace"));
      router.replace("/" as Href);
      return;
    }
    if (host.kind !== "resolved") {
      toast.error(describeLinkHostFailure(t, host));
      router.replace("/" as Href);
      return;
    }
    router.replace(
      buildWorkspaceLinkRoute({
        serverId: host.serverId,
        workspaceId,
        agentId,
        terminalId,
      }) as Href,
    );
  }, [agentId, host, router, t, terminalId, toast, workspaceId]);

  return <StartupSplashScreen />;
}

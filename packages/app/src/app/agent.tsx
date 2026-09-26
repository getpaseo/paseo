import { useEffect, useRef } from "react";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { useToast } from "@/contexts/toast-context";
import {
  buildAgentLinkRoute,
  readLinkFlag,
  readLinkParam,
  readLinkPrompt,
} from "@/intents/automation-link";
import { describeLinkHostFailure } from "@/intents/link-host-message";
import { useLinkHost } from "@/intents/use-link-host";
import { StartupSplashScreen } from "@/screens/startup-splash-screen";

/**
 * `paseo://agent?agentId=…&serverId=…&prompt=…&send=…`: the query form of the
 * agent deep link, for callers that can only fill fixed query slots. Resolves
 * the host, then hands off to the canonical `/h/[serverId]/agent/[agentId]`.
 */
export default function AgentLinkRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <AgentLinkRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function AgentLinkRouteContent() {
  const router = useRouter();
  const toast = useToast();
  const { t } = useTranslation();
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    agentId?: string | string[];
    prompt?: string | string[];
    send?: string | string[];
  }>();
  const agentId = readLinkParam(params.agentId);
  const prompt = readLinkPrompt(params.prompt);
  const send = readLinkFlag(params.send);
  const host = useLinkHost(readLinkParam(params.serverId));
  const handledRef = useRef(false);

  useEffect(() => {
    if (!host || handledRef.current) {
      return;
    }
    handledRef.current = true;
    if (!agentId) {
      toast.error(t("intents.links.missingAgent"));
      router.replace("/" as Href);
      return;
    }
    if (host.kind !== "resolved") {
      toast.error(describeLinkHostFailure(t, host));
      router.replace("/" as Href);
      return;
    }
    router.replace(buildAgentLinkRoute({ serverId: host.serverId, agentId, prompt, send }) as Href);
  }, [agentId, host, prompt, router, send, t, toast]);

  return <StartupSplashScreen />;
}

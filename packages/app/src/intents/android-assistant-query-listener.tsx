import { useEffect } from "react";
import { androidIntents } from "@/native/android-intents";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { fetchAgentTimelineOnce } from "@/timeline/fetch-agent-timeline-once";
import { assistantNoticeRow } from "./assistant-messages";
import {
  parseAssistantQueryRequest,
  runAssistantQuery,
  type AssistantQueryFetch,
  type AssistantQueryHost,
  type AssistantQueryRequest,
} from "./assistant-query";

// The provider parks its binder thread for about 7 seconds, so leave room to
// answer even when a host is slow.
const FETCH_TIMEOUT_MS = 5_000;
const MAX_FETCH_ITEMS = 60;

function collectHosts(): AssistantQueryHost[] {
  const runtime = getHostRuntimeStore();
  const labels = new Map(runtime.getHosts().map((host) => [host.serverId, host.label]));
  return Object.values(useSessionStore.getState().sessions).map((session) => ({
    serverId: session.serverId,
    label: labels.get(session.serverId) ?? session.serverId,
    connected: isHostRuntimeConnected(runtime.getSnapshot(session.serverId)),
    workspaceIds: new Set(session.workspaces.keys()),
    agents: [...session.agents.values()],
  }));
}

const fetchEntries: AssistantQueryFetch = async (target, limit) => {
  const client = getHostRuntimeStore().getClient(target.serverId);
  if (!client) {
    throw new Error(`Host ${target.serverId} has no client`);
  }
  const page = await fetchAgentTimelineOnce(client, target.agentId, {
    direction: "tail",
    projection: "projected",
    limit: Math.min(limit * 3, MAX_FETCH_ITEMS),
    timeout: FETCH_TIMEOUT_MS,
  });
  return page.entries;
};

async function answer(request: AssistantQueryRequest): Promise<void> {
  let rows;
  try {
    rows = await runAssistantQuery({ request, hosts: collectHosts(), fetchEntries });
  } catch {
    rows = [
      assistantNoticeRow({
        text: "Paseo could not read that conversation; try again in a moment.",
        agentId: request.agentId,
        workspaceId: request.workspaceId,
      }),
    ];
  }
  androidIntents.resolveAssistantQuery(request.requestId, JSON.stringify({ rows }));
}

/**
 * Answers the assistant content provider's message queries. The catalog tables
 * are served from a file, but transcripts have to be live, so the provider
 * blocks on this listener and gets a notice row if the app is not there.
 */
export function AndroidAssistantQueryListener() {
  useEffect(() => {
    if (!androidIntents.isAvailable) {
      return;
    }
    const subscription = androidIntents.addAssistantQueryListener((raw) => {
      const request = parseAssistantQueryRequest(raw);
      if (request) {
        void answer(request);
      }
    });
    return () => subscription?.remove();
  }, []);

  return null;
}

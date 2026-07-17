import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

type TimelineClient = Pick<DaemonClient, "fetchAgentTimeline">;
type TimelineRequest = Parameters<TimelineClient["fetchAgentTimeline"]>[1];
type TimelinePage = Awaited<ReturnType<TimelineClient["fetchAgentTimeline"]>>;

const inFlightByClient = new WeakMap<object, Map<string, Promise<TimelinePage>>>();

export function fetchAgentTimelineOnce(
  client: TimelineClient,
  agentId: string,
  request: TimelineRequest,
): Promise<TimelinePage> {
  let inFlight = inFlightByClient.get(client);
  if (!inFlight) {
    inFlight = new Map();
    inFlightByClient.set(client, inFlight);
  }

  const key = `${agentId}:${JSON.stringify(request)}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const fetch = client.fetchAgentTimeline(agentId, request);
  inFlight.set(key, fetch);
  const clear = () => {
    if (inFlight.get(key) === fetch) inFlight.delete(key);
  };
  void fetch.then(clear, clear);
  return fetch;
}

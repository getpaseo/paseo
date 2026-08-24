import { expect, test } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { fetchAgentTimelineOnce } from "./fetch-agent-timeline-once";

type TimelinePage = Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>>;

test("concurrent identical timeline reads share one request", async () => {
  let resolvePage: (page: TimelinePage) => void = () => {};
  const page = new Promise<TimelinePage>((resolve) => {
    resolvePage = resolve;
  });
  const requests: Array<{ agentId: string; direction: string }> = [];
  const client = {
    fetchAgentTimeline: async (
      agentId: string,
      request: Parameters<DaemonClient["fetchAgentTimeline"]>[1],
    ) => {
      requests.push({ agentId, direction: request?.direction ?? "tail" });
      return page;
    },
  };
  const request = { direction: "tail" as const, limit: 100, projection: "projected" as const };

  const first = fetchAgentTimelineOnce(client, "agent", request);
  const second = fetchAgentTimelineOnce(client, "agent", request);
  resolvePage({ hasNewer: false } as TimelinePage);

  await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  expect(requests).toEqual([{ agentId: "agent", direction: "tail" }]);
});

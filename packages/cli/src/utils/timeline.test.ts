import { expect, test } from "vitest";

import { fetchProjectedTimelineItems, type TimelineFetchClient } from "./timeline.js";

function timelineItem(text: string) {
  return { type: "assistant_message" as const, text };
}

test("requests an unfiltered tail with the requested bounded limit", async () => {
  const requests: unknown[] = [];
  const client: TimelineFetchClient = {
    async fetchAgentTimeline(_agentId, options) {
      requests.push(options);
      return {
        entries: [{ item: timelineItem("newest") }],
        startCursor: { epoch: "epoch-1", seq: 10 },
        hasOlder: true,
      };
    },
  };

  const items = await fetchProjectedTimelineItems({
    client,
    agentId: "agent-1",
    tailCount: 1,
  });

  expect(items).toEqual([timelineItem("newest")]);
  expect(requests).toEqual([
    {
      direction: "tail",
      limit: 1,
      projection: "projected",
      timeout: undefined,
    },
  ]);
});

test("reads the complete filtered history when no tail is requested", async () => {
  const requests: unknown[] = [];
  const client: TimelineFetchClient = {
    async fetchAgentTimeline(_agentId, options) {
      requests.push(options);
      if (options.direction === "tail") {
        return {
          entries: [timelineItem("skip"), timelineItem("match")].map((item) => ({ item })),
          startCursor: { epoch: "epoch-1", seq: 9 },
          hasOlder: false,
        };
      }
      return {
        entries: [{ item: timelineItem("match") }],
        startCursor: { epoch: "epoch-1", seq: 9 },
        hasOlder: false,
      };
    },
  };

  const items = await fetchProjectedTimelineItems({
    client,
    agentId: "agent-1",
    matches: (item) => item.type === "assistant_message" && item.text === "match",
  });

  expect(items).toEqual([timelineItem("match")]);
  expect(requests).toEqual([
    {
      direction: "tail",
      limit: 0,
      projection: "projected",
      timeout: undefined,
    },
  ]);
});

test("walks older pages only while a filtered tail remains short", async () => {
  const requests: unknown[] = [];
  const client: TimelineFetchClient = {
    async fetchAgentTimeline(_agentId, options) {
      requests.push(options);
      if (options.direction === "tail") {
        return {
          entries: [{ item: timelineItem("skip") }],
          startCursor: { epoch: "epoch-1", seq: 10 },
          hasOlder: true,
        };
      }
      return {
        entries: [{ item: timelineItem("match") }],
        startCursor: { epoch: "epoch-1", seq: 9 },
        hasOlder: false,
      };
    },
  };

  const items = await fetchProjectedTimelineItems({
    client,
    agentId: "agent-1",
    tailCount: 1,
    matches: (item) => item.type === "assistant_message" && item.text === "match",
  });

  expect(items).toEqual([timelineItem("match")]);
  expect(requests).toEqual([
    {
      direction: "tail",
      limit: 1,
      projection: "projected",
      timeout: undefined,
    },
    {
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 10 },
      limit: 1,
      projection: "projected",
      timeout: undefined,
    },
  ]);
});

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

test("walks past four pages to complete a filtered tail", async () => {
  const requests: unknown[] = [];
  const olderPages = [
    { text: "skip-1", seq: 9, hasOlder: true },
    { text: "match-new", seq: 8, hasOlder: true },
    { text: "skip-2", seq: 7, hasOlder: true },
    { text: "match-old", seq: 6, hasOlder: false },
  ];
  const client: TimelineFetchClient = {
    async fetchAgentTimeline(_agentId, options) {
      requests.push(options);
      if (options.direction === "tail") {
        return {
          entries: [{ item: timelineItem("skip-0") }],
          startCursor: { epoch: "epoch-1", seq: 10 },
          hasOlder: true,
        };
      }
      const page = olderPages.shift();
      if (!page) {
        throw new Error("unexpected page request");
      }
      return {
        entries: [{ item: timelineItem(page.text) }],
        startCursor: { epoch: "epoch-1", seq: page.seq },
        hasOlder: page.hasOlder,
      };
    },
  };

  const items = await fetchProjectedTimelineItems({
    client,
    agentId: "agent-1",
    tailCount: 2,
    matches: (item) => item.type === "assistant_message" && item.text.startsWith("match"),
  });

  expect(items).toEqual([timelineItem("match-old"), timelineItem("match-new")]);
  expect(requests).toEqual([
    {
      direction: "tail",
      limit: 2,
      projection: "projected",
      timeout: undefined,
    },
    {
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 10 },
      limit: 2,
      projection: "projected",
      timeout: undefined,
    },
    {
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 9 },
      limit: 2,
      projection: "projected",
      timeout: undefined,
    },
    {
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 8 },
      limit: 2,
      projection: "projected",
      timeout: undefined,
    },
    {
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 7 },
      limit: 2,
      projection: "projected",
      timeout: undefined,
    },
  ]);
});

test("returns a short filtered tail only after reaching history start", async () => {
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
    tailCount: 2,
    matches: (item) => item.type === "assistant_message" && item.text === "match",
  });

  expect(items).toEqual([timelineItem("match")]);
  expect(requests).toHaveLength(2);
});

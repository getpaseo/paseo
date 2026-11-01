import { expect, test, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { fetchProjectedTimelineItems } from "./timeline.js";

test("collects bounded history pages in chronological order", async () => {
  const fetchAgentTimeline = vi
    .fn()
    .mockResolvedValueOnce({
      epoch: "epoch",
      hasOlder: true,
      startCursor: { epoch: "epoch", seq: 41 },
      entries: [{ timestamp: "2026-11-01", item: { type: "assistant_message", text: "last" } }],
    })
    .mockResolvedValueOnce({
      epoch: "epoch",
      hasOlder: false,
      reset: false,
      startCursor: { epoch: "epoch", seq: 1 },
      entries: [{ timestamp: "2026-11-01", item: { type: "user_message", text: "first" } }],
    });
  const client = { fetchAgentTimeline } as unknown as DaemonClient;
  expect(await fetchProjectedTimelineItems({ client, agentId: "agent" })).toEqual([
    { type: "user_message", text: "first" },
    { type: "assistant_message", text: "last" },
  ]);
  expect(fetchAgentTimeline).toHaveBeenLastCalledWith(
    "agent",
    expect.objectContaining({
      direction: "before",
      limit: 40,
      cursor: { epoch: "epoch", seq: 41 },
    }),
  );
});

test("rejects a non-advancing history cursor", async () => {
  const page = {
    epoch: "epoch",
    hasOlder: true,
    startCursor: { epoch: "epoch", seq: 41 },
    entries: [],
  };
  const client = { fetchAgentTimeline: vi.fn().mockResolvedValue(page) } as unknown as DaemonClient;
  await expect(fetchProjectedTimelineItems({ client, agentId: "agent" })).rejects.toThrow(
    "did not advance",
  );
});

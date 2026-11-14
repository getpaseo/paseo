import { expect, it } from "vitest";
import type { CachedTimeline } from "@/runtime/replica-cache";
import { useSessionStore } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import { createTimelineReplica } from "./viewed-timeline-sync";
import { processAgentStreamEvent, processTimelineResponse } from "./session-stream-reducers";

const SERVER_ID = "diag-host";
const AGENT_ID = "agent-1";
const epoch = "epoch-1";

it("#7917: a reply streaming during cache preparation is truncated after catch-up and turn end", async () => {
  useSessionStore.getState().initializeSession(SERVER_ID, null);
  let release!: (value: CachedTimeline) => void;
  const read = new Promise<CachedTimeline>((resolve) => (release = resolve));
  const replica = createTimelineReplica({
    serverId: SERVER_ID,
    storage: { readTimeline: () => read, commitTimeline: () => undefined },
    prepareAgent: async () => undefined,
  });
  // App reloads mid-turn: the cache read is in flight when a live delta of the reply arrives.
  const preparation = replica.prepare(AGENT_ID);
  const liveSuffix: StreamItem = {
    kind: "assistant_message",
    id: "reply",
    messageId: "reply",
    text: "middle",
    timestamp: new Date(70),
    timelineCursor: { epoch, seq: 70 },
  };
  useSessionStore.getState().setAgentStreamState(SERVER_ID, AGENT_ID, { head: [liveSuffix] });
  release({
    agentId: AGENT_ID,
    items: [
      {
        kind: "user_message",
        id: "u1",
        text: "ask",
        timestamp: new Date(1),
        timelineCursor: { epoch, seq: 1 },
      } as StreamItem,
    ],
    range: { epoch, startSeq: 1, endSeq: 4 },
    hasOlder: false,
  });
  await preparation;

  const session = useSessionStore.getState().sessions[SERVER_ID]!;
  const cursor = session.agentTimelineCursor.get(AGENT_ID);
  expect(replica.readCursor(AGENT_ID)).toEqual({ epoch, endSeq: 4 });
  expect(session.agentStreamHead.get(AGENT_ID)).toEqual([liveSuffix]);

  // Catch-up after seq 4 returns the turn's reasoning and the whole reply.
  const caughtUp = processTimelineResponse({
    currentTail: session.agentStreamTail.get(AGENT_ID) ?? [],
    currentHead: session.agentStreamHead.get(AGENT_ID) ?? [],
    currentCursor: cursor,
    isInitializing: false,
    hasActiveInitDeferred: false,
    initRequestDirection: "after",
    sendingClientMessageIds: [],
    payload: {
      agentId: AGENT_ID,
      direction: "after",
      projection: "projected",
      reset: false,
      epoch,
      window: { minSeq: 1, maxSeq: 70, nextSeq: 71 },
      startCursor: { seq: 5 },
      endCursor: { seq: 70 },
      hasOlder: false,
      hasNewer: false,
      error: null,
      entries: [
        {
          seqStart: 5,
          seqEnd: 6,
          provider: "claude",
          item: { type: "reasoning", text: "thinking" },
          timestamp: new Date(1005).toISOString(),
        },
        {
          seqStart: 7,
          seqEnd: 70,
          provider: "claude",
          item: {
            type: "assistant_message",
            text: "beginning middle",
            messageId: "reply",
          },
          timestamp: new Date(1007).toISOString(),
        },
      ],
    },
  });
  const complete = processAgentStreamEvent({
    event: { type: "turn_completed", provider: "claude" },
    seq: undefined,
    epoch: undefined,
    currentTail: caughtUp.tail,
    currentHead: caughtUp.head,
    currentCursor: caughtUp.cursor ?? undefined,
    timestamp: new Date(71),
  });
  const replies = [...complete.tail, ...complete.head].filter(
    (item) => item.kind === "assistant_message",
  );
  expect(replies.map((item) => item.kind === "assistant_message" && item.text)).toEqual([
    "beginning middle",
  ]);
});

import { expect, test } from "vitest";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import { DaemonClient, type DaemonTransport } from "./daemon-client";

function connection(
  options: {
    acknowledgeSubscriptions?: boolean;
    ownedSubscriptions?: boolean;
    acknowledgeTimelineReads?: boolean;
  } = {},
) {
  const sent: Array<{
    type: string;
    capabilities?: Record<string, unknown>;
    message?: {
      type: string;
      requestId?: string;
      agentIds?: string[];
      events?: string[];
      subscriptionId?: string;
    };
  }> = [];
  let receive = (_data: unknown) => {};
  let open = () => {};
  let closed = (_event?: unknown) => {};
  const transport: DaemonTransport = {
    send(data) {
      const frame = JSON.parse(String(data));
      sent.push(frame);
      if (frame.type === "hello") {
        receive(
          JSON.stringify({
            type: "session",
            message: {
              type: "status",
              payload: {
                status: "server_info",
                serverId: "test",
                hostname: null,
                version: null,
                features: {
                  ...(options.ownedSubscriptions === false ? {} : { ownedSubscriptions: true }),
                  selectiveAgentTimeline: true,
                  explicitEventSubscriptions: true,
                },
              },
            },
          }),
        );
      } else if (
        options.acknowledgeSubscriptions !== false &&
        frame.type === "session" &&
        frame.message.type.endsWith("set_subscription.request")
      ) {
        receive(
          JSON.stringify({
            type: "session",
            message: {
              type: frame.message.type.replace(".request", ".response"),
              payload: {
                requestId: frame.message.requestId,
                agentIds: frame.message.agentIds,
                subscriptionId: `server-${sent.length}`,
              },
            },
          }),
        );
      }
      if (
        frame.message?.type === "fetch_agent_timeline_request" &&
        options.acknowledgeTimelineReads !== false
      ) {
        receive(
          JSON.stringify({
            type: "session",
            message: timelinePage(frame.message.requestId, "epoch", 0),
          }),
        );
      }
      if (frame.message?.type === "subscription.release.request") {
        receive(
          JSON.stringify({
            type: "session",
            message: {
              type: "subscription.release.response",
              payload: {
                requestId: frame.message.requestId,
                subscriptionId: frame.message.subscriptionId,
              },
            },
          }),
        );
      }
    },
    close() {},
    onMessage(handler) {
      receive = (data) => handler(data, typeof data !== "string");
      return () => {};
    },
    onOpen(handler) {
      open = handler;
      return () => {};
    },
    onClose(handler) {
      closed = handler;
      return () => {};
    },
    onError() {
      return () => {};
    },
  };
  const client = new DaemonClient({
    url: "ws://test",
    clientId: "test",
    transportFactory: () => transport,
    reconnect: { enabled: false },
  });
  return {
    client,
    sent,
    open: () => open(),
    disconnect: () => closed(),
    receive: (message: unknown) => receive(JSON.stringify({ type: "session", message })),
  };
}

test("a plain client advertises every protocol capability and no browser host", async () => {
  const h = connection();
  try {
    const ready = h.client.connect();
    h.open();
    await ready;
    const { browserHost: _browser, ...protocolCapabilities } = CLIENT_CAPS;
    // Every new capability needs a deliberate default or a host-owned exception.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].capabilities).toEqual(
      Object.fromEntries(Object.values(protocolCapabilities).map((key) => [key, true])),
    );
  } finally {
    await h.client.close();
  }
});

test("SDK timelines have independent lifetimes and fresh IDs on reconnect", async () => {
  const { createPaseoApi } = await import("./index");
  const h = connection();
  const api = createPaseoApi(h.client);
  try {
    const connecting = h.client.connect();
    h.open();
    await connecting;
    const a = api.agents.ref("a").timeline.subscribe(() => {});
    const same = api.agents.ref("a").timeline.subscribe(() => {});
    const b = api.agents.ref("b").timeline.subscribe(() => {});
    await Promise.all([a.ready, same.ready, b.ready]);
    expect(new Set([a.subscriptionId, same.subscriptionId, b.subscriptionId]).size).toBe(3);
    const memberships = () =>
      h.sent
        .filter((frame) => frame.message?.type === "agent.timeline.set_subscription.request")
        .map((frame) => frame.message?.agentIds);
    expect(memberships()).toEqual([["a"], ["a"], ["b"]]);
    await a.release();
    await same.release();
    const previousId = b.subscriptionId;
    h.disconnect();
    const reconnecting = h.client.connect();
    h.open();
    await reconnecting;
    await expect.poll(() => b.subscriptionId).not.toBe(previousId);
    expect(memberships()).toEqual([["a"], ["a"], ["b"], ["b"]]);
    await b.release();
  } finally {
    await api.dispose();
    await h.client.close();
  }
});

test("SDK subscribers receive timeline replacement instead of silently losing history", async () => {
  const { createPaseoApi } = await import("./index");
  const h = connection();
  const received: unknown[] = [];
  try {
    const ready = h.client.connect();
    h.open();
    await ready;
    const off = createPaseoApi(h.client)
      .agents.ref("agent")
      .timeline.subscribe((event) => received.push(event));
    await off.ready;
    h.receive({
      type: "agent.timeline.replacement",
      payload: { agentId: "agent", epoch: "next", subscriptionId: off.subscriptionId },
    });
    expect(received).toEqual([{ agentId: "agent", event: { type: "replacement", epoch: "next" } }]);
    off();
  } finally {
    await h.client.close();
  }
});

test("local listeners create no demand before or after reconnect", async () => {
  const h = connection();
  try {
    const connecting = h.client.connect();
    h.open();
    await connecting;
    const off = h.client.on("project.update", () => {});
    h.disconnect();
    const reconnecting = h.client.connect();
    h.open();
    await reconnecting;
    expect(h.sent.filter((frame) => frame.type === "session")).toEqual([]);
    off();
  } finally {
    await h.client.close();
  }
});

test("provider reference hydration preserves independent owners and drops released work", async () => {
  const h = connection();
  const updates: string[] = [];
  try {
    const connecting = h.client.connect();
    h.open();
    await connecting;
    const a = h.client.observeEvents(["providers_snapshot_update"]);
    const b = h.client.observeEvents(["providers_snapshot_update"]);
    await Promise.all([a.ready, b.ready]);
    for (const owner of [a, b])
      owner.subscribe({
        snapshot: () => {},
        update: (message) => {
          if (message.type === "providers_snapshot_update")
            updates.push(message.payload.subscriptionId!);
        },
      });
    const payload = {
      entries: [],
      snapshotHash: "catalog",
      generatedAt: "2026-09-08T00:00:00.000Z",
    };
    for (const owner of [a, b])
      h.receive({
        type: "providers_snapshot_update",
        payload: { ...payload, subscriptionId: owner.subscriptionId },
      });
    const requests = h.sent.filter(
      (frame) => frame.message?.type === "get_providers_snapshot_request",
    );
    expect(requests).toHaveLength(2);
    await a.release();
    for (const request of requests)
      h.receive({
        type: "get_providers_snapshot_response",
        payload: {
          ...payload,
          requestId: request.message!.requestId,
          compactSnapshot: { entries: [], thinkingSets: [] },
        },
      });
    await expect.poll(() => updates).toEqual([b.subscriptionId]);
    await b.release();
  } finally {
    await h.client.close();
  }
});

test("timeline readiness and updates belong to the acknowledged handle", async () => {
  const h = connection({ acknowledgeSubscriptions: false });
  try {
    const connecting = h.client.connect();
    h.open();
    await connecting;
    const a = h.client.subscribeAgentTimeline("agent", () => {});
    const b = h.client.subscribeAgentTimeline("agent", () => {});
    const requests = h.sent.filter(
      (frame) => frame.message?.type === "agent.timeline.set_subscription.request",
    );
    let bReady = false;
    void b.ready.then(() => {
      bReady = true;
      return undefined;
    });
    h.receive({
      type: "agent.timeline.set_subscription.response",
      payload: {
        requestId: requests[0].message!.requestId,
        agentIds: ["agent"],
        subscriptionId: "a",
      },
    });
    await a.ready;
    expect(bReady).toBe(false);
    h.receive({
      type: "agent.timeline.set_subscription.response",
      payload: {
        requestId: requests[1].message!.requestId,
        agentIds: ["agent"],
        subscriptionId: "b",
      },
    });
    await b.ready;
    await a.release();
    await b.release();
  } finally {
    await h.client.close();
  }
});

test("timeline readiness remains pending before connect and rejects when released", async () => {
  const h = connection();
  try {
    const release = h.client.subscribeAgentTimeline("agent", () => {});
    const canceled = h.client.subscribeAgentTimeline("canceled", () => {});
    canceled();
    await expect(canceled.ready).rejects.toThrow("released");
    let established = false;
    void release.ready.then(() => {
      return (established = true);
    });
    await Promise.resolve();
    expect(established).toBe(false);
    expect(h.sent).toEqual([]);
    const connect = h.client.connect();
    h.open();
    await connect;
    await release.ready;
    expect(established).toBe(true);
    release();
  } finally {
    await h.client.close();
  }
});

test("passive provider listeners never hydrate unowned references", async () => {
  const h = connection();
  try {
    const connecting = h.client.connect();
    h.open();
    await connecting;
    const off = h.client.on("providers_snapshot_update", () => {});
    h.receive({
      type: "providers_snapshot_update",
      payload: { entries: [], snapshotHash: "updated", generatedAt: "2026-09-08T00:00:00.000Z" },
    });
    h.disconnect();
    off();
    const reconnecting = h.client.connect();
    h.open();
    await reconnecting;
    expect(h.sent.filter((frame) => frame.type === "session")).toEqual([]);
  } finally {
    await h.client.close();
  }
});

test("failed terminal bootstrap reports the domain error without reconnecting or retaining a route", async () => {
  const h = connection();
  try {
    const connecting = h.client.connect();
    h.open();
    await connecting;
    const terminal = h.client.observeTerminal("missing-terminal", () => {});
    const request = h.sent.at(-1)!.message!;
    h.receive({
      type: "subscribe_terminal_response",
      payload: {
        requestId: request.requestId,
        terminalId: "missing-terminal",
        error: "Terminal not found",
      },
    });
    await expect(terminal.ready).rejects.toThrow("Terminal not found");
    await terminal.release();
    expect(terminal.subscriptionId).toBeNull();
    expect(h.client.isConnected).toBe(true);
    expect(
      h.sent.filter((frame) => frame.message?.type === "subscription.release.request"),
    ).toEqual([]);
  } finally {
    await h.client.close();
  }
});

test("an old host produces an update-host error without sending a legacy subscription", async () => {
  const h = connection({ ownedSubscriptions: false });
  try {
    const connecting = h.client.connect();
    h.open();
    await connecting;
    const observation = h.client.observeAgents({ filter: { labels: { role: "orchestrator" } } });
    await expect(observation.ready).rejects.toThrow(
      "Update the host to use independent subscriptions.",
    );
    await observation.release();
    expect(h.sent.filter((frame) => frame.type === "session")).toEqual([]);
    expect(h.client.isConnected).toBe(true);
  } finally {
    await h.client.close();
  }
});

test("invalid observation input rejects without reconnecting the transport", async () => {
  const h = connection();
  try {
    const connecting = h.client.connect();
    h.open();
    await connecting;
    const invalid = h.client.observeAgents({ page: { limit: -1 } });
    await expect(invalid.ready).rejects.toThrow();
    await invalid.release();
    expect(h.client.isConnected).toBe(true);
    expect(h.sent.filter((frame) => frame.message?.type === "fetch_agents_request")).toHaveLength(
      0,
    );
  } finally {
    await h.client.close();
  }
});

test("a timed-out subscription rejects and cannot replay on reconnect", async () => {
  const h = connection();
  try {
    const connecting = h.client.connect();
    h.open();
    await connecting;
    const observation = h.client.observeAgents({ timeout: 10 });
    await expect(observation.ready).rejects.toThrow(/timed out|timeout/i);
    await observation.release();
    const reconnecting = h.client.connect();
    h.open();
    await reconnecting;
    expect(h.sent.filter((frame) => frame.message?.type === "fetch_agents_request")).toHaveLength(
      1,
    );
  } finally {
    await h.client.close();
  }
});

function timelinePage(requestId: string | undefined, epoch: string, seq: number) {
  return {
    type: "fetch_agent_timeline_response",
    payload: {
      requestId,
      agentId: "agent",
      agent: null,
      direction: "before",
      projection: "projected",
      epoch,
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: seq, nextSeq: seq + 1 },
      startCursor: { epoch, seq },
      endCursor: { epoch, seq },
      hasOlder: seq > 1,
      hasNewer: false,
      error: null,
      entries: seq
        ? [
            {
              provider: "codex",
              item: { type: "user_message", text: `persisted-${epoch}-${seq}` },
              timestamp: new Date(0).toISOString(),
              seqStart: seq,
              seqEnd: seq,
              sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
              collapsed: [],
            },
          ]
        : [],
    },
  };
}

test("timeline recovery snapshots precede live updates for independent owners and survive epoch changes", async () => {
  const { createPaseoApi } = await import("./index");
  const h = connection({ acknowledgeTimelineReads: false });
  const api = createPaseoApi(h.client);
  const received: import("./index").PaseoAgentTimelineEvent[][] = [[], [], []];
  try {
    const connected = h.client.connect();
    h.open();
    await connected;
    const owners = received.map((events) =>
      api.agents.ref("agent").timeline.subscribe((event) => events.push(event)),
    );
    await Promise.all(owners.map((owner) => owner.ready));
    const reads = () =>
      h.sent.filter((frame) => frame.message?.type === "fetch_agent_timeline_request");
    expect(reads()).toHaveLength(0); // Initial subscription remains live-only.
    const oldIds = new Set(owners.map((owner) => owner.subscriptionId));
    h.disconnect();
    const reconnected = h.client.connect();
    h.open();
    await reconnected;
    await expect.poll(() => reads().length).toBe(3);
    expect(new Set(owners.map((owner) => owner.subscriptionId)).size).toBe(3);
    expect(owners.every((owner) => !oldIds.has(owner.subscriptionId))).toBe(true);
    await owners[2].release(); // The history reply can arrive after the owner is gone.
    const live = (index: number, seq: number, epoch: string) =>
      h.receive({
        type: "agent_stream",
        payload: {
          agentId: "agent",
          subscriptionId: owners[index].subscriptionId,
          seq,
          epoch,
          timestamp: new Date(0).toISOString(),
          event: {
            type: "timeline",
            provider: "codex",
            item: { type: "user_message", text: `live-${seq}` },
          },
        },
      });
    live(0, 4, "old");
    live(0, 5, "old");
    h.receive(timelinePage(reads()[1].message?.requestId, "new", 4));
    h.receive(timelinePage(reads()[2].message?.requestId, "new", 4));
    await expect.poll(() => received[1].length).toBe(1);
    expect(received[0]).toEqual([]);
    live(1, 5, "new");
    h.receive(timelinePage(reads()[0].message?.requestId, "old", 4));
    await expect.poll(() => received[0].length).toBe(2);
    for (const [index, epoch] of [
      [0, "old"],
      [1, "new"],
    ] as const) {
      expect(received[index][0]).toMatchObject({
        event: {
          type: "snapshot",
          reason: "reconnect",
          page: {
            epoch,
            hasOlder: true,
            startCursor: { epoch, seq: 4 },
            entries: [{ item: { text: `persisted-${epoch}-4` } }],
          },
        },
      });
      expect(received[index][1]).toMatchObject({ seq: 5 });
    }
    expect(received[2]).toEqual([]);
    await owners[0].release();
    live(1, 6, "new");
    expect(received[1]).toHaveLength(3);
  } finally {
    await api.dispose();
    await h.client.close();
  }
});

test("timeline recovery replaces an obsolete read after bounded overflow and epoch invalidation", async () => {
  const h = connection({ acknowledgeTimelineReads: false });
  const messages: unknown[] = [];
  try {
    const connected = h.client.connect();
    h.open();
    await connected;
    const owner = h.client.subscribeAgentTimeline("agent", (message) => messages.push(message));
    await owner.ready;
    h.disconnect();
    const reconnected = h.client.connect();
    h.open();
    await reconnected;
    const reads = () =>
      h.sent.filter((frame) => frame.message?.type === "fetch_agent_timeline_request");
    await expect.poll(() => reads().length).toBe(1);
    for (let seq = 1; seq <= 130; seq++)
      h.receive({
        type: "agent_stream",
        payload: {
          agentId: "agent",
          subscriptionId: owner.subscriptionId,
          seq,
          epoch: "old",
          timestamp: new Date(0).toISOString(),
          event: {
            type: "timeline",
            provider: "codex",
            item: { type: "assistant_message", text: "piece" },
          },
        },
      });
    h.receive(timelinePage(reads()[0].message?.requestId, "old", 1));
    await expect.poll(() => reads().length).toBe(2);
    expect(messages).toEqual([]);
    h.receive({
      type: "agent.timeline.replacement",
      payload: { agentId: "agent", subscriptionId: owner.subscriptionId, epoch: "new" },
    });
    h.receive(timelinePage(reads()[1].message?.requestId, "old", 130));
    await expect.poll(() => reads().length).toBe(3);
    expect(messages).toEqual([]);
    h.receive(timelinePage(reads()[2].message?.requestId, "new", 2));
    await expect.poll(() => messages.length).toBe(2);
    expect(messages).toMatchObject([
      { type: "agent.timeline.replacement", payload: { epoch: "new" } },
      { type: "agent.timeline.snapshot", payload: { page: { epoch: "new" } } },
    ]);
    await owner.release();
  } finally {
    await h.client.close();
  }
});

test("timeline recovery failure is observable and releases its owner", async () => {
  const h = connection({ acknowledgeTimelineReads: false });
  const messages: unknown[] = [];
  try {
    const connected = h.client.connect();
    h.open();
    await connected;
    const owner = h.client.subscribeAgentTimeline("agent", (message) => messages.push(message));
    await owner.ready;
    h.disconnect();
    const reconnected = h.client.connect();
    h.open();
    await reconnected;
    const reads = () =>
      h.sent.filter((frame) => frame.message?.type === "fetch_agent_timeline_request");
    await expect.poll(() => reads().length).toBe(1);
    const page = timelinePage(reads()[0].message?.requestId, "epoch", 0);
    h.receive({ ...page, payload: { ...page.payload, error: "Agent no longer available" } });
    await expect.poll(() => owner.subscriptionId).toBe(null);
    expect(messages).toEqual([
      {
        type: "agent.timeline.error",
        payload: { agentId: "agent", error: "Agent no longer available" },
      },
    ]);
  } finally {
    await h.client.close();
  }
});

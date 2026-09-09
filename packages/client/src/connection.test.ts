import { expect, test } from "vitest";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import { DaemonClient, type DaemonTransport } from "./daemon-client";

function connection(options: { acknowledgeSubscriptions?: boolean } = {}) {
  const sent: Array<{
    type: string;
    capabilities?: Record<string, unknown>;
    message?: { type: string; requestId?: string; agentIds?: string[]; events?: string[] };
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
                features: { selectiveAgentTimeline: true, explicitEventSubscriptions: true },
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
              payload: { requestId: frame.message.requestId, agentIds: frame.message.agentIds },
            },
          }),
        );
      }
    },
    close() {},
    onMessage(handler) {
      receive = handler;
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

test("SDK timeline listeners own their union across unsubscribe and reconnect", async () => {
  const { createPaseoApi } = await import("./index");
  const h = connection();
  const api = createPaseoApi(h.client);
  try {
    const ready = h.client.connect();
    h.open();
    await ready;
    const first = api.agents.ref("a").timeline.subscribe(() => {});
    const same = api.agents.ref("a").timeline.subscribe(() => {});
    const second = api.agents.ref("b").timeline.subscribe(() => {});
    await Promise.resolve();
    const memberships = () =>
      h.sent
        .filter((f) => f.message?.type === "agent.timeline.set_subscription.request")
        .map((f) => f.message?.agentIds);
    expect(memberships()).toEqual([["a"], ["a"], ["a", "b"]]);
    first();
    expect(memberships()).toEqual([["a"], ["a"], ["a", "b"]]);
    same();
    expect(memberships().at(-1)).toEqual(["b"]);
    h.disconnect();
    const reconnect = h.client.connect();
    h.open();
    await reconnect;
    expect(memberships().at(-1)).toEqual(["b"]);
    second();
    expect(memberships().at(-1)).toEqual([]);
  } finally {
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
    h.receive({ type: "agent.timeline.replacement", payload: { agentId: "agent", epoch: "next" } });
    expect(received).toEqual([{ agentId: "agent", event: { type: "replacement", epoch: "next" } }]);
    off();
  } finally {
    await h.client.close();
  }
});

test("event listeners release demand and restore only remaining interests", async () => {
  const h = connection();
  try {
    const ready = h.client.connect();
    h.open();
    await ready;
    const projects = h.client.on("project.update", () => {});
    const providers = h.client.on("providers_snapshot_update", () => {});
    const subscriptions = () =>
      h.sent
        .filter((f) => f.message?.type === "session.events.set_subscription.request")
        .map((f) => f.message?.events);
    expect(subscriptions()).toEqual([
      ["project.update"],
      ["project.update", "providers_snapshot_update"],
    ]);
    projects();
    h.disconnect();
    const reconnect = h.client.connect();
    h.open();
    await reconnect;
    expect(subscriptions().at(-1)).toEqual(["providers_snapshot_update"]);
    providers();
    expect(subscriptions().at(-1)).toEqual([]);
  } finally {
    await h.client.close();
  }
});

test("provider references fetch a body only for interested SDK listeners", async () => {
  const h = connection();
  const received: unknown[] = [];
  const payload = {
    entries: [],
    snapshotHash: "catalog",
    fetchedAt: { test: "2026-09-08T00:00:00.000Z" },
    generatedAt: "2026-09-08T00:00:00.000Z",
  };
  try {
    const ready = h.client.connect();
    h.open();
    await ready;
    h.receive({ type: "providers_snapshot_update", payload });
    expect(h.sent).toHaveLength(1);
    const off = h.client.on("providers_snapshot_update", (m) => received.push(m.payload.entries));
    h.receive({ type: "providers_snapshot_update", payload });
    h.receive({ type: "providers_snapshot_update", payload });
    const requests = h.sent.filter((f) => f.message?.type === "get_providers_snapshot_request");
    expect(requests).toHaveLength(1);
    h.receive({
      type: "get_providers_snapshot_response",
      payload: {
        ...payload,
        requestId: requests[0].message?.requestId,
        compactSnapshot: {
          entries: [
            {
              provider: "test",
              enabled: true,
              status: "ready",
              models: [{ id: "one", label: "One" }],
            },
          ],
          thinkingSets: [],
        },
      },
    });
    await expect
      .poll(() => received)
      .toEqual([
        [
          {
            provider: "test",
            enabled: true,
            status: "ready",
            fetchedAt: "2026-09-08T00:00:00.000Z",
            models: [{ provider: "test", id: "one", label: "One" }],
          },
        ],
      ]);
    off();
    h.receive({ type: "providers_snapshot_update", payload: { ...payload, snapshotHash: "next" } });
    expect(h.sent.filter((f) => f.message?.type === "get_providers_snapshot_request")).toHaveLength(
      1,
    );
  } finally {
    await h.client.close();
  }
});

test("SDK listeners preserve the app's explicit timeline membership", async () => {
  const h = connection();
  try {
    const ready = h.client.connect();
    h.open();
    await ready;
    await h.client.setAgentTimelineSubscription(["visible"]);
    const off = h.client.subscribeAgentTimeline("plugin", () => {});
    await h.client.setAgentTimelineSubscription(["next"]);
    expect(h.sent.at(-1)?.message?.agentIds).toEqual(["next", "plugin"]);
    off();
    expect(h.sent.at(-1)?.message?.agentIds).toEqual(["next"]);
  } finally {
    await h.client.close();
  }
});

test("timeline readiness waits for daemon acknowledgement, including shared listeners", async () => {
  const h = connection({ acknowledgeSubscriptions: false });
  try {
    const connect = h.client.connect();
    h.open();
    await connect;
    const first = h.client.subscribeAgentTimeline("agent", () => {});
    const second = h.client.subscribeAgentTimeline("agent", () => {});
    expect(first.ready).toBeInstanceOf(Promise);
    let ready = false;
    void second.ready.then(() => {
      return (ready = true);
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    const request = h.sent.at(-1)!.message!;
    h.receive({
      type: "agent.timeline.set_subscription.response",
      payload: { requestId: request.requestId, agentIds: ["agent"] },
    });
    await Promise.all([first.ready, second.ready]);
    expect(ready).toBe(true);
    h.disconnect();
    const third = h.client.subscribeAgentTimeline("agent", () => {});
    let reconnected = false;
    void third.ready.then(() => {
      return (reconnected = true);
    });
    const reconnect = h.client.connect();
    h.open();
    await reconnect;
    expect(reconnected).toBe(false);
    h.receive({
      type: "agent.timeline.set_subscription.response",
      payload: { requestId: h.sent.at(-1)!.message!.requestId, agentIds: ["agent"] },
    });
    await third.ready;
    expect(reconnected).toBe(true);
    first();
    second();
    third();
  } finally {
    await h.client.close();
  }
});

test("an unresolved provider reference is fetched again after reconnect", async () => {
  const h = connection();
  const received: unknown[] = [];
  const payload = { entries: [], snapshotHash: "updated", generatedAt: "2026-09-08T00:00:00.000Z" };
  const requests = () => h.sent.filter((f) => f.message?.type === "get_providers_snapshot_request");
  try {
    const connect = h.client.connect();
    h.open();
    await connect;
    const off = h.client.on("providers_snapshot_update", (m) =>
      received.push(m.payload.snapshotHash),
    );
    h.receive({ type: "providers_snapshot_update", payload });
    expect(requests()).toHaveLength(1);
    h.disconnect();
    await Promise.resolve();
    await Promise.resolve();
    const reconnect = h.client.connect();
    h.open();
    await reconnect;
    expect(requests()).toHaveLength(2);
    h.receive({
      type: "get_providers_snapshot_response",
      payload: {
        ...payload,
        requestId: requests()[1].message?.requestId,
        compactSnapshot: { entries: [], thinkingSets: [] },
      },
    });
    await expect.poll(() => received).toEqual(["updated"]);
    off();
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

test("unsubscribing while disconnected discards unresolved provider demand", async () => {
  const h = connection();
  try {
    const connect = h.client.connect();
    h.open();
    await connect;
    const off = h.client.on("providers_snapshot_update", () => {});
    h.receive({
      type: "providers_snapshot_update",
      payload: {
        entries: [],
        snapshotHash: "updated",
        generatedAt: "2026-09-08T00:00:00.000Z",
      },
    });
    h.disconnect();
    off();
    const reconnect = h.client.connect();
    h.open();
    await reconnect;
    expect(h.sent.filter((f) => f.message?.type === "get_providers_snapshot_request")).toHaveLength(
      1,
    );
  } finally {
    await h.client.close();
  }
});

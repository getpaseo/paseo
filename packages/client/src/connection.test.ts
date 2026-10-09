import { expect, test } from "vitest";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import { DaemonClient, type DaemonTransport } from "./daemon-client";

function connection(
  options: {
    acknowledgeSubscriptions?: boolean;
    ownedSubscriptions?: boolean;
    ownedCapability?: boolean;
    workspaceMultiplicity?: boolean;
    broadcasts?: boolean;
    browserHost?: { hostKind: string; supportedCommands: string[] };
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
                  workspaceMultiplicity: options.workspaceMultiplicity ?? true,
                  selectiveAgentTimeline: !options.broadcasts,
                  explicitEventSubscriptions: !options.broadcasts,
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
    capabilities: {
      [CLIENT_CAPS.browserHost]: options.browserHost,
      ...(options.ownedCapability === undefined
        ? {}
        : { [CLIENT_CAPS.ownedSubscriptions]: options.ownedCapability }),
    },
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

test("older hosts share event demand on one connection and release only their own listeners", async () => {
  const h = connection({ ownedSubscriptions: false });
  try {
    const connecting = h.client.connect();
    h.open();
    await connecting;
    const first = h.client.observeEvents(["project.update"]);
    const second = h.client.observeEvents(["project.update"]);
    await Promise.all([first.ready, second.ready]);
    const received: string[] = [];
    first.subscribe({ snapshot: () => {}, update: () => received.push("first") });
    second.subscribe({ snapshot: () => {}, update: () => received.push("second") });
    h.receive({ type: "project.update", payload: { kind: "remove", projectId: "project" } });
    expect(received).toEqual(["first", "second"]);
    await first.release();
    h.receive({ type: "project.update", payload: { kind: "remove", projectId: "project" } });
    expect(received).toEqual(["first", "second", "second"]);
    expect(h.sent.at(-1)?.message?.events).toEqual(["project.update"]);
    await second.release();
    expect(h.sent.at(-1)?.message?.events).toEqual([]);
    expect(h.sent.filter((frame) => frame.type === "hello")).toHaveLength(1);
    expect(
      h.sent.filter((frame) => frame.message?.type === "subscription.release.request"),
    ).toEqual([]);
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

test.each([
  { name: "modern", ownedSubscriptions: true, broadcasts: false },
  { name: "legacy selective", ownedSubscriptions: false, broadcasts: false },
  { name: "legacy broadcast", ownedSubscriptions: false, broadcasts: true },
])("$name timelines restore live delivery without requesting history", async (mode) => {
  const { createPaseoApi } = await import("./index");
  const h = connection(mode);
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
    expect(received).toEqual([[], [], []]);
    for (let cycle = 0; cycle < 2; cycle++) {
      const oldIds = owners.map((owner) => owner.subscriptionId);
      h.disconnect();
      await owners[2].release();
      const reconnected = h.client.connect();
      h.open();
      await reconnected;
      await expect.poll(() => owners[0].subscriptionId).not.toBe(oldIds[0]);
      expect(
        h.sent.filter((frame) => frame.message?.type === "fetch_agent_timeline_request"),
      ).toEqual([]);
      for (const index of [0, 1]) {
        expect(owners[index].subscriptionId).not.toBeNull();
        expect(received[index].at(-1)).toEqual({
          agentId: "agent",
          subscriptionId: owners[index].subscriptionId,
          event: { type: "subscription_restored" },
        });
      }
      const live = {
        agentId: "agent",
        timestamp: new Date(0).toISOString(),
        event: { type: "turn_completed", provider: "codex" },
      };
      if (mode.ownedSubscriptions) {
        for (const owner of owners.slice(0, 2))
          h.receive({
            type: "agent_stream",
            payload: { ...live, subscriptionId: owner.subscriptionId },
          });
      } else h.receive({ type: "agent_stream", payload: live });
      for (const events of received.slice(0, 2))
        expect(events.map((update) => update.event.type)).toEqual(
          Array.from({ length: cycle + 1 }, () => [
            "subscription_restored",
            "turn_completed",
          ]).flat(),
        );
      expect(received[2]).toEqual([]);
    }
  } finally {
    await api.dispose();
    await h.client.close();
  }
});

test("a consumer chooses its recovery cursor and a failed read leaves live delivery active", async () => {
  const { createPaseoApi } = await import("./index");
  const h = connection({ acknowledgeTimelineReads: false });
  const api = createPaseoApi(h.client);
  const received: import("./index").PaseoAgentTimelineEvent[] = [];
  let read: Promise<unknown> | undefined;
  try {
    const connected = h.client.connect();
    h.open();
    await connected;
    const timeline = api.agents.ref("agent").timeline;
    const owner = timeline.subscribe((message) => {
      received.push(message);
      if (message.event.type === "subscription_restored") {
        read = timeline.refetch({
          direction: "after",
          cursor: { epoch: "cached", seq: 42 },
          limit: 7,
        });
        void read.catch(() => {});
      }
    });
    await owner.ready;
    h.disconnect();
    const reconnected = h.client.connect();
    h.open();
    await reconnected;
    await expect.poll(() => read !== undefined).toBe(true);
    const requests = h.sent.filter(
      (frame) => frame.message?.type === "fetch_agent_timeline_request",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].message).toMatchObject({
      direction: "after",
      cursor: { epoch: "cached", seq: 42 },
      limit: 7,
    });
    // A slow consumer-owned history read must not buffer or filter live events.
    for (let seq = 43; seq < 173; seq++)
      h.receive({
        type: "agent_stream",
        payload: {
          agentId: "agent",
          subscriptionId: owner.subscriptionId,
          seq,
          epoch: "cached",
          timestamp: new Date(0).toISOString(),
          event: { type: "turn_completed", provider: "codex" },
        },
      });
    expect(received).toHaveLength(131);
    h.receive({
      type: "agent.timeline.replacement",
      payload: { agentId: "agent", subscriptionId: owner.subscriptionId, epoch: "new" },
    });
    expect(received.at(-1)?.event).toEqual({ type: "replacement", epoch: "new" });
    const page = timelinePage(requests[0].message?.requestId, "cached", 42);
    h.receive({ ...page, payload: { ...page.payload, error: "History unavailable" } });
    await expect(read).rejects.toThrow("History unavailable");
    expect(owner.subscriptionId).not.toBeNull();
    expect(received.some((message) => message.event.type === "error")).toBe(false);
    expect(
      h.sent.filter((frame) => frame.message?.type === "fetch_agent_timeline_request"),
    ).toHaveLength(1);
    await owner.release();
  } finally {
    await api.dispose();
    await h.client.close();
  }
});

test("subscription-restored notification waits for the new membership acknowledgement", async () => {
  const h = connection({ acknowledgeSubscriptions: false });
  const received: unknown[] = [];
  const acknowledge = (id: string) =>
    h.receive({
      type: "agent.timeline.set_subscription.response",
      payload: {
        agentIds: ["agent"],
        requestId: h.sent.at(-1)?.message?.requestId,
        subscriptionId: id,
      },
    });
  try {
    const connected = h.client.connect();
    h.open();
    await connected;
    const owner = h.client.subscribeAgentTimeline("agent", (message) => received.push(message));
    acknowledge("first");
    await owner.ready;
    h.disconnect();
    const reconnected = h.client.connect();
    h.open();
    await reconnected;
    expect(received).toEqual([]);
    acknowledge("second");
    expect(received).toEqual([
      {
        type: "agent.timeline.subscription_restored",
        payload: { agentId: "agent", subscriptionId: "second" },
      },
    ]);
    await owner.release();
  } finally {
    await h.client.close();
  }
});

function legacyAgent(input: {
  id: string;
  cwd: string;
  status?: "idle" | "running";
  updatedAt?: string;
  projectRoot?: string;
}) {
  const updatedAt = input.updatedAt ?? "2026-06-18T10:00:00.000Z";
  return {
    agent: {
      id: input.id,
      provider: "mock",
      cwd: input.cwd,
      model: null,
      createdAt: updatedAt,
      updatedAt,
      lastUserMessageAt: null,
      status: input.status ?? "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: {},
    },
    project: {
      projectKey: "/repo",
      projectName: "repo",
      workspaceName: "app",
      checkout: {
        cwd: input.cwd,
        isGit: true,
        currentBranch: "main",
        remoteUrl: "git@example.com:repo/app.git",
        worktreeRoot: input.cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: input.projectRoot ?? "/repo",
      },
    },
  };
}

test.each([
  { cwd: "/repo/app", id: "/repo/app", root: "/repo" },
  { cwd: "C:\\repo\\app", id: "C:/repo/app", root: "C:\\repo" },
  { cwd: "C:\\", id: "C:", root: "C:\\" },
  { cwd: "C:/", id: "C:", root: "C:/" },
  { cwd: "\\\\server\\share\\", id: "//server/share", root: "\\\\server\\share\\" },
  { cwd: "\\\\?\\C:\\repo\\app", id: "//?/C:/repo/app", root: "\\\\?\\C:\\repo" },
  { cwd: "/repo/trailing space ", id: "/repo/trailing space", root: "/repo/ " },
  { cwd: "/repo/back\\slash", id: "/repo/back/slash", root: "/repo" },
])(
  "old workspaces preserve daemon filesystem paths ($cwd) and stable IDs",
  async ({ cwd, id, root }) => {
    const h = connection({ ownedSubscriptions: false, workspaceMultiplicity: false });
    try {
      const connecting = h.client.connect();
      h.open();
      await connecting;
      const workspaces = h.client.observeWorkspaces();
      const request = h.sent.at(-1)!.message!;
      expect(request.type).toBe("fetch_agents_request");
      h.receive({
        type: "fetch_agents_response",
        payload: {
          requestId: request.requestId,
          entries: [legacyAgent({ id: "agent", cwd, projectRoot: root, status: "idle" })],
          pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
        },
      });
      expect((await workspaces.ready).entries).toEqual([
        expect.objectContaining({
          id,
          workspaceDirectory: cwd,
          projectRootPath: root,
          projectId: "/repo",
          status: "done",
        }),
      ]);
      const updates: unknown[] = [];
      workspaces.subscribe({ snapshot: () => {}, update: (message) => updates.push(message) });
      const changed = legacyAgent({ id: "agent", cwd, projectRoot: root, status: "running" });
      h.receive({ type: "agent_update", payload: { kind: "upsert", ...changed } });
      expect(updates).toEqual([
        expect.objectContaining({
          type: "workspace_update",
          payload: expect.objectContaining({
            kind: "upsert",
            workspace: expect.objectContaining({
              id,
              workspaceDirectory: cwd,
              projectRootPath: root,
              status: "running",
            }),
          }),
        }),
      ]);
      const fetching = h.client.fetchAgent("agent");
      const detail = h.sent.at(-1)!.message!;
      h.receive({
        type: "fetch_agent_response",
        payload: { requestId: detail.requestId, ...changed, error: null },
      });
      expect((await fetching).agent?.workspaceId).toBe(id);
      expect(h.sent.filter((frame) => frame.type === "hello")).toHaveLength(1);
      await workspaces.release();
    } finally {
      await h.client.close();
    }
  },
);

test("legacy workspace pages contain only that page's groups and retain earlier live state", async () => {
  const h = connection({ ownedSubscriptions: false, workspaceMultiplicity: false });
  try {
    const connecting = h.client.connect();
    h.open();
    await connecting;
    const workspaces = h.client.observeWorkspaces();
    h.receive({
      type: "fetch_agents_response",
      payload: {
        requestId: h.sent.at(-1)!.message!.requestId,
        entries: [legacyAgent({ id: "first", cwd: "/first", status: "running" })],
        pageInfo: { hasMore: true, nextCursor: "next-page", prevCursor: null },
      },
    });
    const first = await workspaces.ready;
    const next = h.client.fetchWorkspaces({
      page: { cursor: first.pageInfo.nextCursor!, limit: 1 },
    });
    h.receive({
      type: "fetch_agents_response",
      payload: {
        requestId: h.sent.at(-1)!.message!.requestId,
        entries: [legacyAgent({ id: "second", cwd: "/second" })],
        pageInfo: { hasMore: false, nextCursor: null, prevCursor: "previous-page" },
      },
    });
    const second = await next;
    expect([...first.entries, ...second.entries].map((workspace) => workspace.id)).toEqual([
      "/first",
      "/second",
    ]);
    const updates: unknown[] = [];
    workspaces.subscribe({ snapshot: () => {}, update: (message) => updates.push(message) });
    // Earlier pages must remain in the aggregate: this idle sibling cannot
    // replace the running status of the first workspace.
    h.receive({
      type: "agent_update",
      payload: { kind: "upsert", ...legacyAgent({ id: "sibling", cwd: "/first" }) },
    });
    expect(updates).toEqual([]);
    h.receive({ type: "agent_update", payload: { kind: "remove", agentId: "first" } });
    expect(updates).toEqual([
      expect.objectContaining({
        type: "workspace_update",
        payload: expect.objectContaining({
          kind: "upsert",
          workspace: expect.objectContaining({ id: "/first", status: "done" }),
        }),
      }),
    ]);
    await workspaces.release();
  } finally {
    await h.client.close();
  }
});

test("old attention stream events reach the current notification interface", async () => {
  const h = connection({ ownedSubscriptions: false });
  try {
    const connecting = h.client.connect();
    h.open();
    await connecting;
    const observation = h.client.observeEvents(["agent_attention_required"]);
    await observation.ready;
    const received: unknown[] = [];
    observation.subscribe({ snapshot: () => {}, update: (message) => received.push(message) });
    h.receive({
      type: "agent_stream",
      payload: {
        agentId: "agent",
        timestamp: "2026-09-11T00:00:00Z",
        event: {
          type: "attention_required",
          provider: "mock",
          reason: "finished",
          timestamp: "2026-09-11T00:00:00Z",
          shouldNotify: true,
        },
      },
    });
    expect(received).toEqual([
      {
        type: "agent_attention_required",
        payload: {
          agentId: "agent",
          reason: "finished",
          timestamp: "2026-09-11T00:00:00Z",
          shouldNotify: true,
          subscriptionId: observation.subscriptionId,
        },
      },
    ]);
    await observation.release();
  } finally {
    await h.client.close();
  }
});

test("broadcast-only hosts expose local timeline readiness without sending an unsupported RPC", async () => {
  const h = connection({ ownedSubscriptions: false, broadcasts: true });
  try {
    const connected = h.client.connect();
    h.open();
    await connected;
    const observation = h.client.observeTimeline(["agent"]);
    expect(await observation.ready).toEqual({
      agentIds: ["agent"],
      requestId: expect.any(String),
      subscriptionId: observation.subscriptionId,
    });
    expect(h.sent).toHaveLength(1);
    await observation.release();
    expect(h.sent).toHaveLength(1);
  } finally {
    await h.client.close();
  }
});

test("old browser hosting requires the registration sent in hello", async () => {
  const h = connection({ ownedSubscriptions: false });
  try {
    const connected = h.client.connect();
    h.open();
    await connected;
    const observation = h.client.registerBrowserHost({
      hostKind: "test",
      supportedCommands: ["list_tabs"],
    });
    await expect(observation.ready).rejects.toThrow("browser_host");
    expect(h.sent).toHaveLength(1);
  } finally {
    await h.client.close();
  }
});

test("old timeline observers retain shared membership and restore surviving interests", async () => {
  const h = connection({ ownedSubscriptions: false });
  try {
    const connected = h.client.connect();
    h.open();
    await connected;
    const app = h.client.observeTimeline(["app"]);
    const plugin = h.client.observeTimeline(["plugin"]);
    await Promise.all([app.ready, plugin.ready]);
    expect(h.sent.at(-1)?.message?.agentIds).toEqual(["app", "plugin"]);
    await plugin.release();
    expect(h.sent.at(-1)?.message?.agentIds).toEqual(["app"]);
    h.disconnect();
    const reconnecting = h.client.connect();
    h.open();
    await reconnecting;
    await expect.poll(() => h.sent.at(-1)?.message?.agentIds).toEqual(["app"]);
    await app.release();
    expect(h.sent.at(-1)?.message?.agentIds).toEqual([]);
    expect(h.sent.some((frame) => frame.message?.type === "subscription.release.request")).toBe(
      false,
    );
  } finally {
    await h.client.close();
  }
});

test("old browser hosts attach to their hello registration without another connection", async () => {
  const registration = {
    hostKind: "desktop app",
    supportedCommands: ["list_tabs"] as ["list_tabs"],
  };
  const h = connection({ ownedSubscriptions: false, browserHost: registration });
  try {
    const connected = h.client.connect();
    h.open();
    await connected;
    const observation = h.client.registerBrowserHost(registration);
    expect(await observation.ready).toEqual({
      requestId: expect.any(String),
      subscriptionId: observation.subscriptionId,
    });
    await observation.release();
    expect(h.sent).toHaveLength(1);
  } finally {
    await h.client.close();
  }
});

test("delivery follows the negotiated client capability as well as the server feature", async () => {
  const h = connection({ ownedCapability: false });
  try {
    const connected = h.client.connect();
    h.open();
    await connected;
    const observation = h.client.observeEvents(["project.update"]);
    expect((await observation.ready).subscriptionId).toMatch(/^legacy:/);
    await observation.release();
    expect(h.sent.at(-1)?.message).toMatchObject({
      type: "session.events.set_subscription.request",
      events: [],
    });
  } finally {
    await h.client.close();
  }
});

test("subscribeFile returns its initial version without calling the change callback", async () => {
  const h = connection();
  try {
    const connected = h.client.connect();
    h.open();
    await connected;
    const changes: unknown[] = [];
    const initial = { status: "missing" as const, cwd: "/repo", path: "file.txt" };
    const subscribing = h.client.subscribeFile({ cwd: "/repo", path: "file.txt" }, (value) =>
      changes.push(value),
    );
    h.receive({
      type: "fs.file.subscribe.response",
      payload: {
        requestId: h.sent.at(-1)!.message!.requestId,
        subscriptionId: "file-owner",
        initial,
      },
    });
    const file = await subscribing;
    expect(file.initial).toEqual(initial);
    expect(changes).toEqual([]);
    const version = {
      status: "ready",
      cwd: "/repo",
      path: "file.txt",
      size: 1,
      modifiedAt: "2026-09-11T00:00:00Z",
    };
    h.receive({ type: "fs.file.update", payload: { subscriptionId: "file-owner", version } });
    expect(changes).toEqual([version]);
    await file.unsubscribe();
  } finally {
    await h.client.close();
  }
});

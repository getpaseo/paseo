import { beforeEach, describe, expect, it, vi } from "vitest";

const backing = vi.hoisted(() => new Map<string, string>());
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getAllKeys: async () => [...backing.keys()],
    multiGet: async (keys: string[]) => keys.map((key) => [key, backing.get(key) ?? null]),
    removeItem: async (key: string) => {
      backing.delete(key);
    },
    getItem: async (key: string) => backing.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      backing.set(key, value);
    },
  },
}));
beforeEach(async () => {
  backing.clear();
  vi.resetModules();
  const { useSessionStore } = await import("@/stores/session-store");
  useSessionStore
    .getState()
    .initializeSession(
      "host-1",
      null as unknown as import("@getpaseo/client/internal/daemon-client").DaemonClient,
    );
});

const idleClient = (sendAgentMessage = vi.fn(async () => ({}))) => ({
  sendAgentMessage,
  isConnected: true,
  fetchAgent: async () => ({ agent: { status: "idle" as const } }),
});

describe("offline message outbox", () => {
  it("preserves messages saved concurrently by two independent app windows", async () => {
    const first = await import("./store");
    await first.hydrateOutbox();
    vi.resetModules();
    const second = await import("./store");
    await second.hydrateOutbox();
    await Promise.all([
      first.enqueueOutboxItem(
        first.createPendingOutboxItem({
          id: "window-one",
          serverId: "host-1",
          agentId: "agent-1",
          text: "One",
          images: [],
          attachments: [],
        }),
      ),
      second.enqueueOutboxItem(
        second.createPendingOutboxItem({
          id: "window-two",
          serverId: "host-1",
          agentId: "agent-1",
          text: "Two",
          images: [],
          attachments: [],
        }),
      ),
    ]);
    vi.resetModules();
    const restored = await import("./store");
    await restored.hydrateOutbox();
    expect(
      restored.useOutboxStore
        .getState()
        .items.map((item) => item.id)
        .sort(),
    ).toEqual(["window-one", "window-two"]);
  });

  it("leaves unattempted messages pending when a send disconnects", async () => {
    const store = await import("./store");
    for (const id of ["first", "second"])
      await store.enqueueOutboxItem(
        store.createPendingOutboxItem({
          id,
          serverId: "host-1",
          agentId: id,
          text: id,
          sendBehavior: "interrupt",
          images: [],
          attachments: [],
        }),
      );
    let connected = true;
    const sendAgentMessage = vi.fn(async () => {
      connected = false;
      throw new Error("Disconnected");
    });
    const client = {
      ...idleClient(sendAgentMessage),
      get isConnected() {
        return connected;
      },
    };
    await (await import("./delivery")).drainPendingOutbox({ serverId: "host-1", client });
    expect(store.useOutboxStore.getState().items.map(({ id, status }) => ({ id, status }))).toEqual(
      [
        { id: "first", status: "needs_review" },
        { id: "second", status: "pending" },
      ],
    );
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
  });

  it("waits for the agent to be idle before draining the next queued message", async () => {
    const store = await import("./store");
    for (const id of ["first", "second"])
      await store.enqueueOutboxItem(
        store.createPendingOutboxItem({
          id,
          serverId: "host-1",
          agentId: "agent-1",
          text: id,
          sendBehavior: "queue",
          images: [],
          attachments: [],
        }),
      );
    let running = false;
    const sendAgentMessage = vi.fn(async () => {
      running = true;
      return {};
    });
    const client = {
      ...idleClient(sendAgentMessage),
      fetchAgent: async () => ({
        agent: { status: running ? ("running" as const) : ("idle" as const) },
      }),
    };
    const { drainPendingOutbox } = await import("./delivery");
    await drainPendingOutbox({ serverId: "host-1", client });
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    await drainPendingOutbox({ serverId: "host-1", client });
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    running = false;
    await drainPendingOutbox({ serverId: "host-1", client });
    expect(sendAgentMessage).toHaveBeenCalledTimes(2);
    expect(store.useOutboxStore.getState().items).toEqual([]);
  });

  it("reuses a canonical timeline row when retrying the same message", async () => {
    const store = await import("./store");
    const item = store.createPendingOutboxItem({
      id: "canonical",
      serverId: "host-1",
      agentId: "agent-1",
      text: "Already received",
      images: [],
      attachments: [],
    });
    await store.enqueueOutboxItem(item);
    const { useSessionStore } = await import("@/stores/session-store");
    const { createUserMessage } = await import("@/types/stream");
    const canonical = createUserMessage({
      clientMessageId: item.id,
      text: item.text,
      timestamp: new Date(),
    });
    useSessionStore
      .getState()
      .setAgentStreamState("host-1", "agent-1", { head: [], tail: [canonical] });
    const client = idleClient();
    await (await import("./delivery")).deliverOutboxItem({ item, client });
    expect(client.sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().sessions["host-1"]?.agentStreamTail.get("agent-1")).toEqual([
      canonical,
    ]);
    expect(store.useOutboxStore.getState().items).toEqual([]);
  });
  it("persists a pending message across reloads and retains its image", async () => {
    const first = await import("./store");
    const image = {
      id: "photo-1",
      mimeType: "image/png",
      storageType: "native-file" as const,
      storageKey: "/photos/one.png",
      createdAt: 1,
    };
    await first.enqueueOutboxItem(
      first.createPendingOutboxItem({
        id: "message-1",
        serverId: "host-1",
        agentId: "agent-1",
        text: "Look at this",
        images: [image],
        attachments: [],
      }),
    );

    vi.resetModules();
    const second = await import("./store");
    await second.hydrateOutbox();
    expect(second.useOutboxStore.getState().items).toMatchObject([
      { id: "message-1", status: "pending" },
    ]);
    expect(second.getOutboxImageIds().has("photo-1")).toBe(true);
  });

  it("requires manual review after an interrupted send, then retries with the same ID", async () => {
    const store = await import("./store");
    await store.enqueueOutboxItem(
      store.createPendingOutboxItem({
        id: "message-2",
        serverId: "host-1",
        agentId: "agent-1",
        text: "Continue",
        images: [],
        attachments: [],
      }),
    );
    const sendAgentMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("Connection dropped"))
      .mockResolvedValueOnce({});
    const delivery = await import("./delivery");
    const client = idleClient(sendAgentMessage);
    await delivery.drainPendingOutbox({ serverId: "host-1", client });
    expect(store.useOutboxStore.getState().items).toMatchObject([
      { id: "message-2", status: "needs_review", error: "Connection dropped" },
    ]);

    vi.resetModules();
    const restored = await import("./store");
    await restored.hydrateOutbox();
    expect(restored.useOutboxStore.getState().items[0]?.status).toBe("needs_review");
    const retried = await import("./delivery");
    await retried.deliverOutboxItem({
      item: restored.useOutboxStore.getState().items[0]!,
      client,
    });
    expect(sendAgentMessage.mock.calls.map((call) => call[2].messageId)).toEqual([
      "message-2",
      "message-2",
    ]);
    expect(restored.useOutboxStore.getState().items).toEqual([]);
  });

  it("does not auto-retry a send left in progress at app termination", async () => {
    const first = await import("./store");
    await first.enqueueOutboxItem(
      first.createPendingOutboxItem({
        id: "message-3",
        serverId: "host-1",
        agentId: "agent-1",
        text: "Maybe delivered",
        images: [],
        attachments: [],
      }),
    );
    await first.updateOutboxItem("message-3", (item) => ({ ...item, status: "sending" }));
    vi.resetModules();
    const restored = await import("./store");
    await restored.hydrateOutbox();
    expect(restored.useOutboxStore.getState().items[0]?.status).toBe("needs_review");
    const sendAgentMessage = vi.fn();
    const delivery = await import("./delivery");
    await delivery.drainPendingOutbox({ serverId: "host-1", client: idleClient(sendAgentMessage) });
    expect(sendAgentMessage).not.toHaveBeenCalled();
  });

  it("does not discard a message once delivery has started", async () => {
    const store = await import("./store");
    await store.enqueueOutboxItem(
      store.createPendingOutboxItem({
        id: "message-4",
        serverId: "host-1",
        agentId: "agent-1",
        text: "Send me",
        images: [],
        attachments: [],
      }),
    );
    await store.updateOutboxItem("message-4", (item) => ({ ...item, status: "sending" }));
    await store.discardOutboxItem("message-4");
    expect(store.useOutboxStore.getState().items).toMatchObject([
      { id: "message-4", status: "sending" },
    ]);
  });
});

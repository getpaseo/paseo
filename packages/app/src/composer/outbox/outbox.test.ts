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

  it("reconciles an interrupted send after reload without submitting it twice", async () => {
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
    const client = {
      ...idleClient(sendAgentMessage),
      getAgentMessageDeliveryStatus: vi
        .fn()
        .mockResolvedValueOnce({ status: "unknown" })
        .mockResolvedValueOnce({ status: "accepted" }),
    };
    await delivery.drainPendingOutbox({ serverId: "host-1", client });
    expect(store.useOutboxStore.getState().items).toMatchObject([
      { id: "message-2", status: "needs_review" },
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
    expect(sendAgentMessage.mock.calls.map((call) => call[2].messageId)).toEqual(["message-2"]);
    expect(client.getAgentMessageDeliveryStatus).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "message-2", text: "Continue" }),
    );
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

async function saveMessage(id: string) {
  const store = await import("./store");
  const item = store.createPendingOutboxItem({
    id,
    serverId: "host-1",
    agentId: "agent-1",
    text: "Original prompt",
    images: [],
    attachments: [],
  });
  await store.enqueueOutboxItem(item);
  return { store, item };
}

it("keeps slow delivery in flight and resolves its receipt without resending", async () => {
  const { store, item } = await saveMessage("slow");
  const client = {
    ...idleClient(
      vi.fn(async () => {
        throw new Error("Timed out waiting for the host");
      }),
    ),
    getAgentMessageDeliveryStatus: vi
      .fn()
      .mockResolvedValueOnce({ status: "in_flight" })
      .mockResolvedValueOnce({ status: "accepted" }),
  };
  const delivery = await import("./delivery");
  await delivery.deliverOutboxItem({ item, client });
  expect(store.useOutboxStore.getState().items[0]?.status).toBe("in_flight");
  await delivery.drainPendingOutbox({ serverId: item.serverId, client });
  expect(store.useOutboxStore.getState().items).toEqual([]);
  expect(client.sendAgentMessage).toHaveBeenCalledTimes(1);
});

it("retries a definite pre-dispatch rejection with exactly the same identity", async () => {
  const { store, item } = await saveMessage("rejected");
  const send = vi
    .fn()
    .mockRejectedValueOnce(
      Object.assign(new Error("Not submitted"), {
        deliveryOutcome: "not_submitted",
      }),
    )
    .mockResolvedValueOnce({});
  const client = idleClient(send);
  const { deliverOutboxItem } = await import("./delivery");
  await deliverOutboxItem({ item, client });
  expect(store.useOutboxStore.getState().items[0]?.status).toBe("failed");
  await deliverOutboxItem({ item, client });
  expect(send.mock.calls.map((call) => call[2].messageId)).toEqual(["rejected", "rejected"]);
  expect(store.useOutboxStore.getState().items).toEqual([]);
});

it("classifies image encoding failures as unsent and allows retry", async () => {
  const { store, item } = await saveMessage("image-error");
  const client = idleClient();
  const { deliverOutboxItem } = await import("./delivery");
  await deliverOutboxItem({
    item,
    client,
    encode: async () => {
      throw new Error("Cannot read image");
    },
  });
  expect(store.useOutboxStore.getState().items[0]).toMatchObject({
    status: "failed",
    error: "Cannot read image",
  });
  expect(client.sendAgentMessage).not.toHaveBeenCalled();
  await deliverOutboxItem({ item, client });
  expect(client.sendAgentMessage).toHaveBeenCalledTimes(1);
});

it("never infers delivery from a timeline row or a missing receipt", async () => {
  const { store, item } = await saveMessage("uncertain");
  const client = {
    ...idleClient(
      vi.fn(async () => {
        throw new Error("Disconnected");
      }),
    ),
    getAgentMessageDeliveryStatus: vi.fn(async () => ({
      status: "unknown" as const,
      failure: undefined,
    })),
  };
  const delivery = await import("./delivery");
  await delivery.deliverOutboxItem({ item, client });
  await delivery.deliverOutboxItem({ item, client });
  expect(store.useOutboxStore.getState().items[0]?.status).toBe("needs_review");
  const { useSessionStore } = await import("@/stores/session-store");
  expect(
    useSessionStore.getState().sessions[item.serverId]?.agentStreamTail.get(item.agentId),
  ).toMatchObject([{ clientMessageId: item.id }]);
  expect(client.sendAgentMessage).toHaveBeenCalledTimes(1);
});

it("queues a definite retry visibly while the agent is busy", async () => {
  const { store, item } = await saveMessage("busy");
  await store.updateOutboxItem(item.id, (current) => ({ ...current, status: "failed" }));
  const client = {
    ...idleClient(),
    fetchAgent: async () => ({ agent: { status: "running" as const } }),
  };
  const { deliverOutboxItem } = await import("./delivery");
  await deliverOutboxItem({ item, client });
  expect(store.useOutboxStore.getState().items[0]?.status).toBe("pending");
  expect(client.sendAgentMessage).not.toHaveBeenCalled();
});

it("preserves the original wire image payload for read-only reconciliation after reload", async () => {
  const { store, item } = await saveMessage("image-wire");
  const images = [{ data: "original-payload", mimeType: "image/png" }];
  let connected = true;
  const client = {
    ...idleClient(
      vi.fn(async () => {
        connected = false;
        throw new Error("Connection lost");
      }),
    ),
    get isConnected() {
      return connected;
    },
    getAgentMessageDeliveryStatus: vi.fn(async () => ({
      status: "accepted" as const,
      failure: undefined,
    })),
  };
  const delivery = await import("./delivery");
  await delivery.deliverOutboxItem({ item, client, encode: async () => images });
  expect(store.useOutboxStore.getState().items[0]?.wireImages).toEqual(images);
  connected = true;
  vi.resetModules();
  const restored = await import("./store");
  await restored.hydrateOutbox();
  await (await import("./delivery")).drainPendingOutbox({ serverId: item.serverId, client });
  expect(client.getAgentMessageDeliveryStatus).toHaveBeenCalledWith(
    expect.objectContaining({ images }),
  );
  expect(client.sendAgentMessage).toHaveBeenCalledTimes(1);
  expect(restored.useOutboxStore.getState().items).toEqual([]);
});

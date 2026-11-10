import { beforeEach, describe, expect, it, vi } from "vitest";

const backing = vi.hoisted(() => new Map<string, string>());
const submission = vi.hoisted(() => ({
  begin: vi.fn(),
  accept: vi.fn(),
  reject: vi.fn(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => backing.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      backing.set(key, value);
    },
  },
}));
vi.mock("@/composer/submission/writer", () => ({
  createMessageSubmissionWriter: () => submission,
}));

beforeEach(() => {
  backing.clear();
  submission.begin.mockClear();
  submission.accept.mockClear();
  submission.reject.mockClear();
  vi.resetModules();
});

describe("offline message outbox", () => {
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
    const client = { sendAgentMessage };
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
    await delivery.drainPendingOutbox({ serverId: "host-1", client: { sendAgentMessage } });
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

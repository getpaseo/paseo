import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DaemonClient,
  type NormalizedQueuedAgentMessageQueuePayload,
} from "@getpaseo/client/internal/daemon-client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { createLocalFileAttachmentStore } from "@/attachments/local-file-attachment-store";
import { __setAttachmentStoreForTests } from "@/attachments/store";
import { createTestAttachmentFileSystem } from "@/attachments/test-attachment-file-system";
import type { QueuedComposerMessage } from "@/composer/actions";
import type { DirectorySourceToken } from "@/runtime/directory-sync/transaction";
import { useSessionStore } from "@/stores/session-store";
import { AgentMessageQueueSync } from "./agent-message-queue-sync";

const SERVER_ID = "queue-sync-test";
const FIRST_SOURCE = { clientGeneration: 1, connectionEpoch: 1 } as const;
const SECOND_SOURCE = { clientGeneration: 1, connectionEpoch: 2 } as const;
const THIRD_SOURCE = { clientGeneration: 1, connectionEpoch: 3 } as const;
const FOURTH_SOURCE = { clientGeneration: 1, connectionEpoch: 4 } as const;

type QueueUpdateMessage = Extract<SessionOutboundMessage, { type: "queue.agent_message.updated" }>;
type QueueConnection = Parameters<AgentMessageQueueSync["connectionChanged"]>[0];
type QueueClient = NonNullable<QueueConnection["client"]>;

function deferred<T>(): PromiseWithResolvers<T> {
  return Promise.withResolvers<T>();
}

function queuePayload(
  agentId: string,
  revision: number,
  messageIds: readonly string[],
): NormalizedQueuedAgentMessageQueuePayload {
  return {
    agentId,
    revision,
    messages: messageIds.map((id) => ({
      id,
      agentId,
      text: id,
      createdAt: "2026-07-30T00:00:00.000Z",
      images: [],
      attachments: [],
      imageCount: 0,
      attachmentCount: 0,
    })),
  };
}

function localMessage(id: string): QueuedComposerMessage {
  return { id, text: id, attachments: [] };
}

function createClientHarness(options: { agentMessageQueue?: boolean } = {}) {
  const listeners = new Set<(message: QueueUpdateMessage) => void | Promise<void>>();
  const queueAgentMessage = vi.fn<DaemonClient["queueAgentMessage"]>(async () => null);
  const listQueuedAgentMessages = vi.fn<DaemonClient["listQueuedAgentMessages"]>(async () => []);
  const client = {
    identity: {},
    getLastServerInfoMessage: () => ({
      status: "server_info" as const,
      serverId: SERVER_ID,
      hostname: null,
      version: "0.2.5",
      features: { agentMessageQueue: options.agentMessageQueue ?? true },
    }),
    subscribeQueueUpdates: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    queueAgentMessage,
    listQueuedAgentMessages,
  } satisfies QueueClient;

  return {
    client,
    queueAgentMessage,
    listQueuedAgentMessages,
    async emit(message: QueueUpdateMessage): Promise<void> {
      await Promise.all(Array.from(listeners, async (listener) => await listener(message)));
    },
  };
}

function connect(
  sync: AgentMessageQueueSync,
  client: QueueClient,
  source: DirectorySourceToken,
  agentIds: readonly string[],
): void {
  sync.connectionChanged({ client, status: "online", source });
  sync.directoryCommitted(new Set(agentIds), source);
}

beforeEach(() => {
  const store = useSessionStore.getState();
  store.initializeSession(SERVER_ID, null);
  store.updateSessionServerInfo(SERVER_ID, {
    serverId: SERVER_ID,
    hostname: null,
    version: "0.2.5",
    features: { agentMessageQueue: true, forgeSearch: true },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  __setAttachmentStoreForTests(null);
  useSessionStore.getState().clearSession(SERVER_ID);
});

describe("AgentMessageQueueSync", () => {
  it("preserves a failed suffix and retries only unacknowledged ids after reconnect", async () => {
    const first = localMessage("first");
    const second = localMessage("second");
    const third = localMessage("third");
    useSessionStore
      .getState()
      .setQueuedMessages(SERVER_ID, new Map([["agent-a", [first, second, third]]]));
    const harness = createClientHarness();
    harness.queueAgentMessage.mockImplementation(async (_agentId, _text, options) => {
      if (options?.messageId === "second") throw new Error("temporary failure");
      return null;
    });
    harness.listQueuedAgentMessages.mockResolvedValueOnce([queuePayload("agent-a", 1, ["first"])]);
    const sync = new AgentMessageQueueSync(SERVER_ID);

    connect(sync, harness.client, FIRST_SOURCE, ["agent-a"]);
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));

    expect(harness.queueAgentMessage.mock.calls.map(([, , options]) => options?.messageId)).toEqual(
      ["first", "second"],
    );
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual([
      first,
      second,
      third,
    ]);

    harness.queueAgentMessage.mockImplementation(async () => null);
    harness.listQueuedAgentMessages.mockResolvedValueOnce([
      queuePayload("agent-a", 2, ["first", "second", "third"]),
    ]);
    connect(sync, harness.client, SECOND_SOURCE, ["agent-a"]);
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(2));

    expect(harness.queueAgentMessage.mock.calls.map(([, , options]) => options?.messageId)).toEqual(
      ["first", "second", "second", "third"],
    );
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual([
      first,
      second,
      third,
    ]);
    sync.dispose();
  });

  it("does not legacy-drain daemon-owned mirrors after a host downgrade", async () => {
    const pending = localMessage("pending-migration");
    useSessionStore.getState().setQueuedMessages(SERVER_ID, new Map([["agent-a", [pending]]]));
    const currentHarness = createClientHarness();
    currentHarness.queueAgentMessage.mockRejectedValue(new Error("migration unavailable"));
    currentHarness.listQueuedAgentMessages.mockResolvedValue([
      queuePayload("agent-a", 1, ["daemon-owned"]),
    ]);
    const legacyHarness = createClientHarness({ agentMessageQueue: false });
    const sync = new AgentMessageQueueSync(SERVER_ID);

    sync.connectionChanged({
      client: currentHarness.client,
      status: "online",
      source: FIRST_SOURCE,
    });
    sync.connectionChanged({
      client: legacyHarness.client,
      status: "online",
      source: SECOND_SOURCE,
    });
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual([
      pending,
    ]);

    connect(sync, currentHarness.client, THIRD_SOURCE, ["agent-a"]);
    await vi.waitFor(() =>
      expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual(
        [expect.objectContaining({ id: "daemon-owned" }), pending],
      ),
    );

    connect(sync, legacyHarness.client, FOURTH_SOURCE, ["agent-a"]);

    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual([
      pending,
    ]);
    expect(legacyHarness.listQueuedAgentMessages).not.toHaveBeenCalled();
    sync.dispose();
  });

  it("continues initial sync without restoring agents removed during migration", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const migration = deferred<null>();
    useSessionStore.getState().setQueuedMessages(
      SERVER_ID,
      new Map([
        ["agent-archive", [localMessage("archive-message")]],
        ["agent-delete", [localMessage("delete-message")]],
      ]),
    );
    const harness = createClientHarness();
    harness.queueAgentMessage.mockImplementationOnce(async () => await migration.promise);
    harness.listQueuedAgentMessages.mockResolvedValue([
      queuePayload("active-agent", 1, ["server-message"]),
    ]);
    const sync = new AgentMessageQueueSync(SERVER_ID);

    connect(sync, harness.client, FIRST_SOURCE, ["agent-archive", "agent-delete", "active-agent"]);
    await vi.waitFor(() => expect(harness.queueAgentMessage).toHaveBeenCalledTimes(1));
    sync.removeAgent("agent-archive", FIRST_SOURCE);
    sync.removeAgent("agent-delete", FIRST_SOURCE);
    migration.reject(new Error("archived while migrating"));

    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages).toEqual(
      new Map([
        [
          "active-agent",
          [
            {
              id: "server-message",
              text: "server-message",
              attachments: [],
              canEdit: true,
            },
          ],
        ],
      ]),
    );
    sync.dispose();
  });

  it("prunes local queues missing from the authoritative active directory", async () => {
    useSessionStore
      .getState()
      .setQueuedMessages(
        SERVER_ID,
        new Map([["removed-while-disconnected", [localMessage("pending")]]]),
      );
    const harness = createClientHarness();
    const sync = new AgentMessageQueueSync(SERVER_ID);

    connect(sync, harness.client, FIRST_SOURCE, ["active-agent"]);
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));

    expect(harness.queueAgentMessage).not.toHaveBeenCalled();
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages).toEqual(new Map());
    sync.dispose();
  });

  it("hydrates omitted image and attachment payloads from a queue update", async () => {
    __setAttachmentStoreForTests(
      createLocalFileAttachmentStore({
        storageType: "desktop-file",
        baseDirectoryName: "queue-sync-test",
        fileSystem: createTestAttachmentFileSystem(),
        resolvePreviewUrl: async (attachment) => `file://${attachment.storageKey}`,
      }),
    );
    const harness = createClientHarness();
    const sync = new AgentMessageQueueSync(SERVER_ID);
    connect(sync, harness.client, FIRST_SOURCE, ["agent-a"]);
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));

    const hydrated = queuePayload("agent-a", 1, ["hydrated"]);
    hydrated.messages[0] = {
      ...hydrated.messages[0],
      images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
      attachments: [
        {
          type: "uploaded_file",
          id: "uploaded-1",
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 5,
          path: "/uploads/notes.txt",
        },
      ],
      imageCount: 1,
      attachmentCount: 1,
    };
    const hydration = deferred<NormalizedQueuedAgentMessageQueuePayload[]>();
    harness.listQueuedAgentMessages.mockImplementationOnce(async () => await hydration.promise);

    let applicationFinished = false;
    const applying = harness.emit({
      type: "queue.agent_message.updated",
      payload: {
        agentId: "agent-a",
        revision: 1,
        messages: [
          {
            id: "hydrated",
            agentId: "agent-a",
            text: "hydrated",
            createdAt: "2026-07-30T00:00:00.000Z",
            imageCount: 1,
            attachmentCount: 1,
          },
        ],
      },
    });
    const applicationCompleted = applying.finally(() => {
      applicationFinished = true;
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(2));
    expect(applicationFinished).toBe(false);

    hydration.resolve([hydrated]);
    await applicationCompleted;

    expect(harness.listQueuedAgentMessages).toHaveBeenLastCalledWith("agent-a");
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")).toEqual([
      {
        id: "hydrated",
        text: "hydrated",
        attachments: [
          {
            kind: "image",
            metadata: expect.objectContaining({
              id: "queued:queue-sync-test:agent-a:hydrated:image:0",
              mimeType: "image/png",
              storageType: "desktop-file",
            }),
          },
          { kind: "file", attachment: hydrated.messages[0]?.attachments[0] },
        ],
        canEdit: true,
      },
    ]);
    sync.dispose();
  });

  it("does not resurrect an agent removed while broadcast hydration is in flight", async () => {
    const harness = createClientHarness();
    const sync = new AgentMessageQueueSync(SERVER_ID);
    connect(sync, harness.client, FIRST_SOURCE, ["agent-a"]);
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(1));

    const hydration = deferred<NormalizedQueuedAgentMessageQueuePayload[]>();
    harness.listQueuedAgentMessages.mockImplementationOnce(async () => await hydration.promise);
    let applicationFinished = false;
    const applying = harness.emit({
      type: "queue.agent_message.updated",
      payload: {
        agentId: "agent-a",
        revision: 1,
        messages: [
          {
            id: "stale-hydration",
            agentId: "agent-a",
            text: "stale-hydration",
            createdAt: "2026-07-30T00:00:00.000Z",
            imageCount: 1,
            attachmentCount: 0,
          },
        ],
      },
    });
    const applicationCompleted = applying.finally(() => {
      applicationFinished = true;
    });
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(2));
    expect(applicationFinished).toBe(false);

    sync.directoryCommitted(new Set(), FIRST_SOURCE);
    hydration.resolve([queuePayload("agent-a", 1, ["stale-hydration"])]);
    await applicationCompleted;

    expect(applicationFinished).toBe(true);
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.has("agent-a")).toBe(
      false,
    );
    sync.dispose();
  });

  it("applies revisions within one source and resets them for a new authoritative snapshot", async () => {
    const harness = createClientHarness();
    harness.listQueuedAgentMessages
      .mockResolvedValueOnce([queuePayload("agent-a", 5, ["old-server-message"])])
      .mockResolvedValueOnce([]);
    const sync = new AgentMessageQueueSync(SERVER_ID);

    connect(sync, harness.client, FIRST_SOURCE, ["agent-a"]);
    await vi.waitFor(() =>
      expect(
        useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")?.[0]?.id,
      ).toBe("old-server-message"),
    );

    await harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", 4, ["stale"]),
    });
    await vi.waitFor(() =>
      expect(
        useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")?.[0]?.id,
      ).toBe("old-server-message"),
    );
    await harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", 5, ["same-revision-refresh"]),
    });
    await vi.waitFor(() =>
      expect(
        useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")?.[0]?.id,
      ).toBe("same-revision-refresh"),
    );

    connect(sync, harness.client, SECOND_SOURCE, ["agent-a"]);
    await vi.waitFor(() => expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(2));
    expect(useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.has("agent-a")).toBe(
      false,
    );

    await harness.emit({
      type: "queue.agent_message.updated",
      payload: queuePayload("agent-a", 1, ["fresh-after-reset"]),
    });
    await vi.waitFor(() =>
      expect(
        useSessionStore.getState().sessions[SERVER_ID]?.queuedMessages.get("agent-a")?.[0]?.id,
      ).toBe("fresh-after-reset"),
    );
    sync.directoryCommitted(new Set(["agent-a"]), SECOND_SOURCE);
    expect(harness.listQueuedAgentMessages).toHaveBeenCalledTimes(2);
    sync.dispose();
  });
});

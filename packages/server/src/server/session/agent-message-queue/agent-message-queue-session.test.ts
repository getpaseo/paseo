import { describe, expect, it, vi } from "vitest";

import type { SessionOutboundMessage } from "../../messages.js";
import type { AgentMessageQueueController } from "../../agent-message-queue.js";
import {
  type AgentIdentifierResolution,
  AgentMessageQueueSession,
} from "./agent-message-queue-session.js";

function createHarness(options?: {
  queue?: AgentMessageQueueController;
  resolveAgentIdentifier?: (identifier: string) => Promise<AgentIdentifierResolution>;
}) {
  const emitted: Array<{ message: SessionOutboundMessage; source?: object }> = [];
  const source = {};
  const resolveAgentIdentifier = vi.fn(
    options?.resolveAgentIdentifier ??
      (async (identifier: string) => ({
        ok: true as const,
        agentId: `resolved:${identifier}`,
      })),
  );
  const session = new AgentMessageQueueSession({
    host: {
      emit: (message, messageSource) => emitted.push({ message, source: messageSource }),
      resolveAgentIdentifier,
    },
    queue: options?.queue,
  });
  return { emitted, resolveAgentIdentifier, session, source };
}

function createQueue(): AgentMessageQueueController {
  return {
    enqueue: vi.fn(async (input) => ({
      id: input.messageId ?? "generated-id",
      agentId: input.agentId,
      text: input.text,
      createdAt: "2026-07-30T00:00:00.000Z",
      images: input.images ?? [],
      attachments: input.attachments ?? [],
      imageCount: input.images?.length ?? 0,
      attachmentCount: input.attachments?.length ?? 0,
    })),
    list: vi.fn(async () => []),
    cancel: vi.fn(async () => true),
    dispatchNow: vi.fn(async () => undefined),
    clearAgent: vi.fn(async () => undefined),
  };
}

describe("AgentMessageQueueSession", () => {
  it("owns queue request recognition, normalization, and source-aware responses", async () => {
    const queue = createQueue();
    const { emitted, session, source } = createHarness({ queue });

    expect(
      session.dispatch({
        type: "ping",
        requestId: "ping-1",
      }),
    ).toBeUndefined();

    await session.dispatch(
      {
        type: "queue.agent_message.enqueue.request",
        requestId: "request-1",
        agentId: "agent-prefix",
        text: "hello",
        messageId: "message-1",
        attachments: [
          {
            type: "uploaded_file",
            id: "file-1",
            fileName: "notes.txt",
            mimeType: "text/plain",
            size: 5,
            path: "/tmp/notes.txt",
          },
          { type: "future_attachment", payload: "opaque" },
        ],
      },
      source,
    );

    expect(queue.enqueue).toHaveBeenCalledWith({
      agentId: "resolved:agent-prefix",
      text: "hello",
      messageId: "message-1",
      images: [],
      attachments: [
        {
          type: "uploaded_file",
          id: "file-1",
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 5,
          path: "/tmp/notes.txt",
        },
      ],
    });
    expect(emitted).toEqual([
      {
        source,
        message: {
          type: "queue.agent_message.enqueue.response",
          payload: {
            requestId: "request-1",
            agentId: "resolved:agent-prefix",
            accepted: true,
            message: expect.objectContaining({ id: "message-1" }),
            error: null,
          },
        },
      },
    ]);
  });

  it("keeps list, cancel, and dispatch result envelopes inside the queue domain", async () => {
    const queue = createQueue();
    vi.mocked(queue.list).mockResolvedValue([
      { agentId: "resolved:agent", revision: 2, messages: [] },
    ]);
    vi.mocked(queue.cancel).mockResolvedValue(false);
    vi.mocked(queue.dispatchNow).mockRejectedValue(new Error("provider refused replacement"));
    const { emitted, session } = createHarness({ queue });

    await session.dispatch({
      type: "queue.agent_message.list.request",
      requestId: "list-1",
      agentId: "agent",
    });
    await session.dispatch({
      type: "queue.agent_message.cancel.request",
      requestId: "cancel-1",
      agentId: "agent",
      queuedMessageId: "missing",
    });
    await session.dispatch({
      type: "queue.agent_message.dispatch.request",
      requestId: "dispatch-1",
      agentId: "agent",
      queuedMessageId: "message-1",
    });

    expect(emitted.map(({ message }) => message)).toEqual([
      {
        type: "queue.agent_message.list.response",
        payload: {
          requestId: "list-1",
          queues: [{ agentId: "resolved:agent", revision: 2, messages: [] }],
          error: null,
        },
      },
      {
        type: "queue.agent_message.cancel.response",
        payload: {
          requestId: "cancel-1",
          agentId: "resolved:agent",
          queuedMessageId: "missing",
          accepted: false,
          error: "Queued message not found: missing",
        },
      },
      {
        type: "queue.agent_message.dispatch.response",
        payload: {
          requestId: "dispatch-1",
          agentId: "resolved:agent",
          queuedMessageId: "message-1",
          accepted: false,
          error: "provider refused replacement",
        },
      },
    ]);
  });

  it("returns an RPC rejection when the daemon-global queue is unavailable", async () => {
    const { emitted, session } = createHarness();

    await session.dispatch({
      type: "queue.agent_message.enqueue.request",
      requestId: "request-1",
      agentId: "agent",
      text: "hello",
    });

    expect(emitted[0]?.message).toEqual({
      type: "queue.agent_message.enqueue.response",
      payload: {
        requestId: "request-1",
        agentId: "resolved:agent",
        accepted: false,
        message: null,
        error: "Agent message queue is unavailable",
      },
    });
  });

  it("returns typed errors without exposing identifier resolution failures", async () => {
    const queue = createQueue();
    const { emitted, session } = createHarness({
      queue,
      resolveAgentIdentifier: async () => {
        throw new Error("storage path /private/paseo/agents failed");
      },
    });

    await session.dispatch({
      type: "queue.agent_message.enqueue.request",
      requestId: "enqueue-1",
      agentId: "agent",
      text: "hello",
    });
    await session.dispatch({
      type: "queue.agent_message.list.request",
      requestId: "list-1",
      agentId: "agent",
    });
    await session.dispatch({
      type: "queue.agent_message.cancel.request",
      requestId: "cancel-1",
      agentId: "agent",
      queuedMessageId: "queued-1",
    });
    await session.dispatch({
      type: "queue.agent_message.dispatch.request",
      requestId: "dispatch-1",
      agentId: "agent",
      queuedMessageId: "queued-1",
    });

    expect(emitted.map(({ message }) => message)).toEqual([
      {
        type: "queue.agent_message.enqueue.response",
        payload: {
          requestId: "enqueue-1",
          agentId: "agent",
          accepted: false,
          message: null,
          error: "Failed to resolve agent identifier",
        },
      },
      {
        type: "queue.agent_message.list.response",
        payload: {
          requestId: "list-1",
          queues: [],
          error: "Failed to resolve agent identifier",
        },
      },
      {
        type: "queue.agent_message.cancel.response",
        payload: {
          requestId: "cancel-1",
          agentId: "agent",
          queuedMessageId: "queued-1",
          accepted: false,
          error: "Failed to resolve agent identifier",
        },
      },
      {
        type: "queue.agent_message.dispatch.response",
        payload: {
          requestId: "dispatch-1",
          agentId: "agent",
          queuedMessageId: "queued-1",
          accepted: false,
          error: "Failed to resolve agent identifier",
        },
      },
    ]);
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(queue.list).not.toHaveBeenCalled();
    expect(queue.cancel).not.toHaveBeenCalled();
    expect(queue.dispatchNow).not.toHaveBeenCalled();
  });
});

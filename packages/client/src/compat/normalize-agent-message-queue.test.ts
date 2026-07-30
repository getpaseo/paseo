import { describe, expect, it } from "vitest";

import {
  normalizeAgentMessageQueueMessage,
  normalizeQueuedAgentMessagePayload,
  normalizeQueuedAgentMessageQueuePayload,
} from "./normalize-agent-message-queue.js";

describe("agent message queue compatibility normalization", () => {
  it("applies old-daemon defaults after structural wire parsing", () => {
    expect(
      normalizeQueuedAgentMessageQueuePayload({
        agentId: "agent-1",
        messages: [
          {
            id: "message-1",
            agentId: "agent-1",
            text: "hello",
            createdAt: "2026-07-30T00:00:00.000Z",
          },
        ],
      }),
    ).toEqual({
      agentId: "agent-1",
      revision: 0,
      messages: [
        {
          id: "message-1",
          agentId: "agent-1",
          text: "hello",
          createdAt: "2026-07-30T00:00:00.000Z",
          images: [],
          attachments: [],
          imageCount: 0,
          attachmentCount: 0,
        },
      ],
    });
  });

  it("drops unknown attachment shapes but retains their count", () => {
    const normalized = normalizeQueuedAgentMessagePayload({
      id: "message-1",
      agentId: "agent-1",
      text: "hello",
      createdAt: "2026-07-30T00:00:00.000Z",
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
    });

    expect(normalized.attachments).toHaveLength(1);
    expect(normalized.attachmentCount).toBe(2);
  });

  it("normalizes queue events before consumers and request waiters see them", () => {
    const normalized = normalizeAgentMessageQueueMessage({
      type: "queue.agent_message.updated",
      payload: { agentId: "agent-1", messages: [] },
    });

    expect(normalized).toEqual({
      type: "queue.agent_message.updated",
      payload: { agentId: "agent-1", revision: 0, messages: [] },
    });
  });
});

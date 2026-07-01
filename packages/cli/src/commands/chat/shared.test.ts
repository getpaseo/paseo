import { describe, expect, it, vi } from "vitest";
import { attachAgentNamesToMessages, type ChatAgentNameClient } from "./shared.js";
import type { ChatMessageRow } from "./schema.js";

const message: ChatMessageRow = {
  id: "msg-1",
  author: "agent-1",
  authorName: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  replyTo: "-",
  mentionAgentIds: ["agent-2"],
  mentionLabels: ["agent-2"],
  body: "hello @agent-2",
};

describe("attachAgentNamesToMessages", () => {
  it("keeps chat output usable when agent-name enrichment fails", async () => {
    const fetchAgent = vi.fn(async () => {
      throw Object.assign(new Error("Project not found for workspace wks_missing"), {
        code: "fetch_agent_failed",
      });
    });
    const client: ChatAgentNameClient = { fetchAgent };

    await expect(attachAgentNamesToMessages(client, [message])).resolves.toEqual([message]);
    expect(fetchAgent).toHaveBeenCalledTimes(2);
    expect(fetchAgent).toHaveBeenCalledWith({ agentId: "agent-1" });
    expect(fetchAgent).toHaveBeenCalledWith({ agentId: "agent-2" });
  });
});

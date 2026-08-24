import { describe, expect, it } from "vitest";
import type { AgentProviderNotice } from "@getpaseo/protocol/agent-types";
import {
  applyAgentChanges,
  toAgentUpdateResult,
  type AgentMetadataChanges,
  type AgentUpdateClient,
} from "./update.js";

class RecordingAgentUpdateClient implements AgentUpdateClient {
  readonly metadataUpdates: Array<{
    agentId: string;
    updates: AgentMetadataChanges;
  }> = [];
  readonly thinkingUpdates: Array<{ agentId: string; thinkingOptionId: string }> = [];
  thinkingNotice: AgentProviderNotice | null = null;

  constructor(private readonly supportsThinkingUpdate = true) {}

  getLastServerInfoMessage() {
    return { features: { agentThinkingUpdate: this.supportsThinkingUpdate } };
  }

  async updateAgent(agentId: string, updates: AgentMetadataChanges): Promise<void> {
    this.metadataUpdates.push({ agentId, updates });
  }

  async setAgentThinkingOption(
    agentId: string,
    thinkingOptionId: string,
  ): Promise<AgentProviderNotice | null> {
    this.thinkingUpdates.push({ agentId, thinkingOptionId });
    return this.thinkingNotice;
  }
}

describe("applyAgentChanges", () => {
  it("updates an agent's thinking without issuing an empty metadata update", async () => {
    const client = new RecordingAgentUpdateClient();

    const result = await applyAgentChanges(client, "agent-1", {
      type: "thinking",
      thinkingOptionId: "high",
    });

    expect(client.metadataUpdates).toEqual([]);
    expect(client.thinkingUpdates).toEqual([{ agentId: "agent-1", thinkingOptionId: "high" }]);
    expect(result).toEqual({
      notice: null,
    });
  });

  it("requires a daemon that advertises thinking updates", async () => {
    const client = new RecordingAgentUpdateClient(false);

    await expect(
      applyAgentChanges(client, "agent-1", { type: "thinking", thinkingOptionId: "high" }),
    ).rejects.toMatchObject({
      code: "DAEMON_UPDATE_REQUIRED",
      message: "Update the host to use agent thinking updates.",
    });
    expect(client.metadataUpdates).toEqual([]);
    expect(client.thinkingUpdates).toEqual([]);
  });

  it("returns the provider notice from a thinking update", async () => {
    const client = new RecordingAgentUpdateClient();
    client.thinkingNotice = {
      type: "warning",
      message: "Thinking changes apply to the next turn.",
    };

    const notice = await applyAgentChanges(client, "agent-1", {
      type: "thinking",
      thinkingOptionId: "high",
    });

    expect(notice).toEqual({
      notice: {
        type: "warning",
        message: "Thinking changes apply to the next turn.",
      },
    });
  });
});

describe("toAgentUpdateResult", () => {
  it("reports the current thinking option after a metadata update", () => {
    const result = toAgentUpdateResult(
      {
        id: "agent-1",
        title: "Renamed agent",
        labels: { team: "platform" },
        effectiveThinkingOptionId: "high",
      },
      { notice: null },
    );

    expect(result).toEqual({
      agentId: "agent-1",
      name: "Renamed agent",
      labels: "team=platform",
      thinkingOptionId: "high",
      noticeType: null,
      notice: null,
    });
  });
});

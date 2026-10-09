import { describe, expect, it } from "vitest";
import type { AgentProviderNotice } from "@getpaseo/protocol/agent-types";
import {
  applyAgentChanges,
  updateAgentFeatures,
  type AgentFeatureUpdateClient,
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
      features: "-",
      noticeType: null,
      notice: null,
    });
  });

  it("reports the agent's current feature values", () => {
    const result = toAgentUpdateResult(
      {
        id: "agent-1",
        title: null,
        labels: {},
        effectiveThinkingOptionId: null,
        features: [
          {
            type: "select",
            id: "service_tier",
            label: "Speed",
            value: "priority",
            options: [
              { id: "default", label: "Normal" },
              { id: "priority", label: "Fast" },
            ],
          },
          { type: "toggle", id: "plan_mode", label: "Plan", value: false },
        ],
      },
      { notice: null },
    );

    expect(result.features).toBe("service_tier=priority,plan_mode=false");
  });
});

class RecordingFeatureClient implements AgentFeatureUpdateClient {
  readonly updates: Array<{ agentId: string; featureId: string; value: unknown }> = [];

  constructor(private readonly rejectFeatureId?: string) {}

  async setAgentFeature(agentId: string, featureId: string, value: unknown): Promise<void> {
    if (featureId === this.rejectFeatureId) {
      throw new Error("provider rejected the value");
    }
    this.updates.push({ agentId, featureId, value });
  }
}

describe("updateAgentFeatures", () => {
  const agent = {
    id: "agent-1",
    features: [
      {
        type: "select" as const,
        id: "service_tier",
        label: "Speed",
        value: "default",
        options: [
          { id: "default", label: "Normal" },
          { id: "priority", label: "Fast" },
        ],
      },
      { type: "toggle" as const, id: "plan_mode", label: "Plan", value: false },
    ],
  };

  it("sets each feature with its typed value", async () => {
    const client = new RecordingFeatureClient();

    await updateAgentFeatures(client, agent, { service_tier: "priority", plan_mode: "true" });

    expect(client.updates).toEqual([
      { agentId: "agent-1", featureId: "service_tier", value: "priority" },
      { agentId: "agent-1", featureId: "plan_mode", value: true },
    ]);
  });

  it("sets nothing when any requested value is invalid", async () => {
    const client = new RecordingFeatureClient();

    await expect(
      updateAgentFeatures(client, agent, { service_tier: "priority", plan_mode: "maybe" }),
    ).rejects.toMatchObject({ code: "INVALID_FEATURE" });
    expect(client.updates).toEqual([]);
  });

  it("names the features already applied when the provider rejects a later one", async () => {
    const client = new RecordingFeatureClient("plan_mode");

    await expect(
      updateAgentFeatures(client, agent, { service_tier: "priority", plan_mode: "true" }),
    ).rejects.toMatchObject({
      code: "FEATURE_UPDATE_FAILED",
      message: "Failed to set feature plan_mode: provider rejected the value",
      details: "Already applied: service_tier=priority",
    });
    expect(client.updates).toEqual([
      { agentId: "agent-1", featureId: "service_tier", value: "priority" },
    ]);
  });
});

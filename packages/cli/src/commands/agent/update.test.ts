import { describe, expect, it } from "vitest";
import type { AgentProviderNotice } from "@getpaseo/protocol/agent-types";
import type { AgentResourcePolicy } from "@getpaseo/protocol/agent-resources";
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
  storedResources: AgentResourcePolicy | null = null;
  readonly resourceUpdates: Array<{ agentId: string; resources: AgentResourcePolicy | null }> = [];

  constructor(
    private readonly supportsThinkingUpdate = true,
    private readonly supportsResources = true,
  ) {}

  getLastServerInfoMessage() {
    return {
      features: {
        agentThinkingUpdate: this.supportsThinkingUpdate,
        agentResources: this.supportsResources,
      },
    };
  }

  async getAgentResources() {
    return { resources: this.storedResources };
  }

  async setAgentResources(agentId: string, resources: AgentResourcePolicy | null) {
    this.resourceUpdates.push({ agentId, resources });
    this.storedResources = resources;
    return {
      resources,
      status: resources
        ? {
            backend: "systemd" as const,
            active: true,
            unit: "paseo.slice",
            cgroup: "/sys/fs/cgroup/paseo.slice",
            controls: Object.fromEntries(
              Object.entries(resources).map(([control, actual]) => [
                control,
                { state: "applied" as const, actual },
              ]),
            ),
          }
        : null,
    };
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
      resources: "-",
      noticeType: null,
      notice: null,
    });
  });
});

describe("resource changes", () => {
  it("changes only the controls given, keeping the rest of the stored policy", async () => {
    const client = new RecordingAgentUpdateClient();
    client.storedResources = { nice: 5, memoryMaxMb: 4096, cpuQuotaPercent: 200 };

    const result = await applyAgentChanges(client, "agent-1", {
      type: "resources",
      patch: { nice: 19, cpuQuotaPercent: null },
    });

    expect(client.resourceUpdates).toEqual([
      { agentId: "agent-1", resources: { nice: 19, memoryMaxMb: 4096 } },
    ]);
    expect(
      toAgentUpdateResult(
        { id: "agent-1", title: null, labels: {}, effectiveThinkingOptionId: null },
        result,
      ).resources,
    ).toBe("nice=19 (applied); memory-max=4096 MiB (applied)");
  });

  it("clears the policy when the last control is removed", async () => {
    const client = new RecordingAgentUpdateClient();
    client.storedResources = { nice: 5 };

    await applyAgentChanges(client, "agent-1", { type: "resources", patch: { nice: null } });

    expect(client.resourceUpdates).toEqual([{ agentId: "agent-1", resources: null }]);
  });

  it("requires a daemon that advertises resource controls", async () => {
    const client = new RecordingAgentUpdateClient(true, false);

    await expect(
      applyAgentChanges(client, "agent-1", { type: "resources", patch: { nice: 10 } }),
    ).rejects.toMatchObject({ code: "DAEMON_UPDATE_REQUIRED" });
    expect(client.resourceUpdates).toEqual([]);
  });

  it("refuses a patch that leaves the throttling threshold above the hard limit", async () => {
    const client = new RecordingAgentUpdateClient();
    client.storedResources = { memoryHighMb: 4096 };

    await expect(
      applyAgentChanges(client, "agent-1", { type: "resources", patch: { memoryMaxMb: 1024 } }),
    ).rejects.toMatchObject({
      code: "INVALID_RESOURCE_POLICY",
      message: "--memory-high must not exceed --memory-max",
    });
    expect(client.resourceUpdates).toEqual([]);
  });
});

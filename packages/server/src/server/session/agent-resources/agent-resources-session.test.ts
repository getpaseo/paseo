import { describe, expect, test } from "vitest";
import pino from "pino";
import type { AgentResourcePolicy } from "@getpaseo/protocol/agent-resources";
import type { SessionOutboundMessage } from "../../messages.js";
import type { AgentResourcesDescription } from "../../agent/agent-manager.js";
import { AgentResourcesSession, type AgentResourcesOperations } from "./agent-resources-session.js";

const CAPABILITIES = {
  backend: "nice" as const,
  controls: {
    nice: { supported: true },
    cpuWeight: { supported: false, reason: "Needs systemd" },
    cpuQuotaPercent: { supported: false, reason: "Needs systemd" },
    memoryHighMb: { supported: false, reason: "Needs systemd" },
    memoryMaxMb: { supported: false, reason: "Needs systemd" },
    allowedCpus: { supported: false, reason: "Needs systemd" },
  },
};

class FakeAgentResourcesOperations implements AgentResourcesOperations {
  readonly policies = new Map<string, AgentResourcePolicy | null>();
  refuseWith: Error | null = null;

  async capabilities() {
    return CAPABILITIES;
  }

  async describe(agentId: string): Promise<AgentResourcesDescription> {
    if (!this.policies.has(agentId)) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    return { resources: this.policies.get(agentId) ?? null, status: null };
  }

  async set(agentId: string, resources: AgentResourcePolicy | null): Promise<void> {
    if (this.refuseWith) throw this.refuseWith;
    this.policies.set(agentId, resources);
  }
}

function makeSubsystem() {
  const emitted: SessionOutboundMessage[] = [];
  const operations = new FakeAgentResourcesOperations();
  const session = new AgentResourcesSession({
    host: { emit: (msg) => emitted.push(msg) },
    operations,
    logger: pino({ level: "silent" }),
  });
  return { emitted, operations, session };
}

describe("AgentResourcesSession", () => {
  test("answers a host-level read with capabilities and no agent", async () => {
    const { emitted, session } = makeSubsystem();

    await session.handleGetRequest({ type: "agent.resources.get.request", requestId: "r1" });

    expect(emitted).toEqual([
      {
        type: "agent.resources.get.response",
        payload: {
          requestId: "r1",
          agentId: null,
          capabilities: CAPABILITIES,
          resources: null,
          status: null,
          error: null,
        },
      },
    ]);
  });

  test("reports an unknown agent as an error, not as an agent without a policy", async () => {
    const { emitted, session } = makeSubsystem();

    await session.handleGetRequest({
      type: "agent.resources.get.request",
      requestId: "r1",
      agentId: "missing",
    });

    expect(emitted[0]?.payload).toMatchObject({
      capabilities: null,
      resources: null,
      error: "Agent not found: missing",
    });
  });

  test("replaces the policy and answers with what is now stored", async () => {
    const { emitted, operations, session } = makeSubsystem();
    operations.policies.set("agent-1", { nice: 5 });

    await session.handleSetRequest({
      type: "agent.resources.set.request",
      requestId: "r2",
      agentId: "agent-1",
      resources: { nice: 10 },
    });

    expect(emitted).toEqual([
      {
        type: "agent.resources.set.response",
        payload: {
          requestId: "r2",
          agentId: "agent-1",
          accepted: true,
          error: null,
          resources: { nice: 10 },
          status: null,
        },
      },
    ]);
  });

  test("tells the client why a policy was refused and leaves the stored one alone", async () => {
    const { emitted, operations, session } = makeSubsystem();
    operations.policies.set("agent-1", { nice: 5 });
    operations.refuseWith = new Error(
      "Cannot enforce the resource policy. cpuWeight: Needs systemd",
    );

    await session.handleSetRequest({
      type: "agent.resources.set.request",
      requestId: "r3",
      agentId: "agent-1",
      resources: { cpuWeight: 10 },
    });

    expect(emitted[0]?.payload).toEqual({
      requestId: "r3",
      agentId: "agent-1",
      accepted: false,
      error: "Cannot enforce the resource policy. cpuWeight: Needs systemd",
      resources: null,
      status: null,
    });
    expect(operations.policies.get("agent-1")).toEqual({ nice: 5 });
  });
});

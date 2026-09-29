import { describe, expect, it } from "vitest";
import type { AgentDeepLinkTarget } from "@getpaseo/protocol/agent-deep-link";
import type { ConnectOptions } from "../../utils/client.js";
import { openAgent, type OpenAgentClient, type OpenCommandDeps } from "./open.js";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };
const agentId = "11111111-1111-4111-8111-111111111111";

class FakeOpenAgentClient implements OpenAgentClient {
  readonly fetchedAgentIds: string[] = [];
  closed = false;

  constructor(private readonly lookup: (id: string) => Promise<{ agent: { id: string } } | null>) {}

  async fetchAgent(options: { agentId: string }) {
    this.fetchedAgentIds.push(options.agentId);
    return this.lookup(options.agentId);
  }

  getLastServerInfoMessage() {
    return { serverId: "srv_test" };
  }

  async close() {
    this.closed = true;
  }
}

class FakeOpenDeps implements OpenCommandDeps {
  readonly connectCalls: ConnectOptions[] = [];
  readonly opened: AgentDeepLinkTarget[] = [];

  constructor(private readonly connect: () => Promise<OpenAgentClient>) {}

  connectToDaemon = async (options: ConnectOptions) => {
    this.connectCalls.push(options);
    return this.connect();
  };

  openDesktopWithAgent = async (target: AgentDeepLinkTarget) => {
    this.opened.push(target);
  };
}

function depsWithClient(client: OpenAgentClient) {
  return new FakeOpenDeps(async () => client);
}

describe("openAgent", () => {
  it("opens Desktop with the resolved agent id for an agent that exists", async () => {
    const client = new FakeOpenAgentClient(async () => ({ agent: { id: agentId } }));
    const deps = depsWithClient(client);

    const result = await openAgent(" 1111 ", { daemonTarget }, deps);

    expect(client.fetchedAgentIds).toEqual(["1111"]);
    expect(deps.opened).toEqual([{ serverId: "srv_test", agentId }]);
    expect(result.data).toEqual({ agentId, serverId: "srv_test", status: "opened" });
    expect(client.closed).toBe(true);
  });

  it("fails with AGENT_NOT_FOUND when the daemon reports the agent as not found", async () => {
    const client = new FakeOpenAgentClient(async (id) => {
      throw new Error(`Agent not found: ${id}`);
    });
    const deps = depsWithClient(client);

    await expect(openAgent("does-not-exist", { daemonTarget }, deps)).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
      message: "Agent not found: does-not-exist",
      details: 'Use "paseo ls" to list available agents',
    });

    expect(deps.opened).toEqual([]);
    expect(client.closed).toBe(true);
  });

  it("fails with AGENT_NOT_FOUND when the lookup returns no agent", async () => {
    const client = new FakeOpenAgentClient(async () => null);
    const deps = depsWithClient(client);

    await expect(openAgent("does-not-exist", { daemonTarget }, deps)).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });

    expect(deps.opened).toEqual([]);
  });

  it("lets other lookup errors propagate with their own message", async () => {
    const client = new FakeOpenAgentClient(async () => {
      throw new Error('Agent identifier "1111" is ambiguous (11111111, 11112222)');
    });
    const deps = depsWithClient(client);

    const failure = await openAgent("1111", { daemonTarget }, deps).catch((err: unknown) => err);

    expect(failure).toEqual(new Error('Agent identifier "1111" is ambiguous (11111111, 11112222)'));
    expect(failure).not.toHaveProperty("code", "AGENT_NOT_FOUND");
    expect(deps.opened).toEqual([]);
    expect(client.closed).toBe(true);
  });

  it("looks the agent up when --server names the connected daemon", async () => {
    const client = new FakeOpenAgentClient(async () => null);
    const deps = depsWithClient(client);

    await expect(
      openAgent(agentId, { daemonTarget, server: "srv_test" }, deps),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });

    expect(deps.opened).toEqual([]);
  });

  it("skips the lookup when --server names another server", async () => {
    const client = new FakeOpenAgentClient(async () => null);
    const deps = depsWithClient(client);

    const result = await openAgent(agentId, { daemonTarget, server: "srv_other" }, deps);

    expect(client.fetchedAgentIds).toEqual([]);
    expect(deps.opened).toEqual([{ serverId: "srv_other", agentId }]);
    expect(result.data).toEqual({ agentId, serverId: "srv_other", status: "opened" });
  });

  it("opens the given --server without a reachable local daemon", async () => {
    const deps = new FakeOpenDeps(async () => {
      throw new Error("connection refused");
    });

    const result = await openAgent(agentId, { daemonTarget, server: "srv_other" }, deps);

    expect(deps.opened).toEqual([{ serverId: "srv_other", agentId }]);
    expect(result.data.serverId).toBe("srv_other");
  });

  it("still requires a reachable daemon when --server is absent", async () => {
    const deps = new FakeOpenDeps(async () => {
      throw new Error("connection refused");
    });

    await expect(openAgent(agentId, { daemonTarget }, deps)).rejects.toThrow("connection refused");

    expect(deps.opened).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { archiveAgent, type AgentArchiveClient } from "./archive.js";
import { reloadAgent, type AgentReloadClient } from "./reload.js";
import { detachAgent, type AgentDetachClient } from "./detach.js";

function makeAgent(
  id: string,
  overrides: Partial<AgentSnapshotPayload> = {},
): AgentSnapshotPayload {
  return {
    id,
    title: null,
    status: "closed",
    archivedAt: null,
    ...overrides,
  } as AgentSnapshotPayload;
}

class FakeAgentClient implements AgentArchiveClient, AgentReloadClient, AgentDetachClient {
  readonly archived: string[] = [];
  readonly refreshed: string[] = [];
  readonly detached: string[] = [];
  readonly fetchAgentCalls: string[] = [];
  fetchAgentError: Error | null = null;
  closed = false;

  constructor(
    private readonly listed: AgentSnapshotPayload[],
    private readonly stored: AgentSnapshotPayload[] = listed,
  ) {}

  async fetchAgents() {
    return { entries: this.listed.map((agent) => ({ agent })), pageInfo: { nextCursor: null } };
  }

  async fetchAgent({ agentId }: { agentId: string }) {
    this.fetchAgentCalls.push(agentId);
    if (this.fetchAgentError) throw this.fetchAgentError;
    const found =
      this.stored.find((e) => e.id === agentId) ??
      this.stored.find((e) => e.id.startsWith(agentId)) ??
      this.stored.find((e) => e.title === agentId);
    return found ? { agent: found } : null;
  }

  async archiveAgent(agentId: string) {
    this.archived.push(agentId);
    return { archivedAt: "2026-11-15T00:00:00.000Z" };
  }

  async refreshAgent(agentId: string) {
    this.refreshed.push(agentId);
    return { agentId, timelineSize: 3 };
  }

  async detachAgent(agentId: string) {
    this.detached.push(agentId);
  }

  async close() {
    this.closed = true;
  }
}

describe("unlisted agent resolution", () => {
  const unlistedId = "9eac296c-4d60-4189-a0b5-ae71dd9c6ad9";
  const otherId = "c9a97e5d-4a92-4646-a016-53032146d0a1";

  it("archives an unlisted agent via fetchAgent without title collision", async () => {
    const unlisted = makeAgent(unlistedId, { title: "orphaned agent" });
    const other = makeAgent(otherId, { title: `worker ${unlistedId}` });
    const client = new FakeAgentClient([other], [other, unlisted]);
    const result = await archiveAgent(unlistedId.toUpperCase(), {}, async () => client);
    expect(result.data).toEqual({
      agentId: unlistedId,
      status: "archived",
      archivedAt: "2026-11-15T00:00:00.000Z",
    });
    expect(client.fetchAgentCalls).toEqual([unlistedId]);
    expect(client.archived).toEqual([unlistedId]);
    expect(client.closed).toBe(true);
  });

  it("enforces archived and running checks on fetched unlisted agents", async () => {
    const archivedClient = new FakeAgentClient(
      [],
      [makeAgent(unlistedId, { archivedAt: "2026-11-14T10:00:00.000Z" })],
    );
    await expect(archiveAgent(unlistedId, {}, async () => archivedClient)).rejects.toMatchObject({
      code: "AGENT_ALREADY_ARCHIVED",
    });
    const runningClient = new FakeAgentClient([], [makeAgent(unlistedId, { status: "running" })]);
    await expect(archiveAgent(unlistedId, {}, async () => runningClient)).rejects.toMatchObject({
      code: "AGENT_RUNNING",
    });
  });

  it("reloads and detaches unlisted agents via fetchAgent fallback", async () => {
    const unlisted = makeAgent(unlistedId, { title: "orphaned agent" });
    const reloadClient = new FakeAgentClient([], [unlisted]);
    const detachClient = new FakeAgentClient([], [unlisted]);
    expect((await reloadAgent(unlistedId, {}, async () => reloadClient)).data).toEqual({
      agentId: unlistedId,
      status: "reloaded",
      timelineSize: 3,
    });
    expect((await detachAgent(unlistedId, {}, async () => detachClient)).data).toEqual({
      agentId: unlistedId,
      status: "detached",
    });
  });

  it("does not accept another agent the daemon matched by title for a missing full id", async () => {
    const titled = makeAgent(otherId, { title: unlistedId });
    const client = new FakeAgentClient([], [titled]);
    await expect(archiveAgent(unlistedId, {}, async () => client)).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
    expect(client.archived).toEqual([]);
  });

  it("throws AGENT_NOT_FOUND when missing and propagates lookup errors", async () => {
    await expect(
      archiveAgent(unlistedId, {}, async () => new FakeAgentClient([], [])),
    ).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
    const failingClient = new FakeAgentClient([], []);
    failingClient.fetchAgentError = new Error('Agent identifier "9eac" is ambiguous');
    await expect(archiveAgent("9eac", {}, async () => failingClient)).rejects.toMatchObject({
      code: "ARCHIVE_FAILED",
    });
    await expect(detachAgent("9eac", {}, async () => failingClient)).rejects.toMatchObject({
      code: "DETACH_FAILED",
      message: 'Failed to detach agent: Agent identifier "9eac" is ambiguous',
    });
  });
});

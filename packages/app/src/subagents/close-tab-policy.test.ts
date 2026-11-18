import { afterEach, describe, expect, it } from "vitest";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import { loadCloseAgentTabPolicy, resolveCloseAgentTabPolicy } from "./close-tab-policy";
import { providerSubagentKey, useProviderSubagentStore } from "./provider-store";

const SERVER_ID = "server-1";
const AGENT_ID = "agent-1";

function rootAgent(overrides: Partial<Parameters<typeof resolveCloseAgentTabPolicy>[0]> = {}) {
  return {
    serverId: SERVER_ID,
    id: AGENT_ID,
    parentAgentId: null,
    status: "idle" as const,
    backgroundWork: { count: 0 },
    ...overrides,
  };
}

function descriptor(
  parentAgentId: string,
  id: string,
  status: ProviderSubagentDescriptorPayload["status"],
): ProviderSubagentDescriptorPayload {
  return {
    id,
    parentAgentId,
    provider: "claude",
    title: null,
    description: "Run tool calls then wait",
    status,
    createdAt: "2026-11-18T00:00:00.000Z",
    updatedAt: "2026-11-18T00:00:00.000Z",
    toolCallId: "call-1",
  };
}

function fakeDaemon(lists: Record<string, ProviderSubagentDescriptorPayload[]>) {
  return {
    listProviderSubagents: async (parentAgentId: string) => ({
      requestId: "request-1",
      parentAgentId,
      subagents: lists[parentAgentId] ?? [],
      error: null,
    }),
  };
}

afterEach(() => {
  useProviderSubagentStore.setState({
    descriptors: new Map(),
    timelines: new Map(),
    hiddenFromTrack: new Set(),
    trackedParents: new Set(),
  });
});

function providerSubagents(
  entries: Array<{
    parentAgentId: string;
    id: string;
    status: ProviderSubagentDescriptorPayload["status"];
  }>,
): Map<string, ProviderSubagentDescriptorPayload> {
  return new Map(
    entries.map((entry) => [
      providerSubagentKey(SERVER_ID, entry.parentAgentId, entry.id),
      {
        id: entry.id,
        parentAgentId: entry.parentAgentId,
        provider: "claude",
        title: null,
        description: "Run tool calls then wait",
        status: entry.status,
        createdAt: "2026-11-18T00:00:00.000Z",
        updatedAt: "2026-11-18T00:00:00.000Z",
        toolCallId: "call-1",
      },
    ]),
  );
}

describe("resolveCloseAgentTabPolicy", () => {
  it("archives an idle root agent without asking", () => {
    expect(resolveCloseAgentTabPolicy(rootAgent(), new Map())).toEqual({
      kind: "archive-on-close",
      confirmArchive: false,
    });
  });

  it("asks before archiving a running root agent", () => {
    expect(resolveCloseAgentTabPolicy(rootAgent({ status: "running" }), new Map())).toEqual({
      kind: "archive-on-close",
      confirmArchive: true,
    });
  });

  it("asks before archiving a root agent whose turn ended while background work still runs", () => {
    expect(
      resolveCloseAgentTabPolicy(rootAgent({ backgroundWork: { count: 1 } }), new Map()),
    ).toEqual({ kind: "archive-on-close", confirmArchive: true });
  });

  it("asks before archiving a root agent whose turn ended while its background subagent still runs", () => {
    expect(
      resolveCloseAgentTabPolicy(
        rootAgent(),
        providerSubagents([{ parentAgentId: AGENT_ID, id: "sub-1", status: "running" }]),
      ),
    ).toEqual({ kind: "archive-on-close", confirmArchive: true });
  });

  it("does not ask for finished subagents or another agent's running subagents", () => {
    expect(
      resolveCloseAgentTabPolicy(
        rootAgent(),
        providerSubagents([
          { parentAgentId: AGENT_ID, id: "sub-1", status: "completed" },
          { parentAgentId: "other-agent", id: "sub-2", status: "running" },
        ]),
      ),
    ).toEqual({ kind: "archive-on-close", confirmArchive: false });
  });

  it("keeps subagent tab close layout-only", () => {
    expect(
      resolveCloseAgentTabPolicy(
        rootAgent({ parentAgentId: "parent-agent", status: "running" }),
        new Map(),
      ),
    ).toEqual({ kind: "layout-only" });
  });

  it("preserves the existing archive fallback when the agent is missing", () => {
    expect(resolveCloseAgentTabPolicy(null, new Map())).toEqual({
      kind: "archive-on-close",
      confirmArchive: false,
    });
  });
});

describe("loadCloseAgentTabPolicy", () => {
  it("asks for a background subagent this client has not loaded yet, such as a tab restored after a reload", async () => {
    const daemon = fakeDaemon({ [AGENT_ID]: [descriptor(AGENT_ID, "sub-1", "running")] });

    await expect(
      loadCloseAgentTabPolicy({ agent: rootAgent(), providerSubagents: daemon }),
    ).resolves.toEqual({ kind: "archive-on-close", confirmArchive: true });
  });

  it("falls back to the subagents already loaded when the daemon cannot list them", async () => {
    useProviderSubagentStore
      .getState()
      .applyUpdate(SERVER_ID, {
        kind: "upsert",
        subagent: descriptor(AGENT_ID, "sub-1", "running"),
      });
    const disconnected = {
      listProviderSubagents: async () => {
        throw new Error("Transport not connected");
      },
    };

    await expect(
      loadCloseAgentTabPolicy({ agent: rootAgent(), providerSubagents: disconnected }),
    ).resolves.toEqual({ kind: "archive-on-close", confirmArchive: true });
  });

  it("archives without asking when the daemon lists no running subagent", async () => {
    const daemon = fakeDaemon({ [AGENT_ID]: [descriptor(AGENT_ID, "sub-1", "completed")] });

    await expect(
      loadCloseAgentTabPolicy({ agent: rootAgent(), providerSubagents: daemon }),
    ).resolves.toEqual({ kind: "archive-on-close", confirmArchive: false });
  });
});

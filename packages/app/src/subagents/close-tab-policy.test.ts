import { describe, expect, it } from "vitest";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import { resolveCloseAgentTabPolicy } from "./close-tab-policy";
import { providerSubagentKey } from "./provider-store";

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

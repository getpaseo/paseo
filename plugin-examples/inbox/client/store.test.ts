import { describe, expect, it } from "vitest";
import { createInboxStore } from "./store";
import type { Agent, PaseoApi } from "./types";

function fakePaseo(agents: Agent[]) {
  const agentListeners = new Set<(update: unknown) => void>();
  const paseo = {
    agents: {
      subscribe(handler: (update: unknown) => void) {
        agentListeners.add(handler);
        return () => agentListeners.delete(handler);
      },
      list: async () => ({
        entries: agents.map((agent) => ({ agent, project: null })),
        pageInfo: { hasMore: false, nextCursor: null },
      }),
    },
    workspaces: {
      subscribe: () => () => {},
      list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
    },
  } as unknown as PaseoApi;
  return {
    paseo,
    emit: (update: unknown) => agentListeners.forEach((listener) => listener(update)),
  };
}

const waiting = {
  id: "a",
  provider: "claude",
  cwd: "/repo",
  workspaceId: "ws",
  status: "running",
  updatedAt: "2026-09-04T10:00:00.000Z",
  lastUserMessageAt: null,
  pendingPermissions: [{ id: "p", kind: "question", name: "AskUserQuestion", input: {} }],
  labels: {},
  archivedAt: null,
} as unknown as Agent;

describe("createInboxStore", () => {
  it("loads the directory, exposes lanes, and reports the badge count", async () => {
    const { paseo } = fakePaseo([waiting]);
    const store = createInboxStore(paseo);
    expect(store.getBadge()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getSnapshot().loaded).toBe(true);
    expect(store.getSnapshot().lanes.needsYou.map((card) => card.agent.id)).toEqual(["a"]);
    expect(store.getBadge()).toBe(1);
    store.dispose();
  });

  it("clears the badge when the agent is removed and carries a pending open request once", async () => {
    const { paseo, emit } = fakePaseo([waiting]);
    const store = createInboxStore(paseo);
    await new Promise((resolve) => setTimeout(resolve, 0));
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.requestOpen("a");
    expect(store.getSnapshot().pendingOpenAgentId).toBe("a");
    store.clearPendingOpen();
    expect(store.getSnapshot().pendingOpenAgentId).toBeNull();
    emit({ kind: "remove", agentId: "a" });
    expect(store.getBadge()).toBeNull();
    expect(notified).toBe(3);
    store.dispose();
  });
});

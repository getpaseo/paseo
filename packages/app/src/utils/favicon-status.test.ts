import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import { createFaviconStatusSelector, deriveFaviconStatus } from "./favicon-status";

function agent(input: Partial<Agent> & { id: string }): Agent {
  return {
    status: "idle",
    background: false,
    archivedAt: null,
    requiresAttention: false,
    pendingPermissions: [],
    ...input,
  } as Agent;
}

function stateWith(...agents: Agent[]) {
  return { sessions: { srv: { agents: new Map(agents.map((entry) => [entry.id, entry])) } } };
}

describe("deriveFaviconStatus", () => {
  it("is running when any visible agent runs", () => {
    expect(
      deriveFaviconStatus(
        stateWith(
          agent({ id: "a", requiresAttention: true }),
          agent({ id: "b", status: "running" }),
        ),
      ),
    ).toBe("running");
  });

  it("needs attention for attention or pending permissions", () => {
    expect(deriveFaviconStatus(stateWith(agent({ id: "a", requiresAttention: true })))).toBe(
      "attention",
    );
    expect(
      deriveFaviconStatus(
        stateWith(agent({ id: "a", pendingPermissions: [{}] as Agent["pendingPermissions"] })),
      ),
    ).toBe("attention");
  });

  it("ignores background and archived agents", () => {
    expect(
      deriveFaviconStatus(
        stateWith(
          agent({ id: "a", status: "running", background: true }),
          agent({ id: "b", requiresAttention: true, archivedAt: new Date() }),
        ),
      ),
    ).toBe("none");
  });
});

describe("createFaviconStatusSelector", () => {
  it("reuses its result while the agent maps are unchanged", () => {
    const select = createFaviconStatusSelector();
    const state = stateWith(agent({ id: "a", status: "running" }));
    expect(select(state)).toBe("running");

    // Same agent map, mutated behind the store's back: the selector must not rescan.
    state.sessions.srv.agents.set("a", agent({ id: "a" }));
    expect(select({ sessions: { ...state.sessions } })).toBe("running");
  });

  it("rescans when an agent map is replaced", () => {
    const select = createFaviconStatusSelector();
    expect(select(stateWith(agent({ id: "a", status: "running" })))).toBe("running");
    expect(select(stateWith(agent({ id: "a" })))).toBe("none");
  });
});

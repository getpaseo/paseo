import { describe, expect, it } from "vitest";
import {
  computeShouldNotifyClient,
  computeShouldSendPush,
  type ClientAttentionState,
} from "./agent-attention-policy.js";

function state(overrides: Partial<ClientAttentionState>): ClientAttentionState {
  return {
    deviceType: null,
    focusedAgentId: null,
    isStale: false,
    appVisible: false,
    ...overrides,
  };
}

describe("computeShouldNotifyClient", () => {
  it("suppresses notifications when someone is actively focused on the agent", () => {
    const activeOnAgent = state({
      deviceType: "web",
      focusedAgentId: "agent-1",
      isStale: false,
      appVisible: true,
    });
    const staleMobile = state({
      deviceType: "mobile",
      focusedAgentId: null,
      isStale: true,
      appVisible: false,
    });

    expect(
      computeShouldNotifyClient({
        clientState: staleMobile,
        allClientStates: [activeOnAgent, staleMobile],
        agentId: "agent-1",
      })
    ).toBe(false);
  });

  it("notifies unidentified clients by default when agent is not actively focused", () => {
    const unknownClient = state({
      deviceType: null,
      focusedAgentId: null,
      isStale: false,
      appVisible: false,
    });

    expect(
      computeShouldNotifyClient({
        clientState: unknownClient,
        allClientStates: [unknownClient],
        agentId: "agent-2",
      })
    ).toBe(true);
  });

  it("notifies active visible clients when they are focused on an agent", () => {
    const focusedWeb = state({
      deviceType: "web",
      focusedAgentId: "agent-2",
      isStale: false,
      appVisible: true,
    });

    expect(
      computeShouldNotifyClient({
        clientState: focusedWeb,
        allClientStates: [focusedWeb],
        agentId: "agent-3",
      })
    ).toBe(true);
  });

  it("suppresses active clients that are not focused on an agent", () => {
    const activeButNotFocused = state({
      deviceType: "web",
      focusedAgentId: null,
      isStale: false,
      appVisible: true,
    });

    expect(
      computeShouldNotifyClient({
        clientState: activeButNotFocused,
        allClientStates: [activeButNotFocused],
        agentId: "agent-4",
      })
    ).toBe(false);
  });

  it("suppresses stale mobile notifications when an active web client exists", () => {
    const staleMobile = state({
      deviceType: "mobile",
      focusedAgentId: null,
      isStale: true,
      appVisible: false,
    });
    const activeWeb = state({
      deviceType: "web",
      focusedAgentId: null,
      isStale: false,
      appVisible: true,
    });

    expect(
      computeShouldNotifyClient({
        clientState: staleMobile,
        allClientStates: [staleMobile, activeWeb],
        agentId: "agent-5",
      })
    ).toBe(false);
  });

  it("allows stale mobile notifications when no active web client exists", () => {
    const staleMobile = state({
      deviceType: "mobile",
      focusedAgentId: null,
      isStale: true,
      appVisible: false,
    });
    const staleWeb = state({
      deviceType: "web",
      focusedAgentId: null,
      isStale: true,
      appVisible: false,
    });

    expect(
      computeShouldNotifyClient({
        clientState: staleMobile,
        allClientStates: [staleMobile, staleWeb],
        agentId: "agent-6",
      })
    ).toBe(true);
  });

  it("suppresses stale web notifications when a mobile client is also present", () => {
    const staleWeb = state({
      deviceType: "web",
      focusedAgentId: null,
      isStale: true,
      appVisible: false,
    });
    const staleMobile = state({
      deviceType: "mobile",
      focusedAgentId: null,
      isStale: true,
      appVisible: false,
    });

    expect(
      computeShouldNotifyClient({
        clientState: staleWeb,
        allClientStates: [staleWeb, staleMobile],
        agentId: "agent-7",
      })
    ).toBe(false);
  });

  it("allows stale web notifications when there are no mobile or unidentified clients", () => {
    const staleWeb = state({
      deviceType: "web",
      focusedAgentId: null,
      isStale: true,
      appVisible: false,
    });

    expect(
      computeShouldNotifyClient({
        clientState: staleWeb,
        allClientStates: [staleWeb],
        agentId: "agent-8",
      })
    ).toBe(true);
  });
});

describe("computeShouldSendPush", () => {
  it("never sends push for error attention events", () => {
    expect(
      computeShouldSendPush({
        reason: "error",
        allClientStates: [],
      })
    ).toBe(false);
  });

  it("suppresses push when any active web client exists", () => {
    expect(
      computeShouldSendPush({
        reason: "finished",
        allClientStates: [
          state({
            deviceType: "web",
            isStale: false,
            appVisible: true,
          }),
        ],
      })
    ).toBe(false);
  });

  it("suppresses push when a mobile app is actively visible", () => {
    expect(
      computeShouldSendPush({
        reason: "permission",
        allClientStates: [
          state({
            deviceType: "mobile",
            isStale: false,
            appVisible: true,
          }),
        ],
      })
    ).toBe(false);
  });

  it("sends push when no active web client or foreground mobile client exists", () => {
    expect(
      computeShouldSendPush({
        reason: "finished",
        allClientStates: [
          state({
            deviceType: "mobile",
            isStale: true,
            appVisible: false,
          }),
          state({
            deviceType: "web",
            isStale: true,
            appVisible: false,
          }),
        ],
      })
    ).toBe(true);
  });
});

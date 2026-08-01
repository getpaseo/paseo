import { describe, expect, it, vi } from "vitest";
import type { VoiceLiveAgentUpdate } from "@getpaseo/protocol/live-voice-routing";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentManager, AgentSubscriber, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { LiveVoiceAgentNotifier } from "./live-voice-agent-notifier.js";

type Lifecycle = "idle" | "running" | "error" | "closed";

function createFakeAgents(initialLifecycle: Lifecycle = "running") {
  const subscribers = new Set<AgentSubscriber>();
  let lifecycle: Lifecycle = initialLifecycle;
  let lastAssistantMessage: string | null = "Rebased and pushed.";
  let authenticationRequired = false;
  const agentManager = {
    subscribe(callback: AgentSubscriber) {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },
    getAgent: () =>
      ({
        id: "agent-1",
        lifecycle,
        ...(authenticationRequired
          ? {
              lastFailure: {
                kind: "authentication_required",
                message: "Sign in required",
              },
            }
          : {}),
      }) as unknown as ManagedAgent,
    getLastAssistantMessage: async () => lastAssistantMessage,
  } satisfies Pick<AgentManager, "subscribe" | "getAgent" | "getLastAssistantMessage">;
  return {
    agentManager,
    setLastAssistantMessage(message: string | null) {
      lastAssistantMessage = message;
    },
    setAuthenticationRequired() {
      authenticationRequired = true;
    },
    transition(next: Lifecycle) {
      lifecycle = next;
      for (const subscriber of Array.from(subscribers)) {
        subscriber({
          type: "agent_state",
          agent: { id: "agent-1", lifecycle: next },
        } as never);
      }
    },
    requestPermission() {
      for (const subscriber of Array.from(subscribers)) {
        subscriber({
          type: "agent_event",
          agentId: "agent-1",
          event: {
            type: "permission_requested",
            request: { id: "permission-1" },
            turnId: "turn-1",
          },
        } as never);
      }
    },
    /**
     * The envelope the agent manager really dispatches. The routed watch above
     * only ever reads `event.event`, so it does not notice the difference; the
     * ambient watch has to read `agentId` off the envelope and does.
     */
    requestAmbientPermission() {
      for (const subscriber of Array.from(subscribers)) {
        subscriber({
          type: "agent_stream",
          agentId: "agent-1",
          event: {
            type: "permission_requested",
            request: { id: "permission-1" },
            turnId: "turn-1",
          },
        } as never);
      }
    },
    subscriberCount: () => subscribers.size,
  };
}

function createNotifier(
  agents: ReturnType<typeof createFakeAgents>,
  title: string | null = "Rebase main",
) {
  return new LiveVoiceAgentNotifier({
    agentManager: agents.agentManager,
    agentStorage: {
      get: async () => (title === null ? undefined : ({ title } as never)),
    } as unknown as Pick<AgentStorage, "get">,
    logger: createTestLogger(),
  });
}

function watch(
  notifier: LiveVoiceAgentNotifier,
  sourceKey: object,
  updates: VoiceLiveAgentUpdate[],
): void {
  notifier.watch({
    agentId: "agent-1",
    requestId: "execute-1",
    sourceKey,
    emit: (update) => updates.push(update),
  });
}

describe("LiveVoiceAgentNotifier", () => {
  it("reports a finished agent to the socket that started it", async () => {
    const agents = createFakeAgents();
    const notifier = createNotifier(agents);
    const updates: VoiceLiveAgentUpdate[] = [];
    watch(notifier, {}, updates);

    agents.transition("idle");
    await vi.waitFor(() => {
      expect(updates).toHaveLength(1);
    });

    expect(updates[0]).toEqual({
      type: "voice.live.agent.update",
      payload: {
        requestId: "execute-1",
        notification: {
          agentId: "agent-1",
          title: "Rebase main",
          reason: "turn_completed",
          scope: "agent_turn",
          summary: "Rebased and pushed.",
        },
      },
    });
    // The report says nothing about any call: this daemon is never told which
    // call the work belongs to.
    expect(JSON.stringify(updates[0])).not.toContain("liveSession");
  });

  it("reports an errored agent under its own reason", async () => {
    const agents = createFakeAgents();
    const notifier = createNotifier(agents);
    const updates: VoiceLiveAgentUpdate[] = [];
    watch(notifier, {}, updates);

    agents.transition("error");
    await vi.waitFor(() => {
      expect(updates).toHaveLength(1);
    });
    expect(updates[0]?.payload.notification.reason).toBe("errored");
  });

  it("reports authentication failures distinctly and redacts secrets", async () => {
    const agents = createFakeAgents();
    agents.setAuthenticationRequired();
    agents.setLastAssistantMessage(
      'Authentication failed with Authorization: Bearer sentinel-secret and api_key="also-secret"',
    );
    const notifier = createNotifier(agents);
    const updates: VoiceLiveAgentUpdate[] = [];
    watch(notifier, {}, updates);

    agents.transition("error");
    await vi.waitFor(() => {
      expect(updates).toHaveLength(1);
    });
    expect(updates[0]?.payload.notification.reason).toBe("authentication_required");
    expect(updates[0]?.payload.notification.summary).not.toContain("sentinel-secret");
    expect(updates[0]?.payload.notification.summary).not.toContain("also-secret");
  });

  it("reports a blocked agent as soon as it asks for permission", async () => {
    const agents = createFakeAgents();
    const notifier = createNotifier(agents);
    const updates: VoiceLiveAgentUpdate[] = [];
    watch(notifier, {}, updates);

    agents.requestPermission();
    await vi.waitFor(() => {
      expect(updates).toHaveLength(1);
    });
    // Underscored on the wire: it is an identifier there, not prose.
    expect(updates[0]?.payload.notification.reason).toBe("needs_permission");
    expect(updates[0]?.payload.notification.turnId).toBe("turn-1");
    expect(notifier.getWatchCount()).toBe(1);

    agents.transition("idle");
    await vi.waitFor(() => {
      expect(updates).toHaveLength(2);
    });
    expect(updates[1]?.payload.notification.reason).toBe("turn_completed");
    expect(notifier.getWatchCount()).toBe(0);
  });

  it("does not retain a watcher when the agent is already errored", async () => {
    const agents = createFakeAgents("error");
    const notifier = createNotifier(agents);
    const updates: VoiceLiveAgentUpdate[] = [];
    watch(notifier, {}, updates);

    await vi.waitFor(() => {
      expect(updates).toHaveLength(1);
    });
    expect(notifier.getWatchCount()).toBe(0);
    expect(agents.subscriberCount()).toBe(0);
  });

  it("reports at most once per watched agent", async () => {
    const agents = createFakeAgents();
    const notifier = createNotifier(agents);
    const updates: VoiceLiveAgentUpdate[] = [];
    watch(notifier, {}, updates);

    agents.transition("idle");
    await vi.waitFor(() => {
      expect(updates).toHaveLength(1);
    });
    agents.transition("running");
    agents.transition("idle");
    await Promise.resolve();

    expect(updates).toHaveLength(1);
  });

  it("stops watching when the socket that asked goes away", async () => {
    const agents = createFakeAgents();
    const notifier = createNotifier(agents);
    const updates: VoiceLiveAgentUpdate[] = [];
    const sourceKey = {};
    watch(notifier, sourceKey, updates);
    expect(notifier.getWatchCount()).toBe(1);

    notifier.releaseForSource(sourceKey);
    expect(notifier.getWatchCount()).toBe(0);
    expect(agents.subscriberCount()).toBe(0);

    agents.transition("idle");
    await Promise.resolve();
    expect(updates).toEqual([]);
  });

  it("releases only the socket that went away", async () => {
    const agents = createFakeAgents();
    const notifier = createNotifier(agents);
    const updates: VoiceLiveAgentUpdate[] = [];
    const goneSocket = {};
    watch(notifier, goneSocket, updates);
    watch(notifier, {}, updates);

    notifier.releaseForSource(goneSocket);
    agents.transition("idle");
    await vi.waitFor(() => {
      expect(updates).toHaveLength(1);
    });
  });

  it("falls back to the agent id when the record has no title", async () => {
    const agents = createFakeAgents();
    agents.setLastAssistantMessage(null);
    const notifier = createNotifier(agents, null);
    const updates: VoiceLiveAgentUpdate[] = [];
    watch(notifier, {}, updates);

    agents.transition("idle");
    await vi.waitFor(() => {
      expect(updates).toHaveLength(1);
    });
    expect(updates[0]?.payload.notification).toMatchObject({
      title: "agent-1",
      summary: null,
    });
  });
});

describe("LiveVoiceAgentNotifier ambient watch", () => {
  it("reports an agent nobody asked it to watch, marked unsolicited", async () => {
    const agents = createFakeAgents();
    const notifier = createNotifier(agents);
    const updates: VoiceLiveAgentUpdate[] = [];
    notifier.watchAll({ sourceKey: {}, emit: (update) => updates.push(update) });

    agents.transition("running");
    agents.transition("idle");

    await vi.waitFor(() => {
      expect(updates).toHaveLength(1);
    });
    expect(updates[0]?.payload.notification).toMatchObject({
      agentId: "agent-1",
      reason: "turn_completed",
      unsolicited: true,
    });
  });

  it("keeps reporting across turns instead of firing once", async () => {
    const agents = createFakeAgents();
    const notifier = createNotifier(agents);
    const updates: VoiceLiveAgentUpdate[] = [];
    notifier.watchAll({ sourceKey: {}, emit: (update) => updates.push(update) });

    agents.transition("running");
    agents.transition("idle");
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    agents.transition("running");
    agents.transition("idle");

    await vi.waitFor(() => {
      expect(updates).toHaveLength(2);
    });
  });

  it("stays silent for an agent that was already idle", async () => {
    const agents = createFakeAgents("idle");
    const notifier = createNotifier(agents);
    const updates: VoiceLiveAgentUpdate[] = [];
    notifier.watchAll({ sourceKey: {}, emit: (update) => updates.push(update) });

    // An unrelated agent finishing re-broadcasts state for everything. Without
    // the seen-running gate every idle session would announce itself here.
    agents.transition("idle");

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(updates).toHaveLength(0);
  });

  it("reports a permission request so a blocked agent is not silent", async () => {
    const agents = createFakeAgents();
    const notifier = createNotifier(agents);
    const updates: VoiceLiveAgentUpdate[] = [];
    notifier.watchAll({ sourceKey: {}, emit: (update) => updates.push(update) });

    agents.requestAmbientPermission();
    agents.requestAmbientPermission();

    await vi.waitFor(() => {
      expect(updates).toHaveLength(1);
    });
    expect(updates[0]?.payload.notification).toMatchObject({
      reason: "needs_permission",
      unsolicited: true,
    });
  });

  it("stops when the socket that asked for it goes away", async () => {
    const agents = createFakeAgents();
    const notifier = createNotifier(agents);
    const updates: VoiceLiveAgentUpdate[] = [];
    const socket = {};
    notifier.watchAll({ sourceKey: socket, emit: (update) => updates.push(update) });
    expect(agents.subscriberCount()).toBe(1);

    notifier.releaseForSource(socket);
    expect(notifier.isWatchingAll(socket)).toBe(false);
    expect(agents.subscriberCount()).toBe(0);

    agents.transition("running");
    agents.transition("idle");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(updates).toHaveLength(0);
  });

  it("does not stack subscriptions when asked twice", () => {
    const agents = createFakeAgents();
    const notifier = createNotifier(agents);
    const socket = {};
    notifier.watchAll({ sourceKey: socket, emit: () => undefined });
    notifier.watchAll({ sourceKey: socket, emit: () => undefined });

    expect(agents.subscriberCount()).toBe(1);
  });
});

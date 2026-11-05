import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";
import { createSessionAgentStreamReducerQueue } from "./session-stream-reducers";

const appState = vi.hoisted(() => ({
  currentState: "active",
  listeners: new Set<(state: string) => void>(),
}));

vi.mock("react-native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native")>();
  return {
    ...actual,
    Platform: { ...actual.Platform, OS: "android" },
    AppState: {
      get currentState() {
        return appState.currentState;
      },
      addEventListener: (_event: string, listener: (state: string) => void) => {
        appState.listeners.add(listener);
        return { remove: () => appState.listeners.delete(listener) };
      },
    },
  };
});

const serverId = "android-background-stream-test";
const agentId = "agent-1";

function sendEvent(
  queue: ReturnType<typeof createSessionAgentStreamReducerQueue>,
  text: string,
  seq: number,
) {
  queue.enqueue(agentId, {
    event: {
      type: "timeline",
      provider: "claude",
      item: { type: "assistant_message", text },
    } as AgentStreamEventPayload,
    seq,
    epoch: "epoch-1",
    timestamp: new Date(1000 + seq),
  });
}

function setAppState(state: string) {
  appState.currentState = state;
  for (const listener of appState.listeners) listener(state);
}

function textInStore() {
  const head = useSessionStore.getState().sessions[serverId]?.agentStreamHead.get(agentId);
  return head?.[0]?.kind === "assistant_message" ? head[0].text : undefined;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", undefined);
  appState.currentState = "active";
  useSessionStore.getState().initializeSession(serverId, null);
});

afterEach(() => {
  useSessionStore.getState().clearSession(serverId);
  appState.listeners.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("commits queued and incoming messages in the background without advancing timers", () => {
  const store = useSessionStore.getState();
  const queue = createSessionAgentStreamReducerQueue({
    serverId,
    setAgentStreamState: store.setAgentStreamState,
    setAgentTimelineCursor: store.setAgentTimelineCursor,
    recoverTimelineGap: () => {},
  });

  sendEvent(queue, "Hello", 1);
  expect(textInStore()).toBeUndefined();
  setAppState("background");
  expect(textInStore()).toBe("Hello");
  sendEvent(queue, " world", 2);
  expect(textInStore()).toBe("Hello world");

  setAppState("active");
  sendEvent(queue, "!", 3);
  expect(textInStore()).toBe("Hello world");
  vi.advanceTimersByTime(48);
  expect(textInStore()).toBe("Hello world!");

  queue.dispose();
  expect(appState.listeners.size).toBe(0);
});

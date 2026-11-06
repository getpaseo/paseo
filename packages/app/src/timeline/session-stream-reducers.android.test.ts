import { afterEach, expect, it } from "vitest";
import type { AppStateStatus } from "react-native";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";
import {
  createSessionAgentStreamReducerQueue,
  type SessionAgentStreamRuntime,
} from "./session-stream-reducers";

const serverId = "android-background-stream-test";
const agentId = "agent-1";

function createRuntime(isAndroid: boolean) {
  let state: AppStateStatus = "active";
  let nextId = 1;
  const listeners = new Set<(state: AppStateStatus) => void>();
  const pending = new Map<number, () => void>();
  const runtime: SessionAgentStreamRuntime = {
    isAndroid,
    getAppState: () => state,
    subscribeAppState: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    scheduleFlush: (callback) => {
      const id = nextId++;
      pending.set(id, callback);
      return id;
    },
    cancelFlush: (id) => void pending.delete(id),
  };
  return {
    runtime,
    setAppState(next: AppStateStatus) {
      state = next;
      for (const listener of listeners) listener(next);
    },
    runScheduled() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
    pendingCount: () => pending.size,
    listenerCount: () => listeners.size,
  };
}

function createQueue(runtime: SessionAgentStreamRuntime) {
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null);
  return createSessionAgentStreamReducerQueue({
    serverId,
    setAgentStreamState: store.setAgentStreamState,
    setAgentTimelineCursor: store.setAgentTimelineCursor,
    recoverTimelineGap: () => {},
    runtime,
  });
}

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

function textInStore() {
  const head = useSessionStore.getState().sessions[serverId]?.agentStreamHead.get(agentId);
  return head?.[0]?.kind === "assistant_message" ? head[0].text : undefined;
}

afterEach(() => useSessionStore.getState().clearSession(serverId));

it("commits Android background events without waiting for paused callbacks", () => {
  const fake = createRuntime(true);
  const queue = createQueue(fake.runtime);

  sendEvent(queue, "Hello", 1);
  expect(textInStore()).toBeUndefined();
  expect(fake.pendingCount()).toBe(1);
  fake.setAppState("background");
  expect(textInStore()).toBe("Hello");
  expect(fake.pendingCount()).toBe(0);
  sendEvent(queue, " world", 2);
  expect(textInStore()).toBe("Hello world");
  expect(fake.pendingCount()).toBe(0);

  fake.setAppState("active");
  sendEvent(queue, "!", 3);
  expect(textInStore()).toBe("Hello world");
  fake.runScheduled();
  expect(textInStore()).toBe("Hello world!");

  queue.dispose();
  expect(fake.listenerCount()).toBe(0);
  expect(fake.pendingCount()).toBe(0);
});

it("keeps scheduled batching on other platforms while backgrounded", () => {
  const fake = createRuntime(false);
  const queue = createQueue(fake.runtime);

  sendEvent(queue, "Hello", 1);
  fake.setAppState("background");
  sendEvent(queue, " world", 2);
  expect(textInStore()).toBeUndefined();
  expect(fake.pendingCount()).toBe(1);
  expect(fake.listenerCount()).toBe(0);
  fake.runScheduled();
  expect(textInStore()).toBe("Hello world");

  queue.dispose();
});

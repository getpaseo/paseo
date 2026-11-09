import { expect, test } from "vitest";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { createHostBackgroundWorkModel } from "./host";

test("retries a failed observation and receives subsequent updates", async () => {
  interface Observer {
    snapshot(): void;
    update(message: SessionOutboundMessage): void;
    error(error: unknown): void;
  }
  const observers: Observer[] = [];
  let releases = 0;
  const item = {
    id: "shell",
    kind: "shell",
    description: "sleep",
    startedAt: "2026-01-01T00:00:00Z",
  };
  const client = {
    getLastServerInfoMessage: () => ({ features: { agentBackgroundWork: true } }),
    stopAgentBackgroundWork: async () => {},
    listAgentBackgroundWork: async () => [item],
    observeAgentBackgroundWork: () => ({
      subscribe: (observer: Observer) => {
        observers.push(observer);
      },
      release: async () => {
        releases++;
      },
    }),
  };
  const model = createHostBackgroundWorkModel("host", "agent", {
    getClient: () => client,
    subscribe: () => () => {},
  });
  const unsubscribe = model.subscribe(() => {});
  observers[0].snapshot();
  await Promise.resolve();
  await Promise.resolve();
  expect(model.getSnapshot()).toEqual({ status: "ready", items: [item] });
  observers[0].error(new Error("subscription failed"));
  expect(model.getSnapshot()).toEqual({ status: "error", items: [item] });
  model.retry();
  expect(observers).toHaveLength(2);
  expect(releases).toBe(1);
  observers[1].snapshot();
  await Promise.resolve();
  await Promise.resolve();
  expect(model.getSnapshot()).toEqual({ status: "ready", items: [item] });
  observers[0].error(new Error("late error"));
  expect(model.getSnapshot()).toEqual({ status: "ready", items: [item] });
  observers[1].update({
    type: "agent.background_work.update",
    payload: { agentId: "agent", items: [] },
  });
  expect(model.getSnapshot()).toEqual({ status: "ready", items: [] });
  unsubscribe();
});

test("starts observing after the same client reconnects", async () => {
  let connected = false;
  let notify = () => {};
  let snapshot = () => {};
  const item = {
    id: "shell",
    kind: "shell",
    description: "sleep",
    startedAt: "2026-01-01T00:00:00Z",
  };
  const client = {
    getLastServerInfoMessage: () =>
      connected ? { features: { agentBackgroundWork: true } } : null,
    stopAgentBackgroundWork: async () => {},
    listAgentBackgroundWork: async () => [item],
    observeAgentBackgroundWork: () => ({
      subscribe: (observer: { snapshot(): void }) => {
        snapshot = observer.snapshot;
      },
      release: async () => {},
    }),
  };
  const model = createHostBackgroundWorkModel("host", "agent", {
    getClient: () => client,
    subscribe: (listener) => {
      notify = listener;
      return () => {};
    },
  });
  const unsubscribe = model.subscribe(() => {});
  connected = true;
  notify();
  snapshot();
  await Promise.resolve();
  await Promise.resolve();
  expect(model.getSnapshot()).toEqual({ status: "ready", items: [item] });
  unsubscribe();
});

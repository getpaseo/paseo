import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import { describe, expect, it, vi } from "vitest";
import {
  runAttachSession,
  type AttachAgentState,
  type AttachAgentUpdate,
  type AttachSessionClient,
  type AttachSignal,
  type AttachSignalSource,
} from "./attach.js";

const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

class FakeAttachClient implements AttachSessionClient {
  readonly streamListeners = new Set<(agentId: string, event: AgentStreamEventPayload) => void>();
  readonly updateListeners = new Set<(update: AttachAgentUpdate) => void>();
  private readback: AttachAgentState | null | Promise<AttachAgentState | null>;
  private startResult: Promise<void> = Promise.resolve();
  readonly startAgentUpdates = vi.fn(() => this.startResult);
  readonly close = vi.fn(async () => undefined);
  readonly fetchAgent = vi.fn(async () => this.readback);

  constructor(
    readback: AttachAgentState | null | Promise<AttachAgentState | null> = runningAgent(TARGET_ID),
  ) {
    this.readback = readback;
  }

  setReadback(readback: AttachAgentState | null | Promise<AttachAgentState | null>): void {
    this.readback = readback;
  }

  setStartResult(startResult: Promise<void>): void {
    this.startResult = startResult;
  }

  onAgentStream(listener: (agentId: string, event: AgentStreamEventPayload) => void): () => void {
    this.streamListeners.add(listener);
    return () => {
      this.streamListeners.delete(listener);
    };
  }

  onAgentUpdate(listener: Parameters<AttachSessionClient["onAgentUpdate"]>[0]): () => void {
    this.updateListeners.add(listener);
    return () => {
      this.updateListeners.delete(listener);
    };
  }

  emitStream(agentId: string, event: AgentStreamEventPayload): void {
    for (const listener of this.streamListeners) listener(agentId, event);
  }

  emitRemove(agentId: string): void {
    for (const listener of this.updateListeners) listener({ kind: "remove", agentId });
  }

  emitUpsert(agent: AttachAgentState): void {
    for (const listener of this.updateListeners) listener({ kind: "upsert", agent });
  }
}

class FakeSignalSource implements AttachSignalSource {
  private readonly listeners = new Map<AttachSignal, Set<() => void>>([
    ["SIGINT", new Set()],
    ["SIGTERM", new Set()],
  ]);

  on(signal: AttachSignal, listener: () => void): void {
    this.listeners.get(signal)?.add(listener);
  }

  removeListener(signal: AttachSignal, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: AttachSignal): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }

  listenerCount(signal: AttachSignal): number {
    return this.listeners.get(signal)?.size ?? 0;
  }
}

function runningAgent(id: string): AttachAgentState {
  return { id, status: "running", archivedAt: null };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function createSession(
  client: FakeAttachClient,
  signalSource = new FakeSignalSource(),
  fetchTimelineItems = vi.fn(async () => [] as AgentTimelineItem[]),
) {
  const effects = {
    fetchTimelineItems,
    printTimelineItem: vi.fn(),
    printStreamEvent: vi.fn(),
    warnTimeline: vi.fn(),
    printDetach: vi.fn(),
  };
  const promise = runAttachSession({
    agentId: TARGET_ID,
    client,
    signalSource,
    ...effects,
  });
  return { promise, signalSource, ...effects };
}

describe("runAttachSession", () => {
  it("exits when an exact-target terminal is confirmed by authoritative state", async () => {
    const client = new FakeAttachClient();
    const session = createSession(client);
    await vi.waitFor(() => expect(client.fetchAgent).toHaveBeenCalledOnce());
    client.setReadback({ id: TARGET_ID, status: "idle", archivedAt: null });

    client.emitStream(TARGET_ID, { type: "turn_completed", provider: "mock" });

    await session.promise;
    expect(client.fetchAgent).toHaveBeenCalledTimes(2);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["stale", { type: "turn_completed", provider: "mock", turnId: "stale-turn" }],
    [
      "autonomous",
      { type: "turn_failed", provider: "mock", turnId: "autonomous-turn", error: "failed" },
    ],
    [
      "replacement",
      { type: "turn_canceled", provider: "mock", turnId: "replaced-turn", reason: "replace" },
    ],
  ] satisfies Array<[string, AgentStreamEventPayload]>)(
    "stays attached after a %s terminal while authoritative state is running",
    async (_, event) => {
      const client = new FakeAttachClient();
      const session = createSession(client);
      await vi.waitFor(() => expect(client.fetchAgent).toHaveBeenCalledOnce());

      client.emitStream(TARGET_ID, event);
      await vi.waitFor(() => expect(client.fetchAgent).toHaveBeenCalledTimes(2));
      await Promise.resolve();

      expect(client.close).not.toHaveBeenCalled();
      client.emitUpsert({ id: TARGET_ID, status: "idle", archivedAt: null });
      await session.promise;
    },
  );

  it("exits when the exact target is archived", async () => {
    const client = new FakeAttachClient();
    const session = createSession(client);

    client.emitRemove(TARGET_ID);

    await session.promise;
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("exits when the exact target reports a closed state", async () => {
    const client = new FakeAttachClient();
    const session = createSession(client);

    client.emitUpsert({ id: TARGET_ID, status: "closed", archivedAt: null });

    await session.promise;
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("ignores terminal and archive events for unrelated agents", async () => {
    const client = new FakeAttachClient();
    const session = createSession(client);
    let settled = false;
    void session.promise.then(() => {
      settled = true;
      return undefined;
    });

    client.emitStream(OTHER_ID, { type: "turn_completed", provider: "mock" });
    client.emitRemove(OTHER_ID);
    client.emitUpsert({ id: OTHER_ID, status: "closed", archivedAt: null });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(client.close).not.toHaveBeenCalled();

    client.emitUpsert({ id: TARGET_ID, status: "idle", archivedAt: null });
    await session.promise;
  });

  it.each(["SIGINT", "SIGTERM"] satisfies AttachSignal[])(
    "detaches and cleans up on %s",
    async (signal) => {
      const client = new FakeAttachClient();
      const session = createSession(client);

      session.signalSource.emit(signal);

      await session.promise;
      expect(session.printDetach).toHaveBeenCalledOnce();
      expect(client.close).toHaveBeenCalledOnce();
      expect(session.signalSource.listenerCount("SIGINT")).toBe(0);
      expect(session.signalSource.listenerCount("SIGTERM")).toBe(0);
    },
  );

  it("cleans up stream and update listeners after exit", async () => {
    const client = new FakeAttachClient();
    const session = createSession(client);
    await vi.waitFor(() => expect(client.fetchAgent).toHaveBeenCalledOnce());
    client.setReadback({ id: TARGET_ID, status: "error", archivedAt: null });

    client.emitStream(TARGET_ID, { type: "turn_failed", provider: "mock", error: "failed" });

    await session.promise;
    expect(client.streamListeners.size).toBe(0);
    expect(client.updateListeners.size).toBe(0);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("does not wait for a pending subscription bootstrap after exact-target completion", async () => {
    const start = deferred<void>();
    const client = new FakeAttachClient({ id: TARGET_ID, status: "idle", archivedAt: null });
    client.setStartResult(start.promise);
    const session = createSession(client);

    client.emitStream(TARGET_ID, { type: "turn_completed", provider: "mock" });

    await session.promise;
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.streamListeners.size).toBe(0);
    expect(client.updateListeners.size).toBe(0);
  });

  it("does not wait for a pending exact readback after exact-target removal", async () => {
    const readback = deferred<AttachAgentState | null>();
    const client = new FakeAttachClient(readback.promise);
    const session = createSession(client);
    await vi.waitFor(() => expect(client.fetchAgent).toHaveBeenCalledOnce());

    client.emitRemove(TARGET_ID);

    await session.promise;
    expect(client.close).toHaveBeenCalledOnce();
    expect(session.signalSource.listenerCount("SIGINT")).toBe(0);
    expect(session.signalSource.listenerCount("SIGTERM")).toBe(0);
  });

  it("does not wait for pending timeline catch-up after exact-target completion", async () => {
    const timeline = deferred<AgentTimelineItem[]>();
    const fetchTimelineItems = vi.fn(() => timeline.promise);
    const client = new FakeAttachClient();
    const session = createSession(client, new FakeSignalSource(), fetchTimelineItems);
    await vi.waitFor(() => expect(fetchTimelineItems).toHaveBeenCalledOnce());
    client.setReadback({ id: TARGET_ID, status: "idle", archivedAt: null });

    client.emitStream(TARGET_ID, { type: "turn_completed", provider: "mock" });

    await session.promise;
    expect(session.warnTimeline).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("does not warn when SIGINT closes pending timeline catch-up", async () => {
    const timeline = deferred<AgentTimelineItem[]>();
    const fetchTimelineItems = vi.fn(() => timeline.promise);
    const client = new FakeAttachClient();
    const session = createSession(client, new FakeSignalSource(), fetchTimelineItems);
    await vi.waitFor(() => expect(fetchTimelineItems).toHaveBeenCalledOnce());

    session.signalSource.emit("SIGINT");

    await session.promise;
    expect(session.warnTimeline).not.toHaveBeenCalled();
    expect(session.printDetach).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("exits when the exact readback says the target is no longer attachable", async () => {
    const client = new FakeAttachClient({ id: TARGET_ID, status: "closed", archivedAt: null });

    await createSession(client).promise;

    expect(client.startAgentUpdates).toHaveBeenCalledOnce();
    expect(client.fetchAgent).toHaveBeenCalledWith(TARGET_ID);
    expect(client.close).toHaveBeenCalledOnce();
  });
});
